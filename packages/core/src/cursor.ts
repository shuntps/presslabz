/**
 * Where a page stopped, said in a way a client cannot usefully take apart.
 *
 * A cursor names the last row of a page — its sort instant and its id — so the
 * next page asks for "what comes after this row" rather than "skip the first
 * fifty". The difference is not cosmetic. The admin's listing is sorted by
 * modification time, which is exactly the column that changes while somebody
 * reads the list: with an offset, one colleague saving a document pushes a row
 * across the page boundary and the reader sees it twice, or never. Against a
 * fixed row, the page after it is the same page whatever moved.
 *
 * The id breaks the tie, because two documents can carry the same instant and
 * a comparison on the instant alone would either repeat them or lose them.
 *
 * It is encoded rather than sent as two fields to say what it is: a token this
 * API issued, to be handed back unchanged. A client that decodes it and builds
 * its own is relying on something no version of this API promises.
 */

export interface Cursor {
  /** The sort column's value on the last row of the page. */
  readonly at: Date
  readonly id: string
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** base64url, so it survives a query string without being escaped. */
function toBase64Url(value: string): string {
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

function fromBase64Url(value: string): string | null {
  try {
    return atob(value.replaceAll('-', '+').replaceAll('_', '/'))
  } catch {
    return null
  }
}

export function encodeCursor(cursor: Cursor): string {
  return toBase64Url(`${cursor.at.toISOString()}|${cursor.id}`)
}

/**
 * Null for anything that is not a cursor this API would have issued.
 *
 * Callers answer 400 rather than falling back to the first page: a cursor that
 * cannot be read is a request nobody meant to make, and silently starting over
 * would show the reader page one while they were pressing "next".
 */
export function decodeCursor(value: string): Cursor | null {
  const decoded = fromBase64Url(value)
  if (decoded === null) return null

  const separator = decoded.lastIndexOf('|')
  if (separator === -1) return null

  const at = new Date(decoded.slice(0, separator))
  const id = decoded.slice(separator + 1)

  if (Number.isNaN(at.getTime()) || !UUID.test(id)) return null

  return { at, id }
}
