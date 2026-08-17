import { describe, expect, it, vi } from 'vitest'
import { createProbe } from './probe.ts'

/*
 * Two properties, and the second is the one that is easy to miss. Bounding the
 * response is obvious; not starting a second operation every time the first
 * one is still running is what stops a liveness check from turning one wedged
 * dependency into an exhausted connection pool.
 */

/** A promise whose settling this test decides. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('a probe that answers', () => {
  it('reports up when the dependency does', async () => {
    const probe = createProbe({ check: async () => 'pong', timeoutMs: 1000 })
    expect(await probe.run()).toEqual({ status: 'up' })
  })

  it('reports down when the dependency refuses', async () => {
    const probe = createProbe({
      check: async () => {
        throw new Error('connection refused')
      },
      timeoutMs: 1000,
    })
    expect(await probe.run()).toEqual({ status: 'down' })
  })
})

describe('a probe that does not answer', () => {
  it('gives up inside its budget rather than waiting for the dependency', async () => {
    const stuck = deferred<string>()
    const probe = createProbe({ check: () => stuck.promise, timeoutMs: 50 })

    const started = Date.now()
    const result = await probe.run()

    expect(result).toEqual({ status: 'down', timedOut: true })
    expect(Date.now() - started).toBeLessThan(1000)

    stuck.resolve('late')
    await settle()
  })

  it('starts exactly one operation however many callers arrive', async () => {
    /*
     * The case this exists for: a liveness check calling every few seconds
     * while the database is wedged. Without this, every call adds a query that
     * never returns, and the pool is gone long before anyone reads the logs.
     */
    const stuck = deferred<string>()
    const check = vi.fn(() => stuck.promise)
    const probe = createProbe({ check, timeoutMs: 30 })

    const results = await Promise.all([probe.run(), probe.run(), probe.run(), probe.run()])

    expect(results.every((r) => r.timedOut)).toBe(true)
    expect(check).toHaveBeenCalledTimes(1)
    expect(probe.started).toBe(1)

    stuck.resolve('late')
    await settle()
  })

  it('still starts only one when the calls are sequential', async () => {
    const stuck = deferred<string>()
    const check = vi.fn(() => stuck.promise)
    const probe = createProbe({ check, timeoutMs: 20 })

    await probe.run()
    await probe.run()
    await probe.run()

    expect(check).toHaveBeenCalledTimes(1)
    expect(probe.inFlight).toBe(true)

    stuck.resolve('late')
    await settle()
  })
})

describe('once the stuck operation finally settles', () => {
  it('lets the next probe run for real and see the recovery', async () => {
    // Reusing a finished result would report the outage forever; the point of
    // releasing the slot is that a later probe genuinely asks again.
    const stuck = deferred<string>()
    let attempt = 0
    const check = vi.fn(() => {
      attempt++
      return attempt === 1 ? stuck.promise : Promise.resolve('pong')
    })
    const probe = createProbe({ check, timeoutMs: 20 })

    expect(await probe.run()).toEqual({ status: 'down', timedOut: true })

    stuck.resolve('eventually')
    await settle()
    expect(probe.inFlight).toBe(false)

    expect(await probe.run()).toEqual({ status: 'up' })
    expect(check).toHaveBeenCalledTimes(2)
  })

  it('releases the slot after a rejection too', async () => {
    const stuck = deferred<string>()
    let attempt = 0
    const probe = createProbe({
      check: () => {
        attempt++
        return attempt === 1 ? stuck.promise : Promise.resolve('pong')
      },
      timeoutMs: 20,
    })

    expect((await probe.run()).timedOut).toBe(true)

    stuck.reject(new Error('gave up eventually'))
    await settle()

    expect(probe.inFlight).toBe(false)
    expect(await probe.run()).toEqual({ status: 'up' })
  })

  it('never leaves a late rejection unhandled', async () => {
    /*
     * A rejection whose only consumer has already timed out would otherwise be
     * an unhandled rejection — which Node terminates the process for by
     * default, turning a dependency blip into an outage of the API itself.
     */
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)

    try {
      const stuck = deferred<string>()
      const probe = createProbe({ check: () => stuck.promise, timeoutMs: 20 })

      expect((await probe.run()).timedOut).toBe(true)
      stuck.reject(new Error('too late to matter'))

      await settle()
      await settle()
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})
