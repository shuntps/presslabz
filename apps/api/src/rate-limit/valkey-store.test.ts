import rateLimit from '@fastify/rate-limit'
import { hasIntegrationEnv } from '@presslabz/db/testing'
import Fastify, { type FastifyInstance } from 'fastify'
import { Valkey } from 'iovalkey'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'
import { createValkeyStore, RateLimitStoreUnavailableError, StoreHealth } from './valkey-store.ts'

/*
 * The plugin's built-in `redis` option is documented as requiring ioredis.
 * This project runs iovalkey, so it uses the plugin's public `store`
 * extension point instead and brings its own adapter — which means the Lua,
 * the atomicity and the failure behaviour are ours to prove, not something
 * inherited from a compatibility nobody maintains.
 */
const ready = hasIntegrationEnv()
const VALKEY_URL = process.env.VALKEY_URL ?? 'redis://localhost:6379'

/** Somewhere unlikely to be listening. */
const DEAD_URL = 'redis://127.0.0.1:6399'

function silentLog() {
  const lines: { level: 'warn'; payload: unknown; msg: string }[] = []
  return {
    lines,
    warn: (payload: unknown, msg?: string) => {
      lines.push({ level: 'warn', payload, msg: msg ?? '' })
    },
  }
}

function liveClient() {
  const client = new Valkey(VALKEY_URL, { maxRetriesPerRequest: 1 })
  client.on('error', () => {})
  return client
}

/** The settings the application uses, aimed at somewhere with nobody home. */
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

