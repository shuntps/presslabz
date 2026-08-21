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
 * Nothing here names a cause. `/health` is unauthenticated, and "the bucket
 * policy refused me" describes an operator's infrastructure to anybody who
 * asks. The distinct causes go to the log, where the person who can act on
 * them is already looking.
 *
 * Media storage is here for the same reason and was missing: an instance whose
 * object store is unreachable accepts a file, spends the re-encode, and fails
 * at the write. Whether that should take the *whole* instance out is a real
 * question — reading a site does not need the bucket — and the answer is yes
 * for the same reason as the rate limiter: this is the report an operator acts
 * on, and "everything is fine except the thing that stores your uploads" is
 * not a report anybody reads carefully.
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
  /**
   * Whether the store answers this instance at all. Not whether an upload will
   * succeed: `HeadBucket` and `PutObject` are different permissions, and a
   * credential that passes one and fails the other is an ordinary
   * misconfiguration. Nothing here claims uploads work.
   */
  readonly storage: ProbeResult
  /**
   * Whether a reader can fetch an object over the URL readers actually use —
   * the external base when `MEDIA_BASE_URL` names one, the store itself
   * otherwise. Asked in both cases: a delivery base answering 403 is exactly
   * as broken as a bucket that does.
   */
  readonly mediaDelivery: ProbeResult
}

/**
 * Two questions, one verdict.
 *
 * A store that refuses the credentials, has no bucket or does not answer is
 * `down`: nothing about media can work. A store that answers while readers get
 * 403 is `degraded` — the instance may still be usable to an author and is
 * broken for everybody else, and calling that `up` is how a site serves
 * nothing but missing images with a green health check.
 *
 * Both are 503, because `up` here means "every guarantee this report makes
 * holds". The distinction is for the operator reading the body, not for the
 * load balancer.
 */
function storageStatus(input: HealthInput): ServiceStatus {
  if (input.storage.status === 'down') return 'down'
  if (input.mediaDelivery?.status === 'down') return 'degraded'
  return 'up'
}

export function summarizeHealth(input: HealthInput): { statusCode: number; body: HealthReport } {
  const services = {
    database: input.database.status,
    cache: input.cache.status,
    rateLimit: input.rateLimitDegraded ? ('degraded' as const) : ('up' as const),
    storage: storageStatus(input),
  }

  const healthy = Object.values(services).every((status) => status === 'up')

  return {
    statusCode: healthy ? 200 : 503,
    body: { status: healthy ? 'ok' : 'degraded', services },
  }
}
