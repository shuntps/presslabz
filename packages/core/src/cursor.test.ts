import { describe, expect, it } from 'vitest'
import { type Cursor, decodeCursor, encodeCursor } from './cursor.ts'

const cursor: Cursor = {
  at: new Date('2026-08-20T14:30:00.000Z'),
  id: '0f4d1c3e-6b2a-4d8f-9c1e-5a7b3d2e8f10',
}

describe('a cursor round trip', () => {
  it('comes back as the row it named', () => {
    const decoded = decodeCursor(encodeCursor(cursor))

    expect(decoded?.at.toISOString()).toBe(cursor.at.toISOString())
    expect(decoded?.id).toBe(cursor.id)
  })

  it('keeps the millisecond', () => {
    // Truncating to the second would make two rows saved in the same second
    // compare equal, which is the tie the id exists to break — and it would
    // break it against the wrong instant.
    const precise = { at: new Date('2026-08-20T14:30:00.123Z'), id: cursor.id }

    expect(decodeCursor(encodeCursor(precise))?.at.toISOString()).toBe('2026-08-20T14:30:00.123Z')
  })

  it('survives a query string without being escaped', () => {
    const encoded = encodeCursor(cursor)

    expect(encoded).toBe(encodeURIComponent(encoded))
    expect(encoded).not.toContain('=')
  })
})

describe('anything this API did not issue', () => {
  /*
   * Refused rather than repaired. A caller answers 400 to these: a cursor that
   * cannot be read is a request nobody meant to make, and quietly starting
   * over would show somebody page one while they were pressing "next".
   */
  it.for([
    ['empty', ''],
    ['not base64', 'not a cursor!!'],
    ['base64 of nothing useful', btoa('hello')],
    ['no separator', btoa('2026-08-20T14:30:00.000Zabc')],
    ['an instant that is not one', btoa(`the day before|${cursor.id}`)],
    ['an id that is not one', btoa('2026-08-20T14:30:00.000Z|../../etc/passwd')],
    ['an id that is nearly one', btoa('2026-08-20T14:30:00.000Z|0f4d1c3e-6b2a-4d8f-9c1e')],
  ])('is not a cursor: %s', ([, value]) => {
    expect(decodeCursor(value as string)).toBeNull()
  })
})
