import net from 'node:net'
import { hasIntegrationEnv } from '@presslabz/db/testing'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'

/*
 * The stalls a directly reachable API has to survive, and the legitimate
 * traffic it must not mistake for one.
 *
 * Values here are small so the file runs in seconds; the shapes are the same
 * ones the configured timeouts address. Node enforces requestTimeout on a
 * sweep whose period is connectionsCheckingInterval — 30 seconds by default —
 * so the harness shortens it, exactly as Fastify's own timeout tests do.
 * Without that, a two-second timeout is applied up to half a minute late and
 * the test would be measuring the sweep.
 */

const SWEEP = { connectionsCheckingInterval: 200 }

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

interface Attempt {
  firstLine: string
  closed: boolean
  elapsed: number
}

async function speak(
  port: number,
  write: (socket: net.Socket) => void | Promise<void>,
  windowMs = 6_000,
): Promise<Attempt> {
  const started = Date.now()

  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => void write(socket))
    let answered = ''

    const finish = (closed: boolean) =>
      resolve({
        firstLine: answered.split('\r\n')[0] ?? '',
        closed,
        elapsed: Date.now() - started,
      })

    socket.on('data', (chunk) => {
      answered += chunk.toString()
      if (answered.includes('\r\n\r\n')) {
        socket.destroy()
        finish(false)
      }
    })
    socket.on('close', () => finish(true))
    socket.on('error', () => finish(true))
    setTimeout(() => {
      socket.destroy()
      finish(false)
    }, windowMs)
  })
}

async function listen(options: Record<string, unknown>) {
  const instance = Fastify({ logger: false, ...options })
  instance.post('/upload', async (request) => ({ received: String(request.body ?? '').length }))
  // Port 0: the system picks a free one. A fixed range collides the moment two
  // test files run at once, and the failure looks like a timeout bug.
  await instance.listen({ host: '127.0.0.1', port: 0 })
  app = instance

  const address = instance.server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  return address.port
}

describe('stalls that must not hold a connection', () => {
  it('answers 408 when the headers never end', async () => {
    const port = await listen({ requestTimeout: 1_000, http: SWEEP })

    const attempt = await speak(port, (socket) => {
      socket.write('POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1\r\n')
    })

    expect(attempt.firstLine).toContain('408')
    expect(attempt.elapsed).toBeLessThan(5_000)
  })

  it('answers 408 when a connection says nothing at all', async () => {
    const port = await listen({ requestTimeout: 1_000, http: SWEEP })
    const attempt = await speak(port, () => {})

    expect(attempt.firstLine).toContain('408')
  })

  it('closes a socket that stops sending mid-body', async () => {
    /*
     * requestTimeout does not cover this one — measured on this Node version,
     * a body that has started arriving is not reaped by it. Socket inactivity
     * is what closes it.
     */
    const port = await listen({ connectionTimeout: 800, http: SWEEP })

    const attempt = await speak(port, (socket) => {
      socket.write(
        'POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: 100\r\n\r\n',
      )
      socket.write('partial')
    })

    expect(attempt.closed).toBe(true)
    expect(attempt.elapsed).toBeLessThan(4_000)
  })
})

describe('legitimate traffic the timeouts must not kill', () => {
  it('accepts a request that arrives promptly', async () => {
    const port = await listen({ requestTimeout: 2_000, connectionTimeout: 2_000, http: SWEEP })

    const body = 'x'.repeat(500)
    const attempt = await speak(port, (socket) => {
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      )
    })

    expect(attempt.firstLine).toContain('200')
  })

  it('accepts a large body sent in pieces, as a slow client sends one', async () => {
    /*
     * The test that stops the timeouts being "fixed" by making them tight
     * enough to break the media library: an upload arriving in chunks takes
     * far longer than the socket idle timeout in total, and must still land
     * because each chunk resets the inactivity.
     */
    const port = await listen({ connectionTimeout: 400, requestTimeout: 5_000, http: SWEEP })

    const body = 'y'.repeat(2_000)
    const chunkSize = 200
    const attempt = await speak(port, async (socket) => {
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n`,
      )
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        if (socket.destroyed) return
        socket.write(body.slice(offset, offset + chunkSize))
        // Well inside the idle timeout, and ten of them well past it.
        await new Promise((resolve) => setTimeout(resolve, 120))
      }
    })

    expect(attempt.firstLine).toContain('200')
    expect(attempt.elapsed).toBeGreaterThan(400)
  })

  it('refuses a body larger than the limit rather than reading it all', async () => {
    const port = await listen({ bodyLimit: 1_024, requestTimeout: 3_000, http: SWEEP })

    const body = 'z'.repeat(4_096)
    const attempt = await speak(port, (socket) => {
      socket.write(
        `POST /upload HTTP/1.1\r\nHost: localhost\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      )
    })

    expect(attempt.firstLine).toContain('413')
  })
})

describe('the application timeout, and why it is off by default', () => {
  it('leaves a slow handler alone when it is zero', async () => {
    const instance = Fastify({ logger: false, handlerTimeout: 0 })
    instance.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
      return { ok: true }
    })
    await instance.ready()
    app = instance

    expect((await instance.inject({ url: '/slow' })).statusCode).toBe(200)
  })

  it('answers 503 while the work it meant to stop runs to completion', async () => {
    /*
     * Measured, and the whole reason the default is off: Fastify's handler
     * timeout is cooperative. It answers 503 and aborts request.signal, but
     * nothing in this codebase observes that signal, so the handler carries on
     * and its write lands anyway — the client is told the service is
     * unavailable for an operation that in fact completed.
     *
     * The value is still accepted from an operator: this is a trade-off to
     * make, not a setting to forbid. What must not happen is claiming it
     * cancels anything.
     */
    const completed: string[] = []
    const instance = Fastify({ logger: false, handlerTimeout: 150 })
    instance.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, 500))
      completed.push('the write the 503 was meant to prevent')
      return { ok: true }
    })
    await instance.ready()
    app = instance

    const response = await instance.inject({ url: '/slow' })
    expect(response.statusCode).toBe(503)
    expect(completed).toEqual([])

    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(completed).toEqual(['the write the 503 was meant to prevent'])
  })
})