describe.skipIf(!ready)('the Valkey rate limit store', () => {
  const namespaces: string[] = []
  const clients: Valkey[] = []
  const apps: FastifyInstance[] = []

  const namespace = (label: string) => {
    const value = testRateLimitNamespace(label)
    namespaces.push(value)
    return value
  }

  const track = <T extends Valkey>(client: T) => {
    clients.push(client)
    return client
  }

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close()
    for (const client of clients.splice(0)) client.disconnect()
  })

  afterAll(async () => {
    // Every key this file created, and nothing else. Never FLUSHDB.
    for (const value of namespaces) await dropRateLimitKeys(VALKEY_URL, value)
  })

  async function serve(options: {
    prefix: string
    client: Valkey
    max?: number
    log?: ReturnType<typeof silentLog>
  }) {
    const log = options.log ?? silentLog()
    const health = new StoreHealth(log)

    const app = Fastify({ logger: false })
    await app.register(rateLimit, {
      max: options.max ?? 3,
      timeWindow: '10 seconds',
      store: createValkeyStore({ valkey: options.client, namespace: options.prefix, health }),
      keyGenerator: (request) => request.ip,
      // The application's global posture: keep serving if the store is gone.
      skipOnError: true,
    })
    app.get('/open', async () => ({ ok: true }))
    app.get('/other', async () => ({ ok: true }))
    app.post(
      '/login',
      // The one route that refuses instead of degrading.
      { config: { rateLimit: { max: 3, timeWindow: '10 seconds', skipOnError: false } } },
      async () => ({ ok: true }),
    )
    await app.ready()
    apps.push(app)

    return { app, health, log }
  }

  describe('counting', () => {
    it('increments atomically and expires the window', async () => {
      const { app } = await serve({ prefix: namespace('count'), client: track(liveClient()) })

      const codes: number[] = []
      for (let i = 0; i < 5; i++) {
        codes.push((await app.inject({ url: '/open', remoteAddress: '198.51.100.1' })).statusCode)
      }
      expect(codes).toEqual([200, 200, 200, 429, 429])
    })

    it('sets a time to live, so a window actually ends', async () => {
      const prefix = namespace('ttl')
      const client = track(liveClient())
      const { app } = await serve({ prefix, client })

      await app.inject({ url: '/open', remoteAddress: '198.51.100.2' })

      const [key] = await client.keys(`${prefix}*`)
      expect(key).toBeDefined()
      const ttl = await client.pttl(key as string)
      expect(ttl).toBeGreaterThan(0)
      expect(ttl).toBeLessThanOrEqual(10_000)
    })

    it('gives a route with its own limit its own counter', async () => {
      /*
       * child() is what separates them, and the plugin calls it only for a
       * route that declares its own rateLimit — everything else shares the
       * global counter, which is what "global" means. So the property is that
       * exhausting the global allowance does not spend the login one.
       */
      const { app } = await serve({ prefix: namespace('child'), client: track(liveClient()) })
      const from = '198.51.100.3'

      for (let i = 0; i < 3; i++) await app.inject({ url: '/open', remoteAddress: from })
      expect((await app.inject({ url: '/open', remoteAddress: from })).statusCode).toBe(429)
      // The global counter is spent; a sibling route without its own config
      // shares it, by design.
      expect((await app.inject({ url: '/other', remoteAddress: from })).statusCode).toBe(429)

      // The route that declares its own limit still has its full allowance.
      expect(
        (await app.inject({ method: 'POST', url: '/login', remoteAddress: from })).statusCode,
      ).toBe(200)
    })

    it('keeps two namespaces apart', async () => {
      const client = track(liveClient())
      const first = await serve({ prefix: namespace('ns-a'), client })
      const second = await serve({ prefix: namespace('ns-b'), client: track(liveClient()) })
      const from = '198.51.100.4'

      for (let i = 0; i < 4; i++) await first.app.inject({ url: '/open', remoteAddress: from })
      expect((await first.app.inject({ url: '/open', remoteAddress: from })).statusCode).toBe(429)
      expect((await second.app.inject({ url: '/open', remoteAddress: from })).statusCode).toBe(200)
    })
  })

  describe('two instances, one quota', () => {
    it('shares the count rather than granting it twice', async () => {
      /*
       * In memory this is what a load balancer turns into N × max: every
       * instance hands out the full allowance, and the login limit of ten
       * becomes ten per process.
       */
      const prefix = namespace('shared')
      const a = await serve({ prefix, client: track(liveClient()), max: 3 })
      const b = await serve({ prefix, client: track(liveClient()), max: 3 })
      const from = '198.51.100.5'

      const codes = [
        (await a.app.inject({ url: '/open', remoteAddress: from })).statusCode,
        (await b.app.inject({ url: '/open', remoteAddress: from })).statusCode,
        (await a.app.inject({ url: '/open', remoteAddress: from })).statusCode,
        (await b.app.inject({ url: '/open', remoteAddress: from })).statusCode,
      ]

      expect(codes).toEqual([200, 200, 200, 429])
    })
  })

  describe('two applications built at the same time', () => {
    it('binds each to its own client, namespace and health state', async () => {
      /*
       * The store used to read a module-level "last configuration wins"
       * handle, because the plugin constructs the store itself and there was
       * no other way in. Two applications built concurrently in one process
       * then shared whichever configured last: measured, one application's
       * counters landed under the other's namespace, against the other's
       * client, with no error anywhere.
       *
       * Here the second build is the one that would have won, and it is the
       * one whose client is unreachable. Under the old handle the live
       * application counted nothing and degraded the wrong health state.
       */
      const liveNamespace = namespace('bound-live')
      const deadNamespace = namespace('bound-dead')

      const build = async (prefix: string, client: Valkey, pauseMs: number) => {
        const log = silentLog()
        const health = new StoreHealth(log)
        const Store = createValkeyStore({ valkey: client, namespace: prefix, health })

        // A gap between building the store and registering it, so the two
        // builds genuinely interleave rather than running one after the other.
        await new Promise((resolve) => setTimeout(resolve, pauseMs))

        const app = Fastify({ logger: false })
        await app.register(rateLimit, {
          max: 3,
          timeWindow: '10 seconds',
          store: Store,
          keyGenerator: (request) => request.ip,
          // The global posture, so an unreachable store shows up in the health
          // state and the keys rather than in the status code.
          skipOnError: true,
        })
        app.get('/open', async () => ({ ok: true }))
        await app.ready()
        apps.push(app)

        return { app, health }
      }

      const liveValkey = track(liveClient())
      const [live, dead] = await Promise.all([
        build(liveNamespace, liveValkey, 30),
        build(deadNamespace, track(deadClient()), 5),
      ])

      expect(
        (await live.app.inject({ url: '/open', remoteAddress: '198.51.100.11' })).statusCode,
      ).toBe(200)
      // Fails open, as the global posture says it must.
      expect(
        (await dead.app.inject({ url: '/open', remoteAddress: '198.51.100.12' })).statusCode,
      ).toBe(200)

      expect(await liveValkey.keys(`${liveNamespace}*`)).toEqual([`${liveNamespace}198.51.100.11`])
      // Nothing of the live application's traffic reached the other namespace,
      // and nothing of the dead one's was counted at all.
      expect(await liveValkey.keys(`${deadNamespace}*`)).toEqual([])

      expect(live.health.degraded).toBe(false)
      expect(dead.health.degraded).toBe(true)
    })
  })

  describe('when Valkey is unreachable', () => {
    it('fails fast rather than waiting out a connection', async () => {
      /*
       * With iovalkey's defaults a single command against an unreachable
       * server took ten to forty seconds to give up. skipOnError would never
       * have had the chance, and "fail open" would have been an outage.
       */
      const { app } = await serve({ prefix: namespace('fast'), client: track(deadClient()) })

      const started = Date.now()
      const response = await app.inject({ url: '/open', remoteAddress: '198.51.100.6' })
      const elapsed = Date.now() - started

      expect(response.statusCode).toBe(200)
      expect(elapsed).toBeLessThan(1_000)
    })

    it('keeps serving the routes that fail open', async () => {
      const { app } = await serve({ prefix: namespace('open'), client: track(deadClient()) })

      for (let i = 0; i < 5; i++) {
        expect((await app.inject({ url: '/open', remoteAddress: '198.51.100.7' })).statusCode).toBe(
          200,
        )
      }
    })

    it('refuses the login route, and says nothing about Valkey', async () => {
      /*
       * The count is the protection here. Opening it during a store failure
       * hands an attacker the window they would arrange on purpose. Sessions
       * live in Postgres, so what stops is signing in, not being signed in.
       */
      const { app } = await serve({ prefix: namespace('closed'), client: track(deadClient()) })

      const response = await app.inject({
        method: 'POST',
        url: '/login',
        remoteAddress: '198.51.100.8',
      })

      expect(response.statusCode).toBe(503)
      expect(response.body).not.toContain('Stream')
      expect(response.body).not.toContain('enableOfflineQueue')
      expect(response.body).not.toContain('6399')
    })
  })

  describe('what gets logged', () => {
    it('writes one line when it breaks and one when it comes back', async () => {
      /*
       * The plugin swallows store errors when skipOnError is true, so nothing
       * is logged unless the store logs it — and a line per request would
       * write one per request for the whole outage.
       */
      const log = silentLog()
      const health = new StoreHealth(log)

      for (let i = 0; i < 25; i++) health.recordFailure(new Error('down'))
      expect(log.lines).toHaveLength(1)
      expect(log.lines[0]?.msg).toContain('unavailable')

      health.recordSuccess()
      expect(log.lines).toHaveLength(2)
      expect(log.lines[1]?.msg).toContain('recovered')
      expect(log.lines[1]?.payload).toEqual({ suppressed: 24 })

      // A second recovery with nothing broken in between says nothing.
      health.recordSuccess()
      expect(log.lines).toHaveLength(2)
    })

    it('reports the transition again after a second outage', async () => {
      const log = silentLog()
      const health = new StoreHealth(log)

      health.recordFailure(new Error('down'))
      health.recordSuccess()
      health.recordFailure(new Error('down again'))
      health.recordSuccess()

      expect(log.lines.map((line) => line.msg)).toEqual([
        expect.stringContaining('unavailable'),
        expect.stringContaining('recovered'),
        expect.stringContaining('unavailable'),
        expect.stringContaining('recovered'),
      ])
    })

    it('does not let iovalkey print raw stacks past the logger', async () => {
      /*
       * Without an `error` listener iovalkey writes the stack to console.error
       * directly — outside pino, outside its level, outside redaction — once
       * per emission. With a persistent retry strategy that is a storm.
       */
      const written: unknown[] = []
      const original = console.error
      console.error = (...args: unknown[]) => {
        written.push(args)
      }

      try {
        const { app } = await serve({ prefix: namespace('quiet'), client: track(deadClient()) })
        for (let i = 0; i < 6; i++) {
          await app.inject({ url: '/open', remoteAddress: '198.51.100.9' })
        }
        await new Promise((resolve) => setTimeout(resolve, 400))
      } finally {
        console.error = original
      }

      const raw = JSON.stringify(written)
      expect(raw).not.toContain('Unhandled error event')
    })
  })

  describe('failures the callers see', () => {
    it('reports a store failure as its own error, carrying 503', async () => {
      const health = new StoreHealth(silentLog())
      const client = track(deadClient())
      const Store = createValkeyStore({ valkey: client, namespace: namespace('errors'), health })

      const store = new Store()
      const error = await new Promise<Error | null>((resolve) => {
        store.incr('198.51.100.10', (err) => resolve(err), 10_000)
      })

      expect(error).toBeInstanceOf(RateLimitStoreUnavailableError)
      expect((error as { statusCode?: number }).statusCode).toBe(503)
      expect(error?.message).toBe('Rate limit store unavailable')
    })
  })

  describe('shutting down', () => {
    it('stops trying once disconnected, so nothing keeps the loop alive', async () => {
      /*
       * Left open, the reconnection timer keeps the process alive
       * indefinitely; quit() on a client with no connection never returns, so
       * it would hang shutdown exactly when Valkey is unreachable. disconnect()
       * is what the application calls, and what this asserts.
       *
       * The observable is the retrying, not `status`: a client disconnected
       * mid-reconnect keeps reporting "reconnecting" while in fact making no
       * further attempts, so asserting the status would be asserting a label.
       */
      const client = new Valkey(DEAD_URL, {
        lazyConnect: true,
        connectTimeout: 200,
        commandTimeout: 200,
        maxRetriesPerRequest: 0,
        retryStrategy: () => 100,
      })
      let attempts = 0
      client.on('error', () => {
        attempts++
      })

      await client.get('anything').catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(attempts).toBeGreaterThan(0)

      client.disconnect()
      const afterDisconnect = attempts
      await new Promise((resolve) => setTimeout(resolve, 700))

      expect(attempts).toBe(afterDisconnect)
    })
  })
})
