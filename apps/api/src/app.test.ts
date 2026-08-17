import { hasIntegrationEnv } from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Cross-cutting configuration, tested because none of it shows up in a route
 * test. Both of the failures below reached the browser and nothing else:
 * app.inject() performs no preflight, and curl sends no content-type unless
 * told to, so a route suite and a shell session can agree the API works while
 * the admin cannot call it at all.
 */
const ready = hasIntegrationEnv()

describe.skipIf(!ready)('app configuration', () => {
  let app: FastifyInstance
  let origin: string
  let namespace: string

  beforeAll(async () => {
    const [{ buildApp }, { env }, { testRateLimitNamespace }] = await Promise.all([
      import('./app.ts'),
      import('./env.ts'),
      import('./testing.ts'),
    ])
    // ADMIN_ORIGIN is a list now; the first entry is the one an installation
    // configures when it has only one admin name, which is the usual case.
    origin = env.ADMIN_ORIGIN[0] as string
    // Its own rate-limit prefix: the counters are in Valkey now, so a suite
    // sharing the configured one would spend the real quota.
    namespace = testRateLimitNamespace('app')
    app = await buildApp({ rateLimitNamespace: namespace })
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
    const [{ dropRateLimitKeys }, { env }] = await Promise.all([
      import('./testing.ts'),
      import('./env.ts'),
    ])
    await dropRateLimitKeys(env.VALKEY_URL, namespace)
  })

  describe('CORS', () => {
    /**
     * @fastify/cors defaults to GET, HEAD and POST. Every PATCH and DELETE
     * this API serves was refused by the browser before it left the page,
     * while every test and every curl call sailed through.
     */
    it('allows the methods the API actually serves', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/auth/preferences',
        headers: { origin, 'access-control-request-method': 'PATCH' },
      })

      const allowed = (response.headers['access-control-allow-methods'] as string)
        .split(',')
        .map((method) => method.trim())

      expect(allowed).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE']))
    })

    it('still answers only to the admin origin', async () => {
      const response = await app.inject({
        method: 'OPTIONS',
        url: '/auth/preferences',
        headers: { origin: 'https://elsewhere.example', 'access-control-request-method': 'PATCH' },
      })

      expect(response.headers['access-control-allow-origin']).not.toBe('https://elsewhere.example')
      expect(response.headers['access-control-allow-origin']).not.toBe('*')
    })

    it('answers the configured origin with itself and with credentials', async () => {
      /*
       * The end the browser actually sees, on the app as built rather than on
       * the options object: an exact origin, credentials allowed, no wildcard.
       * A wildcard would be a different failure — browsers refuse it outright
       * for a credentialed request, so the session cookie would simply stop
       * being sent.
       */
      const response = await app.inject({ url: '/health', headers: { origin } })

      expect(response.headers['access-control-allow-origin']).toBe(origin)
      expect(response.headers['access-control-allow-origin']).not.toBe('*')
      expect(response.headers['access-control-allow-credentials']).toBe('true')
    })
  })

  describe('health', () => {
    it('answers 200 and ok when every dependency answers', async () => {
      const response = await app.inject({ url: '/health' })

      expect(response.statusCode).toBe(200)
      expect(response.json()).toEqual({
        status: 'ok',
        services: { database: 'up', cache: 'up', rateLimit: 'up' },
      })
    })

    it('answers 503 and degraded when only the rate limit store is gone', async () => {
      /*
       * The state that used to answer 200 with `status: ok` and a `degraded`
       * line buried in the body. It is not a footnote: /auth/login fails
       * closed while the store is unreachable, so this instance cannot
       * authenticate anybody, and a load balancer reading 200 keeps sending it
       * the traffic it cannot serve.
       *
       * The limiter's client alone is pointed at a port with nobody home —
       * stopping Valkey would take the cache probe down with it and prove
       * nothing about the difference.
       */
      const [{ buildApp }, { testRateLimitNamespace }] = await Promise.all([
        import('./app.ts'),
        import('./testing.ts'),
      ])

      const degraded = await buildApp({
        rateLimitNamespace: testRateLimitNamespace('health-degraded'),
        rateLimitValkeyUrl: 'redis://127.0.0.1:6399',
      })
      await degraded.ready()

      try {
        const response = await degraded.inject({ url: '/health' })

        expect(response.statusCode).toBe(503)
        expect(response.json()).toEqual({
          status: 'degraded',
          services: { database: 'up', cache: 'up', rateLimit: 'degraded' },
        })
      } finally {
        await degraded.close()
      }
    })

    it('is rate limited like every other route', async () => {
      /*
       * It reaches PostgreSQL and Valkey, so leaving it unmetered would be an
       * unlimited way to make the API work. The single-flight probe bounds
       * what concurrent calls cost, not what sequential ones do.
       */
      const response = await app.inject({ url: '/health' })
      expect(response.headers['x-ratelimit-limit']).toBeDefined()
    })
  })

  describe('request bodies', () => {
    /**
     * Fastify 5 refuses this deliberately, and the tolerance that used to sit
     * here is no longer earning its cost. It existed because sign out
     * announced JSON and sent nothing; the admin's apiFetch now names the
     * content type only for a body it serialised, so nothing produces this
     * shape. Keeping the exception meant replacing Fastify's parser, and the
     * replacement had quietly dropped its prototype-poisoning protections.
     */
    it('refuses a body that claims to be JSON and is empty', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { 'content-type': 'application/json' },
        payload: '',
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().code).toBe('FST_ERR_CTP_EMPTY_JSON_BODY')
    })

    /** What the admin actually sends when it has no body: no content type. */
    it('accepts a request with no body and no content type', async () => {
      const response = await app.inject({ method: 'POST', url: '/auth/logout' })
      expect(response.statusCode).not.toBe(400)
    })

    it('still refuses a body that claims to be JSON and is not', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'content-type': 'application/json' },
        payload: '{ not json',
      })

      expect(response.statusCode).toBe(400)
    })
  })
})
