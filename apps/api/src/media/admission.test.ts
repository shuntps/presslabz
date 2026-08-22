import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createAdmission,
  DEFAULT_MAX_ACTIVE,
  DEFAULT_MAX_WAITING,
  UploadCapacityError,
} from './admission.ts'

/**
 * The gate on its own, with counters and no HTTP.
 *
 * Everything here is deterministic: nothing sleeps, nothing races, and the
 * only clock is a fake one. The properties that need a socket — the 503 a real
 * client receives, a slot surviving an abort mid-encode — are asserted against
 * the real route in upload-capacity.test.ts, where the try/finally that
 * releases the slot actually lives.
 */

/** A controller per waiter, so an abort can be aimed at exactly one. */
function pending(admission: ReturnType<typeof createAdmission>, count: number) {
  return Array.from({ length: count }, () => {
    const controller = new AbortController()
    const promise = admission.acquire(controller.signal)
    // A rejection asserted several statements later is not an unhandled one.
    promise.catch(() => {})
    return { controller, promise }
  })
}

/** Lets every already-resolved promise deliver before counters are read. */
const drain = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
  vi.useRealTimers()
})

describe('refusing an impossible configuration', () => {
  /*
   * `<= 0` would accept NaN, Infinity and 1.5. And a waitMs above Node's
   * ceiling is not a long wait: Node clamps it to one millisecond, so a queue
   * asked to wait an hour would wait 1 ms and nothing would say so.
   */
  it.for([
    ['maxActive', 0],
    ['maxActive', -1],
    ['maxActive', 1.5],
    ['maxActive', Number.NaN],
    ['maxActive', Number.POSITIVE_INFINITY],
    ['maxWaiting', -1],
    ['maxWaiting', 2.5],
    ['maxWaiting', Number.NaN],
    ['maxWaiting', Number.POSITIVE_INFINITY],
    ['waitMs', 0],
    ['waitMs', -1],
    ['waitMs', 1.5],
    ['waitMs', Number.NaN],
    ['waitMs', Number.POSITIVE_INFINITY],
    ['waitMs', 2_147_483_648],
  ] as const)('refuses %s = %s', ([name, value]) => {
    expect(() => createAdmission({ [name]: value })).toThrow(RangeError)
  })

  it('accepts a queue of zero, which is a coherent choice', () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 0 })

    expect(admission.waiting).toBe(0)
    expect(() => createAdmission({ maxActive: 1, maxWaiting: 0 })).not.toThrow()
    void admission
  })

  it('accepts the largest timeout Node will honour', () => {
    expect(() => createAdmission({ waitMs: 2_147_483_647 })).not.toThrow()
  })
})

describe('admitting and queueing', () => {
  it('runs two at once and makes the rest wait', async () => {
    const admission = createAdmission()
    const requests = pending(admission, 5)

    await drain()

    expect(admission.active).toBe(DEFAULT_MAX_ACTIVE)
    expect(admission.waiting).toBe(3)

    for (const request of requests) request.controller.abort()
  })

  it('refuses beyond the waiting maximum, and only then', async () => {
    const admission = createAdmission({ maxActive: 2, maxWaiting: 16 })
    const admitted = pending(admission, DEFAULT_MAX_ACTIVE + DEFAULT_MAX_WAITING)

    await drain()
    expect(admission.active).toBe(2)
    expect(admission.waiting).toBe(16)

    // The nineteenth upload overall is the first one refused.
    const refused = admission.acquire(new AbortController().signal)

    await expect(refused).rejects.toBeInstanceOf(UploadCapacityError)
    await expect(refused).rejects.toMatchObject({ kind: 'saturated' })
    expect(admission.waiting).toBe(16)

    for (const request of admitted) request.controller.abort()
  })

  /*
   * A refusal must leave nothing behind. If it registered an abort listener
   * before deciding it had no room, every refused upload would leave one on a
   * signal nobody removes it from.
   */
  it('registers nothing on the signal of a request it refuses', async () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 0 })
    const held = pending(admission, 1)
    await drain()

    const controller = new AbortController()
    let listeners = 0
    const original = controller.signal.addEventListener.bind(controller.signal)
    controller.signal.addEventListener = ((...args: Parameters<typeof original>) => {
      listeners += 1
      return original(...args)
    }) as typeof original

    await expect(admission.acquire(controller.signal)).rejects.toBeInstanceOf(UploadCapacityError)
    expect(listeners).toBe(0)

    held[0]?.controller.abort()
  })

  it('serves waiters in the order they arrived', async () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4 })
    const first = await admission.acquire(new AbortController().signal)

    const order: number[] = []
    const waiters = [0, 1, 2].map((index) =>
      admission.acquire(new AbortController().signal).then((slot) => {
        order.push(index)
        return slot
      }),
    )

    await drain()
    expect(admission.waiting).toBe(3)

    let slot = first
    for (let index = 0; index < 3; index += 1) {
      slot.release()
      slot = (await waiters[index]) as Awaited<(typeof waiters)[number]>
    }
    slot.release()

    expect(order).toEqual([0, 1, 2])
  })

  /*
   * The permit moves from one holder to the next in one step. If releasing
   * decremented and the waiter incremented separately, a third request could
   * see a free slot in between and there would be three decodes at once.
   */
  it('hands the permit to exactly one waiter, without passing through free', async () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4 })
    const held = await admission.acquire(new AbortController().signal)
    const waiters = pending(admission, 3)

    await drain()
    expect(admission.active).toBe(1)

    held.release()
    await drain()

    // One admitted, two still waiting, and never more than one running.
    expect(admission.active).toBe(1)
    expect(admission.waiting).toBe(2)

    for (const request of waiters) request.controller.abort()
  })

  it('releases once however many times it is asked', async () => {
    const admission = createAdmission({ maxActive: 2, maxWaiting: 4 })
    const slot = await admission.acquire(new AbortController().signal)

    expect(admission.active).toBe(1)
    slot.release()
    slot.release()
    slot.release()

    expect(admission.active).toBe(0)
  })
})

