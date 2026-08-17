import Fastify, { errorCodes, type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import { RateLimitStoreUnavailableError } from '../rate-limit/valkey-store.ts'
import { ForwardedAddressError } from './client-ip.ts'
import { ClientFacingError, REDACTED_LOG_PATHS, registerErrorHandling } from './errors.ts'

/*
 * The boundary answers from what it decides, never from the object it was
 * given. Everything below is a way somebody's error tried to write the
 * response itself: a status, a code, a class, a marker field, a getter.
 */

const SECRET = 'postgres://user:hunter2@db/prod'
const INTERNAL_HOST = 'db-primary.internal:5432'
const INTERNAL_TOKEN = 'sk_live_INTERNAL'
const SUBMITTED = 'victim@example.test'

/** Statuses an error must never be allowed to answer with. */
const IMPOSSIBLE_STATUSES: [string, unknown][] = [
  ['a success code', 200],
  ['a redirect', 302],
  ['the edge of the redirect range', 399],
  ['beyond the HTTP range', 600],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['a fraction', 429.5],
  ['a numeric string', '429'],
]

/** Objects wearing the contract's prototype without its constructor. */
const FORGED_CONTRACTS: [string, () => number][] = [
  ['a valid status', () => 429],
  ['a success status', () => 200],
  [
    'a status that changes on every read',
    (() => {
      let reads = 0
      return () => (reads++ % 2 === 0 ? 429 : 200)
    })(),
  ],
]

/** `validation` is a field anyone can set, in any shape and any size. */
const VALIDATION_MARKERS: [string, unknown, number][] = [
  [
    'fields carrying a secret',
    [{ instancePath: `/${INTERNAL_TOKEN}`, keyword: INTERNAL_TOKEN }],
    400,
  ],
  ['a value that is not an array', 'not-an-array', 400],
  ['entries that are not objects', [null, 42], 400],
  [
    'five thousand large entries',
    Array.from({ length: 5_000 }, () => ({
      instancePath: 'p'.repeat(200),
      keyword: 'k'.repeat(200),
    })),
    400,
  ],
  ['a conflict wearing the marker', [{ instancePath: '/a', keyword: 'b' }], 409],
  ['a server failure wearing the marker', [{ instancePath: '/a', keyword: 'b' }], 503],
]

let app: FastifyInstance | null = null
let lines: Record<string, unknown>[] = []

afterEach(async () => {
  await app?.close()
  app = null
  lines = []
})

async function serve(options: { bodyLimit?: number } = {}) {
  lines = []
  const instance = Fastify({
    ...options,
    logger: {
      // Production's level: a line written at info would be invisible where it
      // matters, and a test using info would never notice.
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
  instance.get('/unavailable', async () => {
    throw Object.assign(new Error('rate limit store said: Stream is not writeable'), {
      statusCode: 503,
    })
  })

  // Four ways of claiming a 4xx is publishable: a status, an invented code, a
  // copied code, and a real instance of a published class with a new message.
  instance.get('/dependency-conflict', async () => {
    throw Object.assign(new Error(`conflict on ${INTERNAL_HOST} with token ${INTERNAL_TOKEN}`), {
      statusCode: 409,
    })
  })
  instance.get('/teapot', async () => {
    throw Object.assign(new Error(`I am a teapot living at ${INTERNAL_HOST}`), { statusCode: 418 })
  })
  instance.get('/invented-code', async () => {
    throw Object.assign(new Error(`state at ${INTERNAL_HOST} with token ${INTERNAL_TOKEN}`), {
      statusCode: 409,
      code: 'FST_FAKE_INTERNAL',
    })
  })
  instance.get('/copied-code', async () => {
    throw Object.assign(new Error(`upstream: token ${INTERNAL_TOKEN} at ${INTERNAL_HOST}`), {
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
    })
  })
  instance.get('/tampered-instance', async () => {
    const error = new errorCodes.FST_ERR_CTP_INVALID_JSON_BODY()
    error.message = `token ${INTERNAL_TOKEN} at ${INTERNAL_HOST}`
    throw error
  })

  instance.get('/limited', async () => {
    throw new ClientFacingError(429, 'Rate limit exceeded, retry in 60')
  })

  IMPOSSIBLE_STATUSES.forEach(([, statusCode], index) => {
    instance.get(`/status/${index}`, async () => {
      throw Object.assign(new Error(`secret ${INTERNAL_TOKEN}`), { statusCode })
    })
  })
  VALIDATION_MARKERS.forEach(([, validation, statusCode], index) => {
    instance.get(`/marker/${index}`, async () => {
      throw Object.assign(new Error(`marked failure at ${INTERNAL_HOST}`), {
        statusCode,
        validation,
      })
    })
  })

  // Errors whose own properties attack the handler that reads them.
  instance.get('/throwing-status', async () => {
    const error = new Error('outer')
    Object.defineProperty(error, 'statusCode', {
      get() {
        throw new Error(`getter leak ${INTERNAL_TOKEN}`)
      },
    })
    throw error
  })
  instance.get('/throwing-serialization', async () => {
    const error = Object.assign(new Error('outer'), { statusCode: 500 })
    Object.defineProperty(error, 'detail', {
      enumerable: true,
      get() {
        throw new Error(`serializer leak ${INTERNAL_TOKEN}`)
      },
    })
    throw error
  })

  // `readonly` is a compile-time promise; these mutate the instance anyway.
  instance.get('/reason-replaced', async () => {
    const error = new ForwardedAddressError('invalid_forwarded_address', 'x')
    Object.assign(error, { reason: `token ${INTERNAL_TOKEN}` })
    throw error
  })
  instance.get('/reason-genuine', async () => {
    throw new ForwardedAddressError('missing_forwarded_address', 'x')
  })
  for (const [name, statusCode] of [
    ['store-success', 200],
    ['store-impossible', 600],
  ] as const) {
    instance.get(`/${name}`, async () => {
      const error = new RateLimitStoreUnavailableError(new Error('connect ECONNREFUSED'))
      Object.assign(error, { statusCode })
      throw error
    })
  }
  // The prototype without the constructor: `instanceof` is true, the snapshot
  // is absent. Three shapes of status, including one that changes per read.
  FORGED_CONTRACTS.forEach(([, status], index) => {
    instance.get(`/forged/${index}`, async () => {
      const error: ClientFacingError = Object.create(ClientFacingError.prototype)
      Object.assign(error, { message: `secret ${INTERNAL_TOKEN}` })
      Object.defineProperty(error, 'statusCode', { get: status, enumerable: true })
      throw error
    })
  })
  // A real one whose message is replaced after construction.
  instance.get('/message-replaced', async () => {
    const error = new ClientFacingError(429, 'Rate limit exceeded, retry in 60')
    Object.assign(error, { message: `secret ${INTERNAL_TOKEN}` })
    throw error
  })

  instance.post('/echo', async () => ({ ok: true }))

  await instance.ready()
  app = instance
  return instance
}

const failures = () => lines.filter((line) => line.msg === 'request failed')

describe('a 5xx says nothing about what runs here', () => {
  it('does not hand a database failure to the client', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/driver-failure' })

    expect(response.statusCode).toBe(500)
    for (const fragment of ['select', 'users', 'password_hash', SUBMITTED, 'params']) {
      expect(response.body).not.toContain(fragment)
    }
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

  it('writes the detail to the log, under the id the client was given', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/driver-failure' })

    const failure = failures()[0]
    expect(JSON.stringify(failure)).toContain('password_hash')
    expect(failure?.reqId).toBe(response.json().requestId)
    expect(failure?.route).toBe('/driver-failure')
  })

  it('preserves a 5xx that means something more precise than 500, and logs it', async () => {
    // Flattening every 5xx erases real information: a 503 says the
    // unavailability is probably temporary, which a 500 does not say.
    const instance = await serve()
    const response = await instance.inject({ url: '/unavailable' })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      statusCode: 503,
      error: 'unavailable',
      requestId: expect.any(String),
    })
    expect(response.body).not.toContain('Stream is not writeable')
    // The rate-limit store's own error is the one class exempt from this log,
    // because its outage is logged on transition; a 503 from elsewhere is not.
    expect(failures()[0]?.statusCode).toBe(503)
  })
})

describe('the answers this boundary writes itself', () => {
  it('answers the two JSON parser errors with their whole public contract', async () => {
    const instance = await serve()

    const malformed = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ not json',
    })
    expect(malformed.json()).toEqual({
      statusCode: 400,
      code: 'FST_ERR_CTP_INVALID_JSON_BODY',
      error: 'bad_request',
      message: "Body is not valid JSON but content-type is set to 'application/json'",
      requestId: expect.any(String),
    })

    const empty = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '',
    })
    expect(empty.json()).toEqual({
      statusCode: 400,
      code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
      error: 'bad_request',
      message: "Body cannot be empty when content-type is set to 'application/json'",
      requestId: expect.any(String),
    })
  })

  it('answers a body over the limit the same way', async () => {
    const instance = await serve({ bodyLimit: 128 })
    const response = await instance.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ padding: 'x'.repeat(512) }),
    })

    expect(response.json()).toEqual({
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
      error: 'payload_too_large',
      message: 'Request body is too large',
      requestId: expect.any(String),
    })
  })

  it('publishes nothing from an instance somebody built and edited', async () => {
    // The constructors are exported: `instanceof` says what class an object is,
    // not who made it, so it selects the contract and nothing travels with it.
    const instance = await serve()
    const response = await instance.inject({ url: '/tampered-instance' })

    expect(response.statusCode).toBe(400)
    expect(response.body).not.toContain(INTERNAL_TOKEN)
    expect(response.body).not.toContain(INTERNAL_HOST)
    expect(response.json().message).toBe(
      "Body is not valid JSON but content-type is set to 'application/json'",
    )
  })

  it('keeps what the application wrote itself, which is how the limiter answers', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/limited' })

    expect(response.statusCode).toBe(429)
    expect(response.json().message).toBe('Rate limit exceeded, retry in 60')
  })

  it('answers a stable shape for an unknown route', async () => {
    const instance = await serve()
    const response = await instance.inject({ url: '/nowhere-at-all' })

    expect(response.statusCode).toBe(404)
    expect(response.json()).toEqual({ error: 'not_found' })
  })
})

