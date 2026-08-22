import {
  errorCodes,
  type FastifyError,
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify'
import { RateLimitStoreUnavailableError } from '../rate-limit/valkey-store.ts'
import { ForwardedAddressError } from './client-ip.ts'

/**
 * What crosses the boundary when something fails, and what stays behind.
 *
 * Fastify's default handler forwards `error.message` verbatim, for every
 * status including 500 — its own documentation says so and warns about it.
 * Against an unreachable database this API answered an unauthenticated caller
 * with the failing SQL, the column list of `users` including `password_hash`,
 * and the address that caller had just submitted.
 *
 * Nothing received is serialized or forwarded wholesale. Responses are built
 * from fixed contracts, except the message of a `ClientFacingError`, which is
 * read from the snapshot its constructor recorded. Status, code, class and
 * property alike are forgeable — each was forged in turn while this was
 * written — so they select an answer rather than becoming one; whatever is
 * left is normalised, redacted and logged.
 */

/**
 * Where the two redaction regimes meet, and nothing more. A 4xx names an HTTP
 * category; it says nothing about where the error came from or whether its
 * text is safe to publish. That question is answered by recognition below.
 */
const CLIENT_ERROR_CEILING = 500

interface Failure {
  statusCode: number
  error: string
  requestId: string
}

const GENERIC: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  405: 'method_not_allowed',
  409: 'conflict',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'unprocessable_entity',
  429: 'too_many_requests',
  500: 'internal',
  502: 'bad_gateway',
  503: 'unavailable',
  504: 'gateway_timeout',
}

/** What a `ClientFacingError` publishes, recorded when it is constructed. */
interface PublicContract {
  readonly statusCode: number
  readonly message: string
}

/**
 * Contracts, kept outside the objects they describe.
 *
 * A public property proves nothing: `Object.create(ClientFacingError.prototype)`
 * makes `instanceof` true without running the constructor, and `Error.message`
 * stays writable on a real instance — measured, both published a token. Only
 * the constructor writes here, and what it writes is frozen, so passing
 * through it is what authenticates the contract and later edits to the object
 * change nothing.
 */
const CONTRACTS = new WeakMap<object, PublicContract>()

/**
 * A 4xx this application wrote itself, for the caller to read. Its message is
 * the single free field this boundary publishes.
 */
export class ClientFacingError extends Error {
  readonly statusCode!: number

  constructor(statusCode: number, message: string) {
    super(message)
    this.name = 'ClientFacingError'
    if (!isClientStatus(statusCode)) {
      throw new RangeError(`ClientFacingError takes a 4xx status, not ${statusCode}`)
    }
    // Non-writable for callers reading it; the response uses the snapshot.
    Object.defineProperty(this, 'statusCode', {
      value: statusCode,
      writable: false,
      configurable: false,
      enumerable: true,
    })
    CONTRACTS.set(this, Object.freeze({ statusCode, message }))
  }
}

/** The only statuses a published application message may answer with. */
function isClientStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 400 &&
    value < CLIENT_ERROR_CEILING
  )
}

/**
 * The public answer given for three Fastify errors, written here in full.
 *
 * The class selects a contract and supplies nothing: Fastify exports these
 * constructors, so a real instance can be built anywhere and its message
 * replaced — measured, one carrying a token published it. Each answer below
 * describes only the caller's own content type or size.
 */
const RECONSTRUCTED = [
  {
    matches: (error: unknown) => error instanceof errorCodes.FST_ERR_CTP_EMPTY_JSON_BODY,
    statusCode: 400,
    code: 'FST_ERR_CTP_EMPTY_JSON_BODY',
    message: "Body cannot be empty when content-type is set to 'application/json'",
  },
  {
    matches: (error: unknown) => error instanceof errorCodes.FST_ERR_CTP_INVALID_JSON_BODY,
    statusCode: 400,
    code: 'FST_ERR_CTP_INVALID_JSON_BODY',
    message: "Body is not valid JSON but content-type is set to 'application/json'",
  },
  {
    matches: (error: unknown) => error instanceof errorCodes.FST_ERR_CTP_BODY_TOO_LARGE,
    statusCode: 413,
    code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    message: 'Request body is too large',
  },
] as const

/**
 * The status for everything the contracts above do not cover, decided once and
 * used for every comparison, body and log line after it. Measured on the raw
 * value: 200, 302 and 399 answered success or a redirect carrying the body,
 * 600, NaN and Infinity made Fastify raise FST_ERR_BAD_STATUS_CODE and re-enter
 * this handler, and 429.5 and "429" reached the payload as they were.
 */
function normalizeStatus(value: unknown): number {
  const isErrorStatus =
    typeof value === 'number' && Number.isInteger(value) && value >= 400 && value <= 599
  return isErrorStatus ? value : 500
}

/**
 * The status is preserved, only the body is replaced.
 *
 * Flattening every 5xx to 500 would erase real information: a 503 says the
 * unavailability is probably temporary, and may carry Retry-After, which a 500
 * does not say. Whether anything is actually retried stays the client's
 * decision — it depends on the method, on whether it is idempotent, and on the
 * client's own policy. The signal is preserved; no safe replay is promised.
 *
 * Exported so a route that answers a fixed 5xx of its own — the object store
 * being full of uploads is one — builds the same body as this boundary does,
 * from the same table, rather than assembling a lookalike beside it. It takes
 * a status and a request id and reads nothing else: no exception, no message,
 * nothing a caller could smuggle a string through.
 */
