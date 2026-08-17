import cors from '@fastify/cors'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { corsOptions } from './cors.ts'

/*
 * Reproduced in a browser before this existed: the admin open on
 * http://127.0.0.1:5173, the API called on http://localhost:3000, and
 * ADMIN_ORIGIN allowing http://localhost:5173. The browser blocked the answer
 * to GET /auth/me, so apiFetch saw a network failure instead of a 401,
 * useSession could not turn that into "signed out", and the interface showed a
 * breakage where the sign-in form belonged.
 *
 * The lesson is not "allow more origins". CORS compares scheme, host and port,
 * so one host under two names is two origins; and the session cookie is
 * SameSite=Lax, so a cross-site fetch from 127.0.0.1 to localhost would not
 * carry it even if CORS allowed it. An installation picks one name and uses it
 * end to end. What is asserted here is that either choice works, and that
 * nothing else does.
 */

const LOCALHOST = 'http://localhost:5173'
const LOOPBACK = 'http://127.0.0.1:5173'

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

async function serve(origins: readonly string[]) {
  const instance = Fastify({ logger: false })
  await instance.register(cors, corsOptions(origins))
  instance.get('/auth/me', async () => ({ user: null }))
  instance.patch('/auth/preferences', async () => ({ ok: true }))
  await instance.ready()
  app = instance

  return async (origin: string, method = 'PATCH') => {
    const preflight = await instance.inject({
      method: 'OPTIONS',
      url: '/auth/preferences',
      headers: { origin, 'access-control-request-method': method },
    })
    const actual = await instance.inject({ url: '/auth/me', headers: { origin } })

    return {
      allowOrigin: preflight.headers['access-control-allow-origin'],
      allowCredentials: preflight.headers['access-control-allow-credentials'],
      allowMethods: String(preflight.headers['access-control-allow-methods'] ?? ''),
      readableOrigin: actual.headers['access-control-allow-origin'],
      vary: String(actual.headers.vary ?? ''),
    }
  }
}

describe('the canonical local configuration: localhost end to end', () => {
  it('allows exactly that origin, with credentials', async () => {
    const ask = await serve([LOCALHOST])
    const answer = await ask(LOCALHOST)

    expect(answer.allowOrigin).toBe(LOCALHOST)
    expect(answer.allowCredentials).toBe('true')
    expect(answer.readableOrigin).toBe(LOCALHOST)
  })

  it('refuses the same host under its other name', async () => {
    /*
     * The reproduced failure, as a test. It is the correct answer: the
     * deployment is the thing that is wrong, and this is what says so.
     */
    const ask = await serve([LOCALHOST])
    const answer = await ask(LOOPBACK)

    expect(answer.allowOrigin).not.toBe(LOOPBACK)
    expect(answer.readableOrigin).not.toBe(LOOPBACK)
  })

  it('refuses an origin nobody wrote down', async () => {
    const ask = await serve([LOCALHOST])
    const answer = await ask('https://elsewhere.example')

    expect(answer.allowOrigin).not.toBe('https://elsewhere.example')
    expect(answer.readableOrigin).not.toBe('https://elsewhere.example')
  })
})

describe('the alternative, chosen entirely through configuration', () => {
  it('works the same way with 127.0.0.1 on both sides', async () => {
    // No code changes anything here: ADMIN_ORIGIN names the loopback origin
    // and VITE_API_URL points the admin at the loopback API.
    const ask = await serve([LOOPBACK])
    const answer = await ask(LOOPBACK)

    expect(answer.allowOrigin).toBe(LOOPBACK)
    expect(answer.allowCredentials).toBe('true')
    expect(answer.readableOrigin).toBe(LOOPBACK)
  })

  it('then refuses localhost, which is the other half of picking one name', async () => {
    const ask = await serve([LOOPBACK])
    expect((await ask(LOCALHOST)).allowOrigin).not.toBe(LOCALHOST)
  })
})

describe('a list, for an installation with more than one admin name', () => {
  it('answers each listed origin with itself and varies on it', async () => {
    const ask = await serve([LOCALHOST, 'https://admin.example'])

    expect((await ask(LOCALHOST)).allowOrigin).toBe(LOCALHOST)
    const other = await ask('https://admin.example')
    expect(other.allowOrigin).toBe('https://admin.example')
    // Without Vary: Origin a shared cache would serve one origin's answer to
    // another, which is the one way an exact list still leaks.
    expect(other.vary.toLowerCase()).toContain('origin')
  })
})

describe('what must never appear', () => {
  it('never answers a wildcard, whatever the origin', async () => {
    /*
     * `*` with credentials is refused by browsers anyway, so the real risk is
     * the shape that is accepted: a wildcard where the cookie is then dropped,
     * or an origin reflected back unchecked. Neither is reachable from here —
     * the option is a list of strings.
     */
    const ask = await serve([LOCALHOST])

    for (const origin of [LOCALHOST, LOOPBACK, 'https://elsewhere.example', 'null']) {
      const answer = await ask(origin)
      expect(answer.allowOrigin, origin).not.toBe('*')
      expect(answer.readableOrigin, origin).not.toBe('*')
    }
  })

  it('names the methods the API actually serves', async () => {
    const ask = await serve([LOCALHOST])
    const allowed = (await ask(LOCALHOST)).allowMethods.split(',').map((value) => value.trim())

    expect(allowed).toEqual(expect.arrayContaining(['GET', 'POST', 'PATCH', 'DELETE']))
  })
})