/*
 * The behaviour above is exercised with small values; this is what proves the
 * configured ones actually reach the server the application builds.
 */
describe.skipIf(!hasIntegrationEnv())('the application applies its configured limits', () => {
  it('passes every timeout through to the server', async () => {
    const [{ buildApp }, { env }, { testRateLimitNamespace }] = await Promise.all([
      import('../app.ts'),
      import('../env.ts'),
      import('../testing.ts'),
    ])

    const built = await buildApp({ rateLimitNamespace: testRateLimitNamespace('boundaries') })
    await built.ready()

    try {
      /*
       * Asserted on the Node server rather than Fastify's initialConfig:
       * the published type for that object omits requestTimeout and
       * handlerTimeout although the runtime carries both, so reading it would
       * mean casting away the very thing being checked.
       */
      expect(built.server.timeout).toBe(env.HTTP_SOCKET_IDLE_TIMEOUT_MS)
      expect(built.server.requestTimeout).toBe(env.HTTP_REQUEST_TIMEOUT_MS)
      expect(built.server.headersTimeout).toBe(env.HTTP_HEADERS_TIMEOUT_MS)
      expect(built.initialConfig.connectionTimeout).toBe(env.HTTP_SOCKET_IDLE_TIMEOUT_MS)
      /*
       * Compared against whatever the environment holds, never against zero.
       * A positive value is a configuration the server supports, so a suite
       * that demanded the default would fail on it — the default itself is
       * pinned where it is decided, in the schema's own tests.
       *
       * Fastify carries this one on initialConfig at runtime while its
       * published type omits it, hence the narrow read rather than a cast of
       * the whole object.
       */
      const applied = built.initialConfig as { handlerTimeout?: number }
      expect(applied.handlerTimeout).toBe(env.HTTP_HANDLER_TIMEOUT_MS)
    } finally {
      await built.close()
    }
  })

  it('does not hand a rotating IPv6 address a fresh allowance either', async () => {
    /*
     * A single IPv6 allocation supplies an endless number of addresses, so a
     * key built from the full address is a key an attacker can rotate for
     * free. The limiter groups by prefix; this fails the moment the key
     * generator hands it the whole address instead.
     */
    const [{ buildApp }, { env }, { testRateLimitNamespace, dropRateLimitKeys }] =
      await Promise.all([import('../app.ts'), import('../env.ts'), import('../testing.ts')])

    const namespace = testRateLimitNamespace('ipv6')
    const built = await buildApp({ rateLimitNamespace: namespace })
    await built.ready()

    try {
      const codes: number[] = []
      for (let attempt = 0; attempt < 12; attempt++) {
        // Twelve addresses, one /64.
        const response = await built.inject({
          method: 'POST',
          url: '/auth/login',
          remoteAddress: `2001:db8:1:1::${attempt + 1}`,
          payload: { email: 'nobody@presslabz.test', password: 'a-long-enough-passphrase' },
        })
        codes.push(response.statusCode)
      }

      expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0)
    } finally {
      await built.close()
      await dropRateLimitKeys(env.VALKEY_URL, namespace)
    }
  })

  it('does not hand a rotating header a fresh allowance', async () => {
    /*
     * The acceptance criterion, end to end. With trustProxy: true a direct
     * client set X-Forwarded-For and took a new bucket with every value —
     * measured before the fix, ten login attempts per forged address with no
     * limit on addresses. Fastify's own config does not expose trustProxy, so
     * the assertion is the behaviour rather than the setting.
     */
    const [{ buildApp }, { env }, { testRateLimitNamespace, dropRateLimitKeys }] =
      await Promise.all([import('../app.ts'), import('../env.ts'), import('../testing.ts')])

    const namespace = testRateLimitNamespace('rotation')
    const built = await buildApp({ rateLimitNamespace: namespace })
    await built.ready()

    try {
      const codes: number[] = []
      for (let attempt = 0; attempt < 12; attempt++) {
        const response = await built.inject({
          method: 'POST',
          url: '/auth/login',
          // A different forged address every time.
          headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` },
          payload: { email: 'nobody@presslabz.test', password: 'a-long-enough-passphrase' },
        })
        codes.push(response.statusCode)
      }

      // The login limit is 10 per window, and it is reached despite the
      // rotation: every request counted against the same real peer.
      expect(codes.filter((code) => code === 429).length).toBeGreaterThan(0)

      /*
       * And the refusal still says what it is. The limiter's error carries no
       * code of its own, so the boundary cannot tell it from a dependency that
       * happens to throw a 4xx — which is redacted. app.ts builds it through
       * the plugin's errorResponseBuilder for exactly that reason, and this is
       * where the built application proves it.
       */
      const refused = await built.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@presslabz.test', password: 'a-long-enough-passphrase' },
      })

      expect(refused.statusCode).toBe(429)
      expect(refused.json().message).toContain('Rate limit exceeded')
      expect(refused.headers['retry-after']).toBeDefined()
    } finally {
      await built.close()
      await dropRateLimitKeys(env.VALKEY_URL, namespace)
    }
  })
})
