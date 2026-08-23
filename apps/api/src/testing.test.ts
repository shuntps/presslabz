import { describe, expect, it } from 'vitest'
import { closeThenRestore, withCleanup } from './testing.ts'

/*
 * The order a suite's end depends on, stated rather than inherited.
 *
 * Two `afterAll` hooks would not do: Vitest runs them in `stack` order, so the
 * one declared second runs first — measured with a third hook that observed
 * the other two had not run. A suite closing resources in one hook and
 * restoring the environment in the next was restoring first.
 */
describe('the end of a suite', () => {
  it('closes everything before it puts the environment back', async () => {
    const seen: string[] = []

    await closeThenRestore(
      [
        () => {
          seen.push(`close-1 saw ${process.env.PROBE_VALUE}`)
        },
        async () => {
          seen.push(`close-2 saw ${process.env.PROBE_VALUE}`)
        },
      ],
      () => {
        seen.push('restore')
      },
    )

    // Both closes ran, in order, and the restore came last.
    expect(seen).toEqual(['close-1 saw undefined', 'close-2 saw undefined', 'restore'])
  })

  it('lets a close observe the substituted values, and restores them afterwards', async () => {
    const original = process.env.PROBE_VALUE
    const duringClose: (string | undefined)[] = []

    // Substituted the way a suite does, and put back by the restore below.
    process.env.PROBE_VALUE = 'substituted'

    await closeThenRestore([() => duringClose.push(process.env.PROBE_VALUE)], () => {
      if (original === undefined) delete process.env.PROBE_VALUE
      else process.env.PROBE_VALUE = original
    })

    expect(duringClose).toEqual(['substituted'])
    expect(process.env.PROBE_VALUE).toBe(original)
  })

  it('still restores when a close fails, and raises the failure', async () => {
    let restored = false
    const boom = new Error('a connection refused to close')

    await expect(
      closeThenRestore(
        [
          () => {
            throw boom
          },
        ],
        () => {
          restored = true
        },
      ),
    ).rejects.toBe(boom)

    // The point: a broken close does not strand the environment.
    expect(restored).toBe(true)
  })

  it('attempts every step even after one throws', async () => {
    const ran: string[] = []

    await expect(
      closeThenRestore(
        [
          () => {
            ran.push('first')
            throw new Error('first failed')
          },
          () => {
            ran.push('second')
          },
        ],
        () => ran.push('restore'),
      ),
    ).rejects.toThrow('first failed')

    // A step that did not run is a resource nobody closed.
    expect(ran).toEqual(['first', 'second', 'restore'])
  })

  /*
   * The shape a scenario standing up a second application needs. Tested here
   * rather than by breaking a real Fastify close: proving that a failed close
   * still lets the sweep and the restore happen needs a close that fails, and
   * seaming one into the app to obtain it would add production surface for a
   * test's benefit.
   */
  it('sweeps and restores even when closing the instance fails', async () => {
    const done: string[] = []
    const closeFailed = new Error('the instance refused to close')

    await expect(
      withCleanup(
        async () => {
          done.push('body')
        },
        [
          () => {
            done.push('close')
            throw closeFailed
          },
          () => {
            done.push('sweep')
          },
        ],
        () => done.push('restore'),
      ),
    ).rejects.toBe(closeFailed)

    // The Valkey sweep and the environment both happened anyway.
    expect(done).toEqual(['body', 'close', 'sweep', 'restore'])
  })

  it('cleans up when the body throws before anything else could', async () => {
    const done: string[] = []
    const readyFailed = new Error('ready() never came back')

    await expect(
      withCleanup(
        async () => {
          throw readyFailed
        },
        [() => done.push('close'), () => done.push('sweep')],
        () => done.push('restore'),
      ),
    ).rejects.toBe(readyFailed)

    // A failure before the assertions still gets the instance closed.
    expect(done).toEqual(['close', 'sweep', 'restore'])
  })

  it('keeps the body error in front when the cleanup failed too', async () => {
    const bodyFailed = new Error('the scenario failed')

    const raised = withCleanup(
      async () => {
        throw bodyFailed
      },
      [
        () => {
          throw new Error('close failed')
        },
      ],
      () => {
        throw new Error('restore failed')
      },
    )

    await expect(raised).rejects.toThrow(AggregateError)
    const error = (await raised.catch((each: unknown) => each)) as AggregateError
    expect(error.errors[0]).toBe(bodyFailed)
    expect(error.errors.map((each: Error) => each.message)).toEqual([
      'the scenario failed',
      'close failed',
      'restore failed',
    ])
  })

  it('hands back what the body returned when nothing failed', async () => {
    const done: string[] = []

    await expect(
      withCleanup(
        async () => 'the answer',
        [() => done.push('close')],
        () => done.push('restore'),
      ),
    ).resolves.toBe('the answer')

    expect(done).toEqual(['close', 'restore'])
  })

  it('keeps every failure visible rather than the first one only', async () => {
    const failure = closeThenRestore(
      [
        () => {
          throw new Error('close failed')
        },
      ],
      () => {
        throw new Error('restore failed')
      },
    )

    await expect(failure).rejects.toThrow(AggregateError)
    await expect(failure).rejects.toThrow('failed to clean up')
    const error = await failure.catch((raised: AggregateError) => raised)
    expect((error as AggregateError).errors.map((each: Error) => each.message)).toEqual([
      'close failed',
      'restore failed',
    ])
  })
})