describe('a 4xx nobody here wrote keeps its status and loses its body', () => {
  const unrecognised: [string, string, number, string][] = [
    ['a dependency conflict', '/dependency-conflict', 409, 'conflict'],
    ['a status nobody mapped', '/teapot', 418, 'error'],
    ['an invented Fastify code', '/invented-code', 409, 'conflict'],
    ['an exact copy of a published code', '/copied-code', 400, 'bad_request'],
  ]

  it.each(unrecognised)('redacts %s and logs it', async (_label, url, status, code) => {
    const instance = await serve()
    const response = await instance.inject({ url })

    expect(response.statusCode).toBe(status)
    expect(response.body).not.toContain(INTERNAL_TOKEN)
    expect(response.body).not.toContain(INTERNAL_HOST)
    expect(response.json()).toEqual({
      statusCode: status,
      error: code,
      requestId: expect.any(String),
    })

    // Redacted, not lost: the detail is in the log under the same id.
    const failure = failures()[0]
    expect(failure?.reqId).toBe(response.json().requestId)
    expect(JSON.stringify(failure)).toContain(INTERNAL_HOST)
  })
})

describe('a validation marker is not a category of its own', () => {
  it.each(VALIDATION_MARKERS.map((entry, index) => [...entry, index] as const))(
    'answers %s as the ordinary error it is',
    async (_label, _validation, statusCode, index) => {
      // The marker used to select a shape of its own, which let a dependency's
      // 409 be reclassified and skip the log. No schema declares one; nothing
      // is projected from it.
      const instance = await serve()
      const response = await instance.inject({ url: `/marker/${index}` })

      expect(response.statusCode).toBe(statusCode)
      expect(response.body).not.toContain(INTERNAL_TOKEN)
      expect(response.body).not.toContain(INTERNAL_HOST)
      expect(response.body).not.toContain('instancePath')
      // Bounded whatever arrived: five thousand entries do not become a body.
      expect(response.body.length).toBeLessThan(200)
      expect(failures()).toHaveLength(1)
    },
  )
})

