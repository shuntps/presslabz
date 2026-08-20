import { type AnyContentType, type ContentTypeRegistry, isSlug } from '@presslabz/core'
import type { Locale } from '@presslabz/i18n'

/**
 * Where a URL points, decided from the declared content types rather than from
 * the shape of this directory.
 *
 * Astro routes are files, and there is exactly one catch-all under `[locale]`
 * on purpose: which segment a type lives under is part of its declaration, so
 * a `basePath` change — or a type a plugin declares in phase 4 — has to move
 * its URLs without anyone adding a file. Deriving the routes from the registry
 * is what makes "content types are declared in code" true of the public site
 * and not only of the API.
 */

export type ResolvedRoute =
  | { readonly kind: 'archive'; readonly type: AnyContentType }
  | {
      readonly kind: 'document'
      readonly type: AnyContentType
      readonly slug: string
      /** Every segment after the base path. One entry unless the type nests. */
      readonly path: readonly string[]
    }

/**
 * Splits a pathname into segments, refusing anything a slug could not be.
 *
 * The segments reach a database lookup and a cache key, so they are checked
 * against the pattern slugs are actually stored under instead of being
 * escaped later. An empty segment — the `//` in a path — is refused for the
 * same reason: it names no document and would make two URLs for one page.
 */
export function parseSegments(pathname: string): string[] | null {
  const segments = pathname.split('/').filter((segment) => segment !== '')
  return segments.every(isSlug) ? segments : null
}

export function resolveRoute(
  registry: ContentTypeRegistry,
  segments: readonly string[],
): ResolvedRoute | null {
  if (segments.length === 0) return null

  const [first, ...rest] = segments as [string, ...string[]]

  const prefixed = registry.all().find((type) => type.basePath !== '' && type.basePath === first)
  if (prefixed) return underType(prefixed, rest)

  // Whatever is left belongs to the type sitting at the locale root, if the
  // installation declares one. A site whose every type is prefixed simply has
  // nothing at `/en/about`, which is a 404 rather than a special case.
  const root = registry.all().find((type) => type.basePath === '')
  return root ? underType(root, segments) : null
}

function underType(type: AnyContentType, path: readonly string[]): ResolvedRoute | null {
  if (path.length === 0) {
    // A type at the root has no archive of its own: `/en` is the home page,
    // which is a different route with different content.
    return type.basePath === '' ? null : { kind: 'archive', type }
  }

  /*
   * A flat type gets exactly one segment. Accepting more would serve the same
   * post at `/en/blog/hello`, `/en/blog/anything/hello` and every path in
   * between — one document behind unlimited URLs, each of them a separate
   * cache entry and a separate thing for a search engine to index.
   */
  if (!type.hierarchical && path.length > 1) return null

  return { kind: 'document', type, slug: path[path.length - 1] as string, path }
}

/**
 * The type the home page lists.
 *
 * A placeholder with a stated rule rather than a hardcoded `post`: the first
 * type that is not at the locale root. Deciding what a home page *is* belongs
 * to a theme, which is the next piece of this phase; until one exists, the
 * site still has to answer `/en` with something, and answering it from the
 * registry keeps the type name out of the routing.
 */
export function primaryType(registry: ContentTypeRegistry): AnyContentType | undefined {
  return registry.all().find((type) => type.basePath !== '')
}

export function homePath(locale: Locale): string {
  return `/${locale}`
}

export function archivePath(locale: Locale, type: AnyContentType): string {
  return type.basePath === '' ? homePath(locale) : `/${locale}/${type.basePath}`
}

/** The one canonical URL of a document, given its ancestry. Root first. */
export function documentPath(
  locale: Locale,
  type: AnyContentType,
  slugs: readonly string[],
): string {
  const prefix = type.basePath === '' ? '' : `/${type.basePath}`
  return `/${locale}${prefix}/${slugs.join('/')}`
}

export const PAGE_PARAM = 'page'

/**
 * Refuses rather than clamps.
 *
 * `?page=0`, `?page=-1` and `?page=abc` are not requests for the first page:
 * they are links that are wrong somewhere, and answering all of them with page
 * one gives every archive an unbounded set of URLs that all return the same
 * HTML. A 404 says so once.
 */
export function parsePageNumber(value: string | null): number | null {
  if (value === null) return 1
  if (!/^[1-9][0-9]{0,4}$/.test(value)) return null
  return Number(value)
}

export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / perPage))
}

export function archivePageUrl(locale: Locale, type: AnyContentType, page: number): string {
  const base = archivePath(locale, type)
  return page <= 1 ? base : `${base}?${PAGE_PARAM}=${page}`
}
