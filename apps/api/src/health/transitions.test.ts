import { describe, expect, it, vi } from 'vitest'
import { reportChanges } from './transitions.ts'

/*
 * A load balancer calls /health every few seconds. A probe that logged its own
 * result would write the same line thousands of times an hour — and the lines
 * nobody reads are what hide the ones that matter.
 */
const logger = () => ({ warn: vi.fn(), info: vi.fn() })

describe('reporting a dependency that changes state', () => {
  it('says nothing at all while a healthy thing stays healthy', () => {
    const log = logger()
    const report = reportChanges(log, 'storage')

    report('up', 'ok', 'fine')
    report('up', 'ok', 'fine')
    report('up', 'ok', 'fine')

    expect(log.warn).not.toHaveBeenCalled()
    expect(log.info).not.toHaveBeenCalled()
  })

  it('warns once when it breaks, however many times it is asked', () => {
    const log = logger()
    const report = reportChanges(log, 'storage')

    for (let i = 0; i < 50; i++) report('down', 'unreachable', 'the store is not answering')

    expect(log.warn).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'storage' }),
      'the store is not answering',
    )
  })

  it('says so again when the state changes', () => {
    const log = logger()
    const report = reportChanges(log, 'storage')

    report('down', 'unreachable', 'nothing answered')
    report('degraded', 'forbidden', 'readers cannot fetch it')

    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  /*
   * The regression this exists for. Keyed on `down` alone, a store that went
   * from "there is no bucket" to "your credentials are refused" looked like
   * the same outage continuing and the second sentence was never written —
   * and those are two different jobs: one says run the installation command,
   * the other says the key is wrong.
   */
  it('says so again when the state holds and the cause changes', () => {
    const log = logger()
    const report = reportChanges(log, 'storage')

    report('down', 'missing', 'there is no such bucket')
    report('down', 'missing', 'there is no such bucket')
    report('down', 'denied', 'the store refused these credentials')

    expect(log.warn).toHaveBeenCalledTimes(2)
    expect(log.warn).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: 'down/missing', cause: 'denied', suppressed: 1 }),
      'the store refused these credentials',
    )
  })

  /*
   * The count is what turns "it recovered" into "it recovered after 402
   * checks", which is the difference between a note and a measurement.
   */
  it('reports a recovery, and how long it was out', () => {
    const log = logger()
    const report = reportChanges(log, 'storage')

    report('down', 'unreachable', 'gone')
    for (let i = 0; i < 9; i++) report('down', 'unreachable', 'gone')
    report('up', 'ok', 'back')

    expect(log.info).toHaveBeenCalledTimes(1)
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'down/unreachable', suppressed: 9 }),
      'back',
    )
  })
})
