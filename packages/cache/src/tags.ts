/**
 * The vocabulary both halves of invalidation share.
 *
 * A tag is built here or not at all. The alternative — the site writing
 * `content:${id}` while the API purges `contents:${id}` — is a cache that
 * looks like it works, because a miss is invisible and a stale page is only
 * ever noticed by a reader.
 */

/**
 * A namespace and an identifier. The namespace is what makes a tag readable in
 * a Valkey key listing during an incident; the identifier is deliberately
 * permissive about case because uuids and locale codes both appear in it.
 */
const TAG_PATTERN = /^[a-z][a-z0-9-]*:[A-Za-z0-9:_-]{1,192}$/

export function isTag(value: string): boolean {
  return TAG_PATTERN.test(value)
}

/**
 * Refuses rather than sanitises. A tag is assembled from values the caller
 * already holds — an id, a type name, a locale — so a value that does not fit
 * the pattern is a bug at the call site, and quietly rewriting it would give
 * the site and the API two different names for the same content.
 */
export function assertTag(tag: string): string {
  if (!isTag(tag)) throw new Error(`Not a usable cache tag: ${JSON.stringify(tag)}`)
  return tag
}

/** One document, in one language. Its own row and nothing else. */
export function contentTag(id: string): string {
  return assertTag(`content:${id}`)
}

/**
 * Every listing of a type in a language: the archive, the home page, the feed.
 * Publishing a document changes the lists it belongs to as much as it changes
 * its own page, and the list pages have no way to know that on their own.
 */
export function contentListTag(type: string, locale: string): string {
  return assertTag(`list:${type}:${locale}`)
}

/**
 * A translation group. Publishing a French translation changes what the
 * English page announces in `hreflang` and offers in its language switcher,
 * even though the English row itself was not touched.
 */
export function translationGroupTag(id: string): string {
  return assertTag(`group:${id}`)
}

/**
 * An asset. Alt text is part of the rendered page, so editing it has to reach
 * every page whose blocks reference the asset.
 */
export function mediaTag(id: string): string {
  return assertTag(`media:${id}`)
}