describe('the status an error is allowed to answer with', () => {
  it.each(IMPOSSIBLE_STATUSES.map(([label], index) => [label, index] as const))(
    'answers 500 for %s, never a 2xx or 3xx',
    async (_label, index) => {
      /*
       * Measured on the raw value: 200, 302 and 399 turned an error into a
       * success or a redirect carrying the body with it, and 600, NaN and
       * Infinity made Fastify raise FST_ERR_BAD_STATUS_CODE and re-enter this
       * handler — two log lines and a leaked code for one request.
       */
      const instance = await serve()
      const response = await instance.inject({ url: `/status/${index}` })

      expect(response.statusCode).toBe(500)
      expect(response.body).not.toContain(INTERNAL_TOKEN)
      expect(response.json()).toEqual({
        statusCode: 500,
        error: 'internal',
        requestId: expect.any(String),
      })
      // One line, so the handler answered rather than being entered twice.
      expect(lines.filter((line) => line.msg === 'request failed')).toHaveLength(1)
    },
  )

  it('answers an error with no status at all as a server failure', async () => {
    const instance = await serve()
    expect((await instance.inject({ url: '/secret' })).statusCode).toBe(500)
  })
})

describe('an error that attacks the handler reading it', () => {
  it.each([
    ['a statusCode getter that throws', '/throwing-status'],
    ['a property the log serializer touches', '/throwing-serialization'],
  ])('answers a fixed 500 for %s', async (_label, url) => {
    // An exception inside a custom handler goes to Fastify's default one,
    // which published its message. The boundary fails closed instead.
    const instance = await serve()
    const response = await instance.inject({ url })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain(INTERNAL_TOKEN)
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'internal',
      requestId: expect.any(String),
    })
    expect(lines.some((line) => line.reqId === response.json().requestId)).toBe(true)
  })
})