describe('giving up', () => {
  it('refuses an acquire whose client is already gone, and takes no slot', async () => {
    const admission = createAdmission()
    const controller = new AbortController()
    controller.abort()

    await expect(admission.acquire(controller.signal)).rejects.toBe(controller.signal.reason)
    expect(admission.active).toBe(0)
    expect(admission.waiting).toBe(0)
  })

  /*
   * Rejected with the signal's own reason, by identity. The route tells "the
   * client left" from "something is broken" by comparing against
   * `request.signal.reason`, and a lookalike error would break that.
   */
  it('rejects a waiting acquire with the signal reason itself', async () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4 })
    const held = pending(admission, 1)
    const controller = new AbortController()
    const waiting = admission.acquire(controller.signal)
    waiting.catch(() => {})

    await drain()
    controller.abort()

    await expect(waiting).rejects.toBe(controller.signal.reason)
    expect(admission.waiting).toBe(0)

    held[0]?.controller.abort()
  })

  it('gives the next permit to the next live waiter, not the one that left', async () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4 })
    const held = await admission.acquire(new AbortController().signal)

    const leaving = new AbortController()
    const abandoned = admission.acquire(leaving.signal)
    abandoned.catch(() => {})
    const survivor = admission.acquire(new AbortController().signal)

    await drain()
    expect(admission.waiting).toBe(2)

    leaving.abort()
    await expect(abandoned).rejects.toBe(leaving.signal.reason)
    expect(admission.waiting).toBe(1)

    held.release()
    await expect(survivor).resolves.toBeDefined()
    expect(admission.active).toBe(1)
    ;(await survivor).release()
  })

  /*
   * A client that leaves while its upload is already being decoded. The slot
   * must not come back on the disconnect: the work is not cancellable, libvips
   * is still holding the image, and freeing the permit would let a third
   * decode start beside two that are still running — which is the bound this
   * whole module exists to keep.
   */
  it('keeps the slot of an active upload whose client went away', async () => {
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4 })
    const leaving = new AbortController()
    const slot = await admission.acquire(leaving.signal)

    expect(admission.active).toBe(1)

    leaving.abort()
    await drain()

    // Unmoved: the work it was admitted for is still going on.
    expect(admission.active).toBe(1)

    // And the next one is still shut out, which is the observable half.
    const next = admission.acquire(new AbortController().signal)
    next.catch(() => {})
    await drain()
    expect(admission.waiting).toBe(1)

    // Only the work finishing returns it, and then exactly to zero.
    slot.release()
    await drain()
    expect(admission.active).toBe(1)
    expect(admission.waiting).toBe(0)
    ;(await next).release()
    expect(admission.active).toBe(0)
  })

  it('gives up waiting on its own deadline', async () => {
    vi.useFakeTimers()
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4, waitMs: 30_000 })
    const held = await admission.acquire(new AbortController().signal)
    const waiting = admission.acquire(new AbortController().signal)
    waiting.catch(() => {})

    await vi.advanceTimersByTimeAsync(29_999)
    expect(admission.waiting).toBe(1)

    await vi.advanceTimersByTimeAsync(2)

    await expect(waiting).rejects.toBeInstanceOf(UploadCapacityError)
    await expect(waiting).rejects.toMatchObject({ kind: 'timeout' })
    expect(admission.waiting).toBe(0)

    // And the permit it was waiting for is not spent on it afterwards.
    held.release()
    expect(admission.active).toBe(0)
  })

  it('cancels the deadline of a waiter it admits', async () => {
    vi.useFakeTimers()
    const admission = createAdmission({ maxActive: 1, maxWaiting: 4, waitMs: 1_000 })
    const held = await admission.acquire(new AbortController().signal)
    const waiting = admission.acquire(new AbortController().signal)

    held.release()
    const slot = await waiting

    // Long past the deadline it no longer has.
    await vi.advanceTimersByTimeAsync(5_000)

    expect(admission.active).toBe(1)
    slot.release()
    expect(admission.active).toBe(0)
  })
})