export function fixedFailure(statusCode: number, requestId: string): Failure {
  const fallback = statusCode < CLIENT_ERROR_CEILING ? 'error' : 'internal'
  return { statusCode, error: GENERIC[statusCode] ?? fallback, requestId }
}

export function registerErrorHandling(app: FastifyInstance): void {
  /*
   * Wrapped, because classifying an error touches its properties and those can
   * be anything: a `statusCode` or `validation` getter that throws sends the
   * new exception to Fastify's default handler, which published its message —
   * measured, `getter leak …` reached the client with the boundary bypassed
   * entirely. Anything that fails in here is answered by one fixed 500.
   */
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    try {
      return classify(error, request, reply)
    } catch (failure) {
      recordHandlerFailure(request, failure)
      return reply.code(500).send(fixedFailure(500, request.id))
    }
  })

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(404).send({ error: 'not_found' })
  })
}

/**
 * The last-resort log line, which must never be what stops the response.
 *
 * The error object may be what throws, so the second attempt drops it; the
 * logger or its destination may be what throws, so even that is allowed to
 * fail silently. A boundary that could not answer because it could not write
 * a line would be the same escape by a longer road.
 */
function recordHandlerFailure(request: FastifyRequest, failure: unknown): void {
  try {
    request.log.error({ err: failure, reqId: request.id }, 'error handler failed')
  } catch {
    try {
      request.log.error({ reqId: request.id }, 'error handler failed')
    } catch {
      // Nothing left to try, and the 500 still goes out.
    }
  }
}

/** The two reasons a forwarded-address refusal may name. */
const PUBLIC_REASONS = ['missing_forwarded_address', 'invalid_forwarded_address'] as const

/** The decision itself: which answer this error selects. */
function classify(error: FastifyError, request: FastifyRequest, reply: FastifyReply) {
  /*
   * The identity plugin refuses a request whose trusted proxy sent no usable
   * address. The status is written here rather than read from the error, and
   * the reason has to be one of the two this API publishes: measured,
   * replacing `reason` on the instance reflected whatever it was set to.
   */
  if (error instanceof ForwardedAddressError) {
    const reason = PUBLIC_REASONS.find((candidate) => candidate === error.reason)
    return reply
      .code(400)
      .send(reason ? { error: 'bad_request', reason } : { error: 'bad_request' })
  }

  /*
   * Answered generically like any 5xx, but not logged again: the store logs
   * its own outage on transition, and a route that fails closed would
   * otherwise write one stack per attempt for the length of it.
   */
  if (error instanceof RateLimitStoreUnavailableError) {
    // 503 written here, not read: the property is as mutable as any other, and
    // a store outage answering 200 was measured.
    return reply.code(503).send(fixedFailure(503, request.id))
  }

  /*
   * The only message published from an object, and it comes from the frozen
   * snapshot rather than the object — read once, so the status in the body and
   * the status on the wire cannot disagree. An object that never went through
   * the constructor is not in the map, and falls through.
   */
  const authorised = CONTRACTS.get(error)
  if (authorised) {
    return reply.code(authorised.statusCode).send({
      statusCode: authorised.statusCode,
      error: GENERIC[authorised.statusCode] ?? 'error',
      message: authorised.message,
      requestId: request.id,
    })
  }

  const contract = RECONSTRUCTED.find((candidate) => candidate.matches(error))
  if (contract) {
    return reply.code(contract.statusCode).send({
      statusCode: contract.statusCode,
      code: contract.code,
      error: GENERIC[contract.statusCode] ?? 'error',
      message: contract.message,
      requestId: request.id,
    })
  }

  const statusCode = normalizeStatus(error.statusCode)

  /*
   * Everything else is redacted, 4xx included, with its status preserved —
   * a 409 stays a 409 — and logged, because losing both the body and the
   * record would leave nothing to diagnose it with.
   *
   * Logging is ours the moment a custom handler exists — Fastify no longer
   * does it for us. `err` goes through pino's serializer, and the redaction
   * configured on the logger covers the structured fields we control.
   *
   * `routerPath` rather than `request.url`: a URL can carry a token in its
   * query string, and this line is written for every failure.
   */
  request.log.error(
    {
      err: error,
      reqId: request.id,
      method: request.method,
      route: request.routeOptions?.url ?? 'unmatched',
      statusCode,
    },
    'request failed',
  )

  return reply.code(statusCode).send(fixedFailure(statusCode, request.id))
}

/**
 * Fields the logger must never write, whatever a serializer is changed to do
 * later.
 *
 * These are structured fields we own, so their absence is a guarantee and a
 * test asserts it. An error's own message is a different problem: it is
 * free-form text from an arbitrary library and may carry a secret anywhere in
 * it, and no generic expression or filter can be trusted to remove every
 * secret from arbitrary text without a structured contract to work against.
 *
 * That leaves a choice rather than an impossibility. The message could be left
 * out of the log entirely, or replaced by structured errors and codes, or
 * written through an allow-list, or have known sensitive values masked, hashed
 * or encrypted — each of those costs diagnostic detail. This project logs the
 * whole message, because a third-party failure is usually only explicable in
 * its own words, and treats the result accordingly: server logs inherit the
 * handling the database gets, restricted access and bounded retention. The
 * trade is stated, not hidden behind a regular expression.
 */
export const REDACTED_LOG_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["set-cookie"]',
  'res.headers["set-cookie"]',
  'req.body',
  '*.password',
  '*.passwordHash',
  '*.token',
]
