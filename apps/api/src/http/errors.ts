import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { RateLimitStoreUnavailableError } from '../rate-limit/valkey-store.ts'
import { ForwardedAddressError } from './client-ip.ts'

/**
 * What crosses the boundary when something fails, and what stays behind.
 *
 * Fastify's default handler forwards `error.message` verbatim, for every
 * status including 500 — its own documentation says so and warns about it.
 * Against a database that was unreachable, this API answered an unauthenticated
 * caller with the failing SQL, the full column list of `users` including
 * `password_hash`, and the email address that caller had just submitted, echoed
 * back under `params`. That is the hole this closes.
 *
 * A 5xx now carries a status, a stable code and a correlation id. Nothing else.
 * The detail is written to the log, where the correlation id finds it again.
 */

/** Statuses below this describe the request; above it, they describe us. */
const CLIENT_ERROR_CEILING = 500

interface Failure {
  statusCode: number
  error: string
  requestId: string
}

const GENERIC: Record<number, string> = {
  500: 'internal',
  502: 'bad_gateway',
  503: 'unavailable',
  504: 'gateway_timeout',
}

/**
 * The status is preserved, only the body is replaced.
 *
 * Flattening every 5xx to 500 would erase real information: a 503 says the
 * unavailability is probably temporary, and may carry Retry-After, which a 500
 * does not say. Whether anything is actually retried stays the client's
 * decision — it depends on the method, on whether it is idempotent, and on the
 * client's own policy. The signal is preserved; no safe replay is promised.
 */
function genericFor(statusCode: number, requestId: string): Failure {
  return { statusCode, error: GENERIC[statusCode] ?? 'internal', requestId }
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    // The identity plugin refuses a request whose trusted proxy sent no usable
    // address. It is a 4xx about the deployment, and its reason is safe to
    // name: it describes the caller's chain, not our internals.
    if (error instanceof ForwardedAddressError) {
      return reply.code(error.statusCode).send({ error: 'bad_request', reason: error.reason })
    }

    /*
     * Already accounted for, exactly once, by the store's own transition log.
     *
     * `/auth/login` fails closed, so an unreachable store raises this per
     * attempt: measured, twenty-five attempts during one outage wrote one
     * transition line and twenty-five stacks, all of them the same failure
     * seen from the same place. The count of what was hidden is what the
     * recovery line carries; a stack per request adds nothing an operator can
     * act on and buries what does. The response is unchanged — a generic 503
     * with its correlation id — and every other 5xx is still logged below.
     */
    if (error instanceof RateLimitStoreUnavailableError) {
      return reply.code(error.statusCode).send(genericFor(error.statusCode, request.id))
    }

    const statusCode = error.statusCode ?? CLIENT_ERROR_CEILING

    if (statusCode < CLIENT_ERROR_CEILING) {
      // Validation, unknown content type, 429 and the rest: Fastify's own
      // shape, unchanged. These say what the caller got wrong and expose
      // nothing about what runs here. The whole existing suite depends on it.
      return reply.send(error)
    }

    /*
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

    return reply.code(statusCode).send(genericFor(statusCode, request.id))
  })

  app.setNotFoundHandler((_request: FastifyRequest, reply: FastifyReply) => {
    return reply.code(404).send({ error: 'not_found' })
  })
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
