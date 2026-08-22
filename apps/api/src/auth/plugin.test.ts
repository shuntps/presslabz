import { capabilitiesFor, DEFAULT_ROLE } from '@presslabz/core'
import type { UserRow } from '@presslabz/db'
import { DEFAULT_LOCALE } from '@presslabz/i18n'
import { describe, expect, it, vi } from 'vitest'
import {
  CORRECTION_MEMORY_LIMIT,
  createCorrectionMemory,
  reportSessionCorrections,
  sessionCorrections,
  toAuthenticatedUser,
} from './plugin.ts'

/*
 * The defence against a row the database would no longer accept: a restore
 * from before the CHECK constraints, or a value written in psql. No database
 * here — the three functions below are pure, and the behaviour worth pinning
 * is what they do with a row, not how the row got that way.
 */

let seed = 0

function row(overrides: Partial<UserRow> = {}): UserRow {
  seed += 1

  return {
    id: `00000000-0000-4000-8000-${String(seed).padStart(12, '0')}`,
    email: 'someone@presslabz.test',
    passwordHash: null,
    displayName: 'Someone',
    role: 'editor',
    locale: 'en',
    themePreference: 'dark',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as UserRow
}

describe('normalising a stored row', () => {
  it('passes a row that is already inside the vocabularies through unchanged', () => {
    const stored = row()
    const user = toAuthenticatedUser(stored)

    expect(user).toMatchObject({
      id: stored.id,
      email: stored.email,
      displayName: stored.displayName,
      role: 'editor',
      locale: 'en',
      themePreference: 'dark',
    })
  })

  it('falls back to the least privilege for an unknown role', () => {
    const user = toAuthenticatedUser(row({ role: 'superuser' as never }))

    expect(user.role).toBe(DEFAULT_ROLE)
    // Not the stored label's capabilities, and not an empty list either: the
    // capabilities of the role it fell back to.
    expect(user.capabilities).toEqual(capabilitiesFor(DEFAULT_ROLE))
  })

  it('falls back to the product default for an unknown language', () => {
    expect(toAuthenticatedUser(row({ locale: 'de' as never })).locale).toBe(DEFAULT_LOCALE)
  })

  it('falls back to following the system for an unknown theme', () => {
    expect(toAuthenticatedUser(row({ themePreference: 'neon' as never })).themePreference).toBe(
      'system',
    )
  })

  it('corrects three wrong fields at once rather than failing on the first', () => {
    const user = toAuthenticatedUser(
      row({ role: 'wizard' as never, locale: 'de' as never, themePreference: 'neon' as never }),
    )

    expect(user).toMatchObject({
      role: DEFAULT_ROLE,
      locale: DEFAULT_LOCALE,
      themePreference: 'system',
    })
  })

  it('never carries the password hash into a session payload', () => {
    const user = toAuthenticatedUser(row({ passwordHash: '$argon2id$v=19$whatever' }))
    expect(JSON.stringify(user)).not.toMatch(/argon|passwordHash/i)
  })
})

describe('saying what was corrected', () => {
  it('says nothing about a row that needed nothing', () => {
    expect(sessionCorrections(row())).toEqual([])
  })

  it('names each field it had to correct', () => {
    const corrections = sessionCorrections(
      row({ role: 'wizard' as never, themePreference: 'neon' as never }),
    )

    expect(corrections.map((correction) => correction.field)).toEqual(['role', 'themePreference'])
    expect(corrections.map((correction) => correction.stored)).toEqual(['wizard', 'neon'])
  })

  /*
   * A stored value is text of any length, and this one goes into a log line
   * that an operator reads. Forty characters is enough to recognise what is in
   * the column; the whole column is a payload somebody else chose.
   */
  it('bounds the value it reports', () => {
    const [correction] = sessionCorrections(row({ role: 'x'.repeat(4000) as never }))

    expect(correction?.stored).toHaveLength(41)
    expect(correction?.stored.endsWith('…')).toBe(true)
  })
})

describe('reporting corrections to the log', () => {
  const fakeLog = () => ({ warn: vi.fn() })

  it('writes nothing for a row that is inside the vocabularies', () => {
    const log = fakeLog()
    reportSessionCorrections(log, row())
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('names the account and the field, and never the whole row', () => {
    const log = fakeLog()
    const stored = row({ role: 'superuser' as never, email: 'private@presslabz.test' })

    reportSessionCorrections(log, stored)

    expect(log.warn).toHaveBeenCalledTimes(1)
    const [context] = log.warn.mock.calls[0] as [Record<string, unknown>, string]
    expect(context).toEqual({ userId: stored.id, field: 'role', stored: 'superuser' })
    // The address is what makes a log line about a person rather than a row.
    expect(JSON.stringify(context)).not.toContain('private@presslabz.test')
  })

  /*
   * The reason this is not simply called from `toAuthenticatedUser`: that runs
   * on every authenticated request, the interface polls the session once a
   * minute per open tab, and a row nobody repairs would write a line every
   * time. One line per account and field while the memory holds the pair —
   * an evicted pair is reported again, which the eviction tests below pin.
   */
  it('writes one line per account and field, however many times it is asked', () => {
    const log = fakeLog()
    const stored = row({ role: 'superuser' as never, locale: 'de' as never })

    for (let call = 0; call < 50; call += 1) reportSessionCorrections(log, stored)

    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('still reports a second account with the same wrong value', () => {
    const log = fakeLog()

    reportSessionCorrections(log, row({ role: 'superuser' as never }))
    reportSessionCorrections(log, row({ role: 'superuser' as never }))

    expect(log.warn).toHaveBeenCalledTimes(2)
  })

  it('still reports a second field of an account already reported on', () => {
    const log = fakeLog()
    const id = '00000000-0000-4000-8000-0000000000ff'

    reportSessionCorrections(log, row({ id, role: 'superuser' as never }))
    reportSessionCorrections(log, row({ id, role: 'superuser' as never, locale: 'de' as never }))

    expect(log.warn).toHaveBeenCalledTimes(2)
    expect((log.warn.mock.calls[1] as [{ field: string }, string])[0].field).toBe('locale')
  })
})

/*
 * The deduplication has to bound its own memory, not only the log.
 *
 * The first version was a plain Set, which never wrote a duplicate line and
 * never gave a byte back: one entry per account and field, added by whatever
 * rows the database happened to hold, kept until the process died. That is a
 * leak whose size is decided by data rather than by this file — and on a large
 * installation restored from an old backup, decided by the worst case.
 */
describe('the memory the deduplication keeps', () => {
  it('refuses a capacity that is not a positive whole number', () => {
    expect(() => createCorrectionMemory(0)).toThrow(RangeError)
    expect(() => createCorrectionMemory(-1)).toThrow(RangeError)
    expect(() => createCorrectionMemory(1.5)).toThrow(RangeError)
    expect(() => createCorrectionMemory(Number.NaN)).toThrow(RangeError)
  })

  it('answers true the first time and false while it still remembers', () => {
    const memory = createCorrectionMemory(4)

    expect(memory.remember('a')).toBe(true)
    expect(memory.remember('a')).toBe(false)
    expect(memory.remember('a')).toBe(false)
    expect(memory.size).toBe(1)
  })

  /* The bound, asserted against a load far past it rather than argued for. */
  it('never holds more than its capacity, however many keys it is given', () => {
    const memory = createCorrectionMemory(50)

    for (let key = 0; key < 100_000; key += 1) {
      memory.remember(`user-${key}:role`)
      expect(memory.size).toBeLessThanOrEqual(50)
    }

    expect(memory.size).toBe(50)
  })

  /*
   * Deterministic, and stated: oldest first. Not an LRU — an LRU is just as
   * bounded, but a key that kept being seen would keep renewing its slot and
   * stay silent indefinitely, and for a warning the occasional repeat is
   * better than a permanent hush.
   */
  it('evicts the oldest key, not the least recently seen', () => {
    const memory = createCorrectionMemory(2)

    memory.remember('first')
    memory.remember('second')
    // Seeing 'first' again must not move it to the back of the queue.
    expect(memory.remember('first')).toBe(false)

    memory.remember('third')

    // 'first' was the oldest, so it is the one that went.
    expect(memory.remember('first')).toBe(true)
    expect(memory.remember('third')).toBe(false)
  })

  it('is a bound on the silence too: an evicted account is reported again', () => {
    const log = { warn: vi.fn() }
    const memory = createCorrectionMemory(1)
    const one = row({ role: 'superuser' as never })
    const other = row({ role: 'superuser' as never })

    reportSessionCorrections(log, one, memory)
    reportSessionCorrections(log, one, memory)
    expect(log.warn).toHaveBeenCalledTimes(1)

    // Pushes the first one out.
    reportSessionCorrections(log, other, memory)
    reportSessionCorrections(log, one, memory)

    expect(log.warn).toHaveBeenCalledTimes(3)
  })

  it('deduplicates as expected while staying inside the bound', () => {
    const log = { warn: vi.fn() }
    const memory = createCorrectionMemory(10)
    const people = Array.from({ length: 10 }, () => row({ role: 'superuser' as never }))

    for (let pass = 0; pass < 20; pass += 1) {
      for (const person of people) reportSessionCorrections(log, person, memory)
    }

    // Ten accounts, one line each, two hundred calls.
    expect(log.warn).toHaveBeenCalledTimes(10)
    expect(memory.size).toBe(10)
  })

  it('is what the plugin actually uses, at a capacity this file declares', () => {
    // The default memory is not reachable from here on purpose; what is
    // asserted is that the number the production instance is built with is a
    // real bound and not something like Infinity.
    expect(Number.isSafeInteger(CORRECTION_MEMORY_LIMIT)).toBe(true)
    expect(CORRECTION_MEMORY_LIMIT).toBeGreaterThan(0)
    expect(CORRECTION_MEMORY_LIMIT).toBeLessThanOrEqual(10_000)
  })
})
