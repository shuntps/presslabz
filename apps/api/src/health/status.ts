import type { ProbeResult } from './probe.ts'

/**
 * What `/health` answers, decided in one place.
 *
 * The overall verdict has to cover every dependency an operator would restart
 * the process over — and the rate-limit store is one of them. It was left out:
 * `rateLimit` could report `degraded` in the body while `status` said `ok` and
 * the response stayed 200, which is a health check reporting health during an
 * outage. `/auth/login` fails closed when the store is unreachable, so in that
 * state signing in is refused for everyone; a load balancer told 200 keeps
 * sending traffic to an instance that cannot authenticate anybody.
 *
 * The counterpart is deliberate too: `up` is not "everything is perfect", it
 * is "every dependency answered". A degraded store therefore takes the whole
 * report down rather than being a footnote inside a 200.
 *
 * Media storage is here for the same reason and was missing: uploads depend on
 * it, and an instance whose object store is unreachable accepts a file, spends
 * the re-encode, and fails at the write. Whether that should take the *whole*
 * instance out is a real question — reading a site does not need the bucket —
 * and the answer is yes for the same reason as the rate limiter: this is the
 * report an operator acts on, and "everything is fine except the thing that
 * stores your uploads" is not a report anybody reads carefully.
 */
type ServiceStatus = 'up' | 'down' | 'degraded'

export interface HealthReport {
  status: 'ok' | 'degraded'
  services: {
    database: ServiceStatus
    cache: ServiceStatus
    rateLimit: ServiceStatus
    storage: ServiceStatus
  }
}

export interface HealthInput {
  readonly database: ProbeResult
  readonly cache: ProbeResult
  /** The limiter's store, which reports a transition rather than a probe. */
  readonly rateLimitDegraded: boolean
  readonly storage: ProbeResult
}

export function summarizeHealth(input: HealthInput): { statusCode: number; body: HealthReport } {
  const services = {
    database: input.database.status,
    cache: input.cache.status,
    rateLimit: input.rateLimitDegraded ? ('degraded' as const) : ('up' as const),
    storage: input.storage.status,
  }

  const healthy = Object.values(services).every((status) => status === 'up')

  return {
    statusCode: healthy ? 200 : 503,
    body: { status: healthy ? 'ok' : 'degraded', services },
  }
}
