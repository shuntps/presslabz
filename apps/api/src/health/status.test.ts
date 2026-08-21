import { describe, expect, it } from 'vitest'
import type { ProbeResult } from './probe.ts'
import { summarizeHealth } from './status.ts'

/*
 * The verdict, not the vocabulary. What used to be asserted about /health was
 * that its body named three services; what was wrong was the line above them.
 * With the limiter's store unreachable the body said `status: ok` and the
 * response was 200, while `/auth/login` was refusing everyone — an instance
 * that cannot authenticate anybody, telling a load balancer to keep sending it
 * traffic.
 */

const up: ProbeResult = { status: 'up' }
const down: ProbeResult = { status: 'down' }
const timedOut: ProbeResult = { status: 'down', timedOut: true }

describe('the overall verdict', () => {
  it('is ok and 200 only when every dependency answered', () => {
    expect(
      summarizeHealth({
        database: up,
        cache: up,
        storage: up,
        mediaDelivery: up,
        rateLimitDegraded: false,
      }),
    ).toEqual({
      statusCode: 200,
      body: {
        status: 'ok',
        services: { database: 'up', cache: 'up', rateLimit: 'up', storage: 'up' },
      },
    })
  })

  it('follows the rate limit store, which is what used to be ignored', () => {
    expect(
      summarizeHealth({
        database: up,
        cache: up,
        storage: up,
        mediaDelivery: up,
        rateLimitDegraded: true,
      }),
    ).toEqual({
      statusCode: 503,
      body: {
        status: 'degraded',
        services: { database: 'up', cache: 'up', rateLimit: 'degraded', storage: 'up' },
      },
    })
  })

  it('follows the database', () => {
    expect(
      summarizeHealth({
        database: down,
        cache: up,
        storage: up,
        mediaDelivery: up,
        rateLimitDegraded: false,
      }),
    ).toEqual({
      statusCode: 503,
      body: {
        status: 'degraded',
        services: { database: 'down', cache: 'up', rateLimit: 'up', storage: 'up' },
      },
    })
  })

  it('follows the cache', () => {
    expect(
      summarizeHealth({
        database: up,
        cache: timedOut,
        storage: up,
        mediaDelivery: up,
        rateLimitDegraded: false,
      }),
    ).toEqual({
      statusCode: 503,
      body: {
        status: 'degraded',
        services: { database: 'up', cache: 'down', rateLimit: 'up', storage: 'up' },
      },
    })
  })

  it('reports every dependency at once rather than the first that failed', () => {
    expect(
      summarizeHealth({
        database: down,
        cache: down,
        storage: up,
        mediaDelivery: up,
        rateLimitDegraded: true,
      }),
    ).toEqual({
      statusCode: 503,
      body: {
        status: 'degraded',
        services: { database: 'down', cache: 'down', rateLimit: 'degraded', storage: 'up' },
      },
    })
  })

  it('answers 200 for exactly one of the sixteen combinations', () => {
    /*
     * The exhaustive form, so a dependency added later cannot be left out of
     * the verdict the way the rate limiter was. It did its job: adding media
     * storage broke this test rather than passing quietly with three of four
     * dependencies covered.
     */
    const outcomes = [false, true].flatMap((databaseDown) =>
      [false, true].flatMap((cacheDown) =>
        [false, true].flatMap((storageDown) =>
          [false, true].map((rateLimitDegraded) =>
            summarizeHealth({
              database: databaseDown ? down : up,
              cache: cacheDown ? down : up,
              storage: storageDown ? down : up,
              mediaDelivery: up,
              rateLimitDegraded,
            }),
          ),
        ),
      ),
    )

    expect(outcomes).toHaveLength(16)

    expect(outcomes.filter((outcome) => outcome.statusCode === 200)).toHaveLength(1)
    expect(outcomes.filter((outcome) => outcome.body.status === 'ok')).toHaveLength(1)
    for (const outcome of outcomes) {
      // The status line and the code never disagree, whichever dependency it is.
      expect(outcome.body.status === 'ok').toBe(outcome.statusCode === 200)
    }
  })

  /*
   * The bucket belongs in the verdict for the same reason the limiter's store
   * does: an instance whose object store will not answer accepts an upload,
   * spends the re-encode, and fails at the write. A refusal counts the same as
   * an outage, because an upload cannot tell them apart either.
   */
  it('follows media storage', () => {
    expect(
      summarizeHealth({
        database: up,
        cache: up,
        storage: down,
        mediaDelivery: up,
        rateLimitDegraded: false,
      }),
    ).toEqual({
      statusCode: 503,
      body: {
        status: 'degraded',
        services: { database: 'up', cache: 'up', rateLimit: 'up', storage: 'down' },
      },
    })
  })
})

/*
 * The store answering is one question; a reader being able to fetch an object
 * is another, and they are different permissions on any store worth the name.
 * "Storage is up" used to mean only the first, which is how a site could serve
 * nothing but broken images under a green health check. Neither question is
 * about whether an upload would succeed — `/health` writes nothing and claims
 * nothing about writing.
 */
describe('media storage, which is two questions', () => {
  const status = (input: Parameters<typeof summarizeHealth>[0]) =>
    summarizeHealth(input).body.services.storage

  const base = { database: up, cache: up, rateLimitDegraded: false } as const

  it('is down when the bucket itself will not answer, whatever readers can do', () => {
    expect(status({ ...base, storage: down, mediaDelivery: up })).toBe('down')
    expect(status({ ...base, storage: down, mediaDelivery: down })).toBe('down')
  })

  it('is degraded when the bucket answers and readers get nothing', () => {
    expect(status({ ...base, storage: up, mediaDelivery: down })).toBe('degraded')
  })

  it('is up when both hold', () => {
    expect(status({ ...base, storage: up, mediaDelivery: up })).toBe('up')
  })

  /*
   * The delivery probe runs in both modes, so there is no combination in which
   * this report is asked to guess. It was optional once — skipped whenever
   * MEDIA_BASE_URL was set — and that is precisely how an external base
   * answering 403 produced a 200.
   */
  it('demands an answer about readers in every mode', () => {
    // @ts-expect-error the delivery probe is not optional; omitting it must not compile
    expect(() => status({ ...base, storage: up })).toBeDefined()
  })

  it('is 503 for anything short of up, as every other dependency is', () => {
    expect(summarizeHealth({ ...base, storage: up, mediaDelivery: down }).statusCode).toBe(503)
    expect(summarizeHealth({ ...base, storage: down, mediaDelivery: down }).statusCode).toBe(503)
    expect(summarizeHealth({ ...base, storage: up, mediaDelivery: up }).statusCode).toBe(200)
  })

  /*
   * /health is unauthenticated. Which of the four it was — a policy, a
   * credential, an outage, a bucket that is not there — describes an
   * operator's infrastructure to anybody who asks, so it goes to the log and
   * not into this body.
   */
  it('says nothing about why', () => {
    const { body } = summarizeHealth({ ...base, storage: down, mediaDelivery: down })

    expect(Object.keys(body).sort()).toEqual(['services', 'status'])
    expect(JSON.stringify(body)).not.toMatch(/denied|policy|credential|endpoint|reason/i)
  })
})
