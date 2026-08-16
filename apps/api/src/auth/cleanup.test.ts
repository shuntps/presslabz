import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { startSessionSweep } from './cleanup.ts'

/*
 * The sweep takes its work as a function rather than a database handle, which
 * is what lets these run without one. Every property here is about the
 * schedule, not about SQL: whether it starts, survives a failure, stops when
 * told, and never runs on top of itself.
 */

function recorder() {
  return { info: vi.fn(), warn: vi.fn() }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startSessionSweep', () => {
  it('sweeps once at boot rather than waiting out the first interval', async () => {
    // An instance that restarts more often than the interval would otherwise
    // never clear anything at all.
    const sweep = vi.fn().mockResolvedValue(0)
    const sweeper = startSessionSweep({ sweep, log: recorder(), intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(0)
    expect(sweep).toHaveBeenCalledTimes(1)

    sweeper.stop()
  })

  it('keeps sweeping on the interval', async () => {
    const sweep = vi.fn().mockResolvedValue(0)
    const sweeper = startSessionSweep({ sweep, log: recorder(), intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(3000)
    expect(sweep).toHaveBeenCalledTimes(4)

    sweeper.stop()
  })

  it('reports only the sweeps that removed something', async () => {
    const log = recorder()
    const sweep = vi.fn().mockResolvedValueOnce(3).mockResolvedValue(0)
    const sweeper = startSessionSweep({ sweep, log, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(2000)

    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith({ removed: 3 }, expect.stringContaining('swept'))

    sweeper.stop()
  })

  it('survives a failed sweep and runs the next one', async () => {
    // A database blip must not stop an instance sweeping for the rest of its
    // life, and must not take the API down either.
    const log = recorder()
    const sweep = vi.fn().mockRejectedValueOnce(new Error('connection reset')).mockResolvedValue(0)
    const sweeper = startSessionSweep({ sweep, log, intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(sweep).toHaveBeenCalledTimes(2)

    sweeper.stop()
  })

  it('stops when told', async () => {
    const sweep = vi.fn().mockResolvedValue(0)
    const sweeper = startSessionSweep({ sweep, log: recorder(), intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(2)

    sweeper.stop()
    await vi.advanceTimersByTimeAsync(5000)
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('never runs on top of itself', async () => {
    /*
     * setInterval does not wait for an async callback. A sweep slower than the
     * interval would otherwise have a second started on top of it, and a
     * delete that is already struggling is the last thing to run twice at
     * once.
     */
    let release: (value: number) => void = () => {}
    const sweep = vi.fn().mockImplementation(
      () =>
        new Promise<number>((resolve) => {
          release = resolve
        }),
    )

    const sweeper = startSessionSweep({ sweep, log: recorder(), intervalMs: 1000 })

    await vi.advanceTimersByTimeAsync(5000)
    expect(sweep).toHaveBeenCalledTimes(1)

    release(0)
    await vi.advanceTimersByTimeAsync(1000)
    expect(sweep).toHaveBeenCalledTimes(2)

    sweeper.stop()
  })

  it('does not hold the process open', () => {
    /*
     * A container that will not exit is a deploy that hangs.
     *
     * Counting timers and watching stop() clear them would stay green with the
     * unref() removed, which makes it a test of the wrong thing. Node reports
     * the reference state directly, so the timer itself is asked.
     */
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const sweeper = startSessionSweep({
      sweep: vi.fn().mockResolvedValue(0),
      log: recorder(),
      intervalMs: 1000,
    })

    const timer = setIntervalSpy.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)

    sweeper.stop()
    expect(vi.getTimerCount()).toBe(0)
    setIntervalSpy.mockRestore()
  })
})