describe('a class selects a contract; its properties do not become the answer', () => {
  it('publishes only a reason it already knew', async () => {
    const instance = await serve()

    const replaced = await instance.inject({ url: '/reason-replaced' })
    expect(replaced.statusCode).toBe(400)
    expect(replaced.body).not.toContain(INTERNAL_TOKEN)
    expect(replaced.json()).toEqual({ error: 'bad_request' })

    const genuine = await instance.inject({ url: '/reason-genuine' })
    expect(genuine.json()).toEqual({ error: 'bad_request', reason: 'missing_forwarded_address' })
  })

  it.each([
    ['a success code', '/store-success'],
    ['a status outside HTTP', '/store-impossible'],
  ])('answers a store outage 503 even with %s on the error', async (_label, url) => {
    const instance = await serve()
    const response = await instance.inject({ url })

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      statusCode: 503,
      error: 'unavailable',
      requestId: expect.any(String),
    })
  })

  it.each(FORGED_CONTRACTS.map(([label], index) => [label, index] as const))(
    'publishes nothing for an object built around the constructor, with %s',
    async (_label, index) => {
      // The contract lives in a snapshot only the constructor writes, so an
      // object that never passed through it is not one, whatever it looks like.
      const instance = await serve()
      const response = await instance.inject({ url: `/forged/${index}` })

      expect(response.body).not.toContain(INTERNAL_TOKEN)
      expect(response.json().message).toBeUndefined()
      // The status in the body is the status on the wire, read once.
      expect(response.json().statusCode).toBe(response.statusCode)
      expect(failures()).toHaveLength(1)
    },
  )

  it('publishes the message the constructor recorded, not the one on the object', async () => {
    // `Error.message` stays writable; the snapshot is frozen.
    const instance = await serve()
    const response = await instance.inject({ url: '/message-replaced' })

    expect(response.statusCode).toBe(429)
    expect(response.body).not.toContain(INTERNAL_TOKEN)
    expect(response.json().message).toBe('Rate limit exceeded, retry in 60')
  })

  it('refuses a status that is not a 4xx, where the mistake is', () => {
    expect(() => new ClientFacingError(503, 'unavailable')).toThrow(RangeError)
    expect(() => new ClientFacingError(200, 'fine')).toThrow(RangeError)
    expect(() => new ClientFacingError(429.5, 'nearly')).toThrow(RangeError)

    const contract = new ClientFacingError(429, 'Rate limit exceeded')
    expect(() => Object.assign(contract, { statusCode: 200 })).toThrow(TypeError)
    expect(contract.statusCode).toBe(429)
  })
})

describe('a logger that fails too', () => {
  it('still answers one fixed 500, and stops trying', async () => {
    // The last resort must not depend on being able to write it down.
    let attempts = 0
    const instance = Fastify({
      logger: {
        level: 'warn',
        stream: {
          write() {
            attempts++
            throw new Error(`logger destination is gone: ${INTERNAL_TOKEN}`)
          },
        },
      },
    })
    registerErrorHandling(instance)
    instance.get('/boom', async () => {
      throw new Error(`inner failure at ${INTERNAL_HOST}`)
    })
    await instance.ready()
    app = instance

    const response = await instance.inject({ url: '/boom' })

    expect(response.statusCode).toBe(500)
    expect(response.body).not.toContain(INTERNAL_TOKEN)
    expect(response.body).not.toContain(INTERNAL_HOST)
    expect(response.json()).toEqual({
      statusCode: 500,
      error: 'internal',
      requestId: expect.any(String),
    })
    // Bounded: the failed line, then two last-resort attempts. No recursion.
    expect(attempts).toBeLessThanOrEqual(3)
  })
})

describe('what the log must never contain', () => {
  it('keeps cookies, authorization and the body out of it', async () => {
    /*
     * Guaranteed for the structured fields we own, which is what this asserts.
     * An error's own message is free-form text from an arbitrary library, and
     * no generic filter can be trusted to clear arbitrary text of secrets
     * without a structured contract — so keeping the whole message is a stated
     * decision with a stated cost, not a guarantee this suite can make.
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
