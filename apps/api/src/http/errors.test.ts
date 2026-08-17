import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { REDACTED_LOG_PATHS, registerErrorHandling } from './errors.ts'

/*
 * What this closes, reproduced before it was fixed: against a database that
 * was unreachable, an unauthenticated POST to /auth/login was answered with
 *
 *   Failed query: select "id", "email", "password_hash", … from "users"
 *   where lower("users"."email") = lower($1) limit $2
 *   params: someone@presslabz.test,1
 *
 * The SQL, the column list of `users` including password_hash, and the address
 * the caller had just submitted, echoed back. Fastify's default handler
 * forwards err.message verbatim for every status, 500 included — its own
 * documentation says so and warns about it.
 */

const SECRET = 'postgres://user:hunter2@db/prod'
const SUBMITTED = 'victim@example.test'

let app: FastifyInstance | null = null
let lines: Record<string, unknown>[] = []

afterEach(async () => {
  await app?.close()
  app = null
  lines = []
})

async function serve() {
  lines = []
  const instance = Fastify({
    logger: {
      // Production's level, not a permissive one: a message written at info
      // would be invisible where it matters, and a test that used info would
      // never notice.
      level: 'warn',
      redact: REDACTED_LOG_PATHS,
      stream: {
        write: (line: string) => {
          lines.push(JSON.parse(line))
        },
      },
    },
  })
  registerErrorHandling(instance)

  instance.get('/driver-failure', async () => {
    throw new Error(
      `Failed query: select "id", "email", "password_hash" from "users" where lower("email") = lower($1)\nparams: ${SUBMITTED},1`,
    )
  })
  instance.get('/secret', async () => {
    throw new Error(`secret detail: connection string ${SECRET}`)
  })
  instance.get('/teapot', async () => {
    throw Object.assign(new Error('I am a teapot and I say so'), { statusCode: 418 })
  })
  instance.get('/unavailable', async () => {
    throw Object.assign(new Error('rate limit store said: Stream is not writeable'), {
      statusCode: 503,
    })
  })
  instance.post('/echo', async () => ({ ok: true }))

  await instance.ready()
  app = instance
  return instance
}

describe('a 5xx says nothing about what runs here', () => {
  it('does not hand a database failure to the client', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/driver-failure' })

    expect(response.statusCode).toBe(500)

    const body = response.body
    expect(body).not.toContain('select')
    expect(body).not.toContain('users')
    expect(body).not.toContain('password_hash')
    expect(body).not.toContain(SUBMITTED)
    expect(body).not.toContain('params')

    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'internal',
      requestId: expect.any(String),
    })
  })

  it('does not hand any thrown message to the client', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/secret' })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain(SECRET)
    expect(response.body).not.toContain('hunter2')
  })

  it('keeps the correlation id that finds the detail in the log', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/driver-failure' })

    const { requestId } = response.json()
    expect(requestId).toBeTruthy()
    expect(lines.some((line) => line.reqId === requestId)).toBe(true)
  })

  it('writes the detail to the log, where it belongs', async () => {
    const instance = await serve()
    await instance.inject({ url: '/driver-failure' })

    const failure = lines.find((line) => line.msg === 'request failed')
    expect(failure).toBeDefined()
    expect(JSON.stringify(failure)).toContain('password_hash')
    expect(failure?.route).toBe('/driver-failure')
  })

  it('preserves a 5xx that means something more precise than 500', async () => {
    // Flattening every 5xx erases real information: 503 tells a client to try
    // again, which 500 does not.
    const instance = await serve()
    const response = await instance.inject({ url: '/unavailable' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      statusCode: 503,
      error: 'unavailable',
      requestId: expect.any(String),
    })
    expect(response.body).not.toContain('Stream is not writeable')
  })

  it('still logs a 503 that is not the rate limit store', async () => {
    /*
     * Exactly one error class is exempt from this log, because its own is
     * bounded and complete — see the store's transition lines. The exemption
     * is on the class, not on the status: a 503 from anywhere else is a
     * dependency failing with nobody else writing it down, and silencing it by
     * status would trade a log storm for a blackout.
     */
    const instance = await serve()
    await instance.inject({ url: '/unavailable' })

    const failure = lines.find((line) => line.msg === 'request failed')
    expect(failure).toBeDefined()
    expect(failure?.statusCode).toBe(503)
    expect(failure?.route).toBe('/unavailable')
  })
})

describe('a 4xx is left alone', () => {
  it('keeps the status and the message, which describe the request', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/teapot' })

    expect(response.statusCode).toBe(418)
    expect(response.json().message).toBe('I am a teapot and I say so')
  })

  it("keeps Fastify's own parser errors intact", async () => {
    const instance = await serve()
    const response = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    })

    expect(response.statusCode).toBe(400)
    expect(response.json().code).toBe('FST_ERR_CTP_INVALID_JSON_BODY')
  })

  it('answers a stable shape for an unknown route', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/nowhere-at-all' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found' })
  })
})

describe('what the log must never contain', () => {
  it('keeps cookies, authorization and the body out of it', async () => {
    /*
     * Guaranteed for the structured fields we own. An error's own message is
     * free-form text from an arbitrary library and cannot be sanitised by any
     * expression — that half is documented as a property of the system, not
     * claimed as a guarantee.
     */
    const instance = await serve()
    await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: {
        'content-type': 'application/json',
        cookie: 'presslabz_session=REAL_SESSION_TOKEN',
        authorization: 'Bearer SECRET_BEARER',
      },
      payload: JSON.stringify({ email: SUBMITTED, password: 'hunter2' }),
    })

    const whole = JSON.stringify(lines)
    expect(whole).not.toContain('REAL_SESSION_TOKEN')
    expect(whole).not.toContain('SECRET_BEARER')
    expect(whole).not.toContain('hunter2')
  })
})
