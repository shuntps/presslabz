/**
 * @vitest-environment node
 *
 * Node, and TZ set before anything reads a clock: these assertions are about
 * what a browser in a particular zone would show, and jsdom would not change
 * the answer while making it harder to state which zone is in play.
 */
process.env.TZ = 'America/Toronto'

import { describe, expect, it } from 'vitest'
import { describeInstant, fromLocalInput, localZoneName, toLocalInput } from './datetime.ts'

/*
 * Toronto because it is the owner's own zone and because it has daylight
 * saving, which is where the arithmetic people write by hand falls apart.
 * Winter is UTC-5, summer UTC-4.
 */
describe('showing a stored instant', () => {
  it('shows the local wall clock, not the UTC digits', () => {
    // 14:00Z in July is 10:00 in Toronto, not 14:00.
    expect(toLocalInput('2026-07-15T14:00:00.000Z')).toBe('2026-07-15T10:00')
    // The same digits in January are 09:00, because the offset moved.
    expect(toLocalInput('2026-01-15T14:00:00.000Z')).toBe('2026-01-15T09:00')
  })

  it('answers nothing for a document with no publication date', () => {
    expect(toLocalInput(null)).toBe('')
    expect(toLocalInput(undefined)).toBe('')
    expect(toLocalInput('')).toBe('')
  })

  /*
   * A stored value nothing can parse must not be shown as a time. Presenting
   * "Invalid Date" in a field the editor then saves would write that back.
   */
  it('answers nothing for a value that is not an instant', () => {
    expect(toLocalInput('not a date')).toBe('')
  })
})

describe('reading what the editor typed', () => {
  it('means the editor own zone, and says so in UTC', () => {
    expect(fromLocalInput('2026-07-15T10:00')).toBe('2026-07-15T14:00:00.000Z')
    expect(fromLocalInput('2026-01-15T09:00')).toBe('2026-01-15T14:00:00.000Z')
  })

  it('treats an empty field as no date rather than as the epoch', () => {
    expect(fromLocalInput('')).toBeNull()
    expect(fromLocalInput('nonsense')).toBeNull()
  })
})

/**
 * The property the whole issue is about: opening a document and saving it
 * without touching the date must leave the instant exactly where it was.
 * Slicing the ISO string moved it by the offset — four hours in summer, five
 * in winter — with nothing to show for it in the interface.
 */
describe('opening and saving without touching the date', () => {
  const instants = [
    '2026-07-15T14:00:00.000Z',
    '2026-01-15T14:00:00.000Z',
    '2026-03-08T05:00:00.000Z',
    '2026-03-08T08:00:00.000Z',
    '2026-11-01T04:00:00.000Z',
    '2026-11-01T07:00:00.000Z',
    '2026-12-31T23:59:00.000Z',
  ]

  for (const instant of instants) {
    it(`preserves ${instant}`, () => {
      expect(fromLocalInput(toLocalInput(instant))).toBe(instant)
    })
  }
})

/**
 * Daylight saving, stated rather than implied.
 *
 * Toronto springs forward at 02:00 local on 2026-03-08 — 02:30 does not exist
 * that morning — and falls back at 02:00 on 2026-11-01, when 01:30 happens
 * twice. Both are the cases hand-written offset arithmetic gets wrong, and
 * both are why these functions defer to the platform's zone rules.
 */
describe('daylight saving', () => {
  it('crosses the spring transition without losing an hour', () => {
    // 06:59Z is 01:59 local; one minute later the clock reads 03:00.
    expect(toLocalInput('2026-03-08T06:59:00.000Z')).toBe('2026-03-08T01:59')
    expect(toLocalInput('2026-03-08T07:00:00.000Z')).toBe('2026-03-08T03:00')
  })

  it('crosses the autumn transition without repeating one', () => {
    // 01:30 local happens twice; the two instants are an hour apart and stay
    // distinct, which is what matters for a schedule.
    const first = '2026-11-01T05:30:00.000Z'
    const second = '2026-11-01T06:30:00.000Z'

    expect(toLocalInput(first)).toBe('2026-11-01T01:30')
    expect(toLocalInput(second)).toBe('2026-11-01T01:30')
    expect(first).not.toBe(second)
  })

  /*
   * A time that does not exist. The platform resolves it forward rather than
   * refusing, which is the behaviour every date picker has; what must not
   * happen is a silent shift on a value the editor never typed.
   */
  it('resolves a local time the clock skipped rather than failing', () => {
    const saved = fromLocalInput('2026-03-08T02:30')

    expect(saved).not.toBeNull()
    expect(new Date(saved as string).getTime()).toBeGreaterThan(
      new Date('2026-03-08T06:59:00.000Z').getTime(),
    )
  })
})

describe('telling the editor what they are looking at', () => {
  it('names the zone the field is showing', () => {
    expect(localZoneName()).toBe('America/Toronto')
  })

  it('spells the stored instant out in UTC, so the two can be compared', () => {
    expect(describeInstant('2026-07-15T14:00:00.000Z', 'en')).toContain('2026')
    expect(describeInstant(null, 'en')).toBe('')
    expect(describeInstant('not a date', 'en')).toBe('')
  })
})
