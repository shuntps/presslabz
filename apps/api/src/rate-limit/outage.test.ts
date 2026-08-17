import cookie from '@fastify/cookie'
import rateLimit, { normalizeIP } from '@fastify/rate-limit'
import { createDb } from '@presslabz/db'
import { hasIntegrationEnv } from '@presslabz/db/testing'
import Fastify from 'fastify'
import { Valkey } from 'iovalkey'
import { describe, expect, it } from 'vitest'
import authPlugin from '../auth/plugin.ts'
import { authRoutes } from '../auth/routes.ts'
import clientIpPlugin from '../http/client-ip.ts'
import { registerErrorHandling } from '../http/errors.ts'
import { createValkeyStore, StoreHealth } from './valkey-store.ts'

/*
 * What an operator sees while the rate-limit store is down.
 *
 * `/auth/login` fails closed, so every attempt raises the store's error, and
 * every one of them used to be logged twice: once by the store, as a bounded
 * transition, and once more by the generic 5xx handler, with a full stack.
 * Measured, twenty-five attempts during one outage wrote one transition line
 * and twenty-five stacks — the same failure, seen from the same place, once
 * per request for as long as the outage lasts.
 */

const DEAD_URL = 'redis://127.0.0.1:6399'
const ATTEMPTS = 25

function capture() {
  const lines: Record<string, unknown>[] = []
  return {
    lines,
    stream: {
      write: (line: string) => {
        lines.push(JSON.parse(line))
      },
    },
  }
}

/** The application's own settings, aimed at a port with nobody home. */
function deadClient() {
  const client = new Valkey(DEAD_URL, {
    lazyConnect: true,
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  })
  client.on('error', () => {})
  return client
}

describe.skipIf(!hasIntegrationEnv())('signing in while the store is unreachable', () => {
  async function serve() {
    const log = capture()
    const app = Fastify({ logger: { level: 'warn', stream: log.stream } })
    registerErrorHandling(app)

    const health = new StoreHealth(app.log)
    const client = deadClient()
    client.on('error', (error) => health.recordFailure(error))

    await app.register(clientIpPlugin, { source: 'socket', trustedProxies: [] })
    await app.register(rateLimit, {
      max: 300,
      timeWindow: '1 minute',
      // A fixed namespace: the client never connects, so no key is ever
      // written and there is nothing to clean up afterwards.
      store: createValkeyStore({ valkey: client, namespace: 'presslabz:rl:test:outage:', health }),
      keyGenerator: (request) => normalizeIP(request.clientIp, 64),
      // The global posture. /auth/login overrides it, which is why it is the
      // route that raises anything at all here.
      skipOnError: true,
    })

    const { db, close } = createDb(process.env.DATABASE_URL as string)
    await app.register(cookie)
    await app.register(authPlugin, { db, isProduction: false })
    await app.register(authRoutes, { db, isProduction: false })
    // Something that fails for an ordinary reason, to show what is still logged.
    app.get('/boom', async () => {
      throw new Error('an ordinary failure with a secret in it: hunter2')
    })
    await app.ready()

    return {
      app,
      lines: log.lines,
      close: async () => {
        await app.close()
        client.disconnect()
        await close()
      },
    }
  }

  it('answers every attempt with a generic 503 and logs the outage once', {
    timeout: 30_000,
  }, async () => {
    const { app, lines, close } = await serve()

    try {
      const responses = await Promise.all(
        Array.from({ length: ATTEMPTS }, () =>
          app.inject({
            method: 'POST',
            url: '/auth/login',
            remoteAddress: '198.51.100.20',
            payload: { email: 'nobody@presslabz.test', password: 'a-long-enough-passphrase' },
          }),
        ),
      )

      for (const response of responses) {
        expect(response.statusCode).toBe(503)
        expect(response.json()).toEqual({
          statusCode: 503,
          error: 'unavailable',
          requestId: expect.any(String),
        })
        // Nothing about the store crosses the boundary either.
        expect(response.body).not.toContain('Stream')
        expect(response.body).not.toContain('enableOfflineQueue')
        expect(response.body).not.toContain('6399')
      }

      // Bounded by the transitions, not by the traffic: one line for an
      // outage that refused twenty-five attempts.
      expect(lines).toHaveLength(1)
      expect(lines[0]?.msg).toContain('rate limit store unavailable')
      expect(lines.filter((line) => line.msg === 'request failed')).toHaveLength(0)
    } finally {
      await close()
    }
  })

  it('still logs every other 5xx in full', async () => {
    /*
     * The suppression is for one error class, whose own logging is bounded and
     * complete. Silencing the generic handler itself would trade a storm for a
     * blackout.
     */
    const { app, lines, close } = await serve()

    try {
      const response = await app.inject({ url: '/boom', remoteAddress: '198.51.100.21' })

      expect(response.statusCode).toBe(500)
      const failures = lines.filter((line) => line.msg === 'request failed')
      expect(failures).toHaveLength(1)
      expect(JSON.stringify(failures[0])).toContain('an ordinary failure')
      expect(failures[0]?.route).toBe('/boom')
    } finally {
      await close()
    }
  })
})
