import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * Cross-cutting configuration, tested because none of it shows up in a route
 * test. Both of the failures below reached the browser and nothing else:
 * app.inject() performs no preflight, and curl sends no content-type unless
 * told to, so a route suite and a shell session can agree the API works while
 * the admin cannot call it at all.
 */
if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname)
  } catch {
    // Skipped below rather than failed.
  }
}

const ready = Boolean(process.env.DATABASE_URL && process.env.VALKEY_URL)

describe.skipIf(!ready)('app configuration', () => {
  let app: FastifyInstance
  let origin: string

  beforeAll(async () => {
    const [{ buildApp }, { env }] = await Promise.all([import('./app.ts'), import('./env.ts')])
    origin = env.ADMIN_ORIGIN
    app = await buildApp()
    await app.ready()
  })

  afterAll(async () => {
    await app.close()
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
  })

  describe('request bodies', () => {
    /**
     * A client that says JSON and sends nothing is a normal client — fetch
     * does it whenever a caller sets the header once for every request. Sign
     * out did exactly this and got a 400 nobody could see from the server.
     */
    it('treats an empty JSON body as no body rather than a bad request', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        headers: { 'content-type': 'application/json' },
        payload: '',
      })

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
