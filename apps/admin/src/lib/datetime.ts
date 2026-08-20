/**
 * The two conversions between a stored instant and what a `datetime-local`
 * field shows.
 *
 * They exist because the obvious thing is wrong in a way that looks right. A
 * stored value is a UTC instant — `2026-09-01T09:00:00.000Z` — and slicing the
 * first sixteen characters off it produces `2026-09-01T09:00`, which the field
 * accepts happily and the browser then reads as *local* time. Saving parses it
 * back as local and converts to UTC, so in America/Toronto an editor who
 * opened a document and pressed save without touching the date moved it four
 * hours. Nothing warned them; the field showed what looked like their time.
 *
 * So: the field shows the instant in the reader's own zone, and what they type
 * means their own zone. That is what a `datetime-local` field means to
 * everyone who has ever used one, and it needs no configuration to be true.
 * The alternative — one editorial timezone for the whole installation, which
 * is what the classic content managers do — is a setting, a migration and a
 * second conversion; it
 * would be worth it for a newsroom scheduling to the minute across countries,
 * and it is not what this is yet. The interface says which zone it is showing
 * so that the choice is visible rather than assumed.
 *
 * The conversions use the platform's own zone rules in both directions, so
 * daylight saving is handled by the same table the browser's clock uses rather
 * than by arithmetic here.
 */

const pad = (value: number): string => String(value).padStart(2, '0')

/**
 * A stored instant, as the local wall clock reads it.
 *
 * Returns '' for anything that is not a date, because the field's empty state
 * is "no publication date" and an invalid one must not be presented as a time.
 */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''

  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ''

  return (
    `${instant.getFullYear()}-${pad(instant.getMonth() + 1)}-${pad(instant.getDate())}` +
    `T${pad(instant.getHours())}:${pad(instant.getMinutes())}`
  )
}

/**
 * What the editor typed, as the instant it names.
 *
 * `new Date('2026-09-01T09:00')` is local by specification — a date-time
 * string with no offset is local, and the same string with a `Z` is not — so
 * this direction was already right. It is written down anyway, because the
 * rule is subtle enough that the next person to touch it would have to look it
 * up, and because a null for the empty field belongs in one place.
 */
export function fromLocalInput(value: string): string | null {
  if (value === '') return null

  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return null

  return instant.toISOString()
}

/**
 * The zone the field is showing, named the way the reader's system names it.
 *
 * Shown next to the field rather than assumed: an editor scheduling a post for
 * nine o'clock has to be able to see whose nine o'clock it is, and a colleague
 * in another country opening the same document sees a different number for the
 * same instant.
 */
export function localZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** The stored instant, spelled out, so the field's meaning is checkable. */
export function describeInstant(iso: string | null, locale: string): string {
  if (!iso) return ''

  const instant = new Date(iso)
  if (Number.isNaN(instant.getTime())) return ''

  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(instant)
}
