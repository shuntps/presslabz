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
      summarizeHealth({ database: up, cache: up, storage: up, rateLimitDegraded: false }),
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
      summarizeHealth({ database: up, cache: up, storage: up, rateLimitDegraded: true }),
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
      summarizeHealth({ database: down, cache: up, storage: up, rateLimitDegraded: false }),
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
      summarizeHealth({ database: up, cache: timedOut, storage: up, rateLimitDegraded: false }),
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
      summarizeHealth({ database: down, cache: down, storage: up, rateLimitDegraded: true }),
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
      summarizeHealth({ database: up, cache: up, storage: down, rateLimitDegraded: false }),
    ).toEqual({
      statusCode: 503,
      body: {
        status: 'degraded',
        services: { database: 'up', cache: 'up', rateLimit: 'up', storage: 'down' },
      },
    })
  })
})
