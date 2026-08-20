import type { ResolvedMedia } from '@presslabz/blocks'
import {
  collectTags,
  contentListTag,
  contentTag,
  mediaTag,
  translationGroupTag,
} from '@presslabz/cache'
import { type AnyContentType, createBuiltinRegistry } from '@presslabz/core'
import {
  type Ancestry,
  type ContentRow,
  countPublished,
  findContentById,
  findMediaByIds,
  findPublishedBySlug,
  listPublished,
  listPublishedPaths,
  listPublishedTranslations,
  type PublishedPathRow,
  resolveAncestry,
} from '@presslabz/db'
import type { Locale } from '@presslabz/i18n'
import { db } from '../db.ts'
import { localeConfig } from '../env.ts'
import { mediaIdsIn, mediaResolver } from '../lib/media.ts'
import { pageCount } from '../lib/routes.ts'

/**
 * Every read the public site makes, and the only place cache tags are
 * recorded.
 *
 * Collecting them here rather than in the pages is what lets a theme render
 * whatever it likes without declaring anything: a tag is added because a row
 * was read, not because somebody remembered. Outside a render — a script, the
 * uncached preview — collecting is a no-op, so these functions are the same
 * functions everywhere.
 */

const PER_PAGE = 10

export interface Archive {
  readonly rows: readonly ContentRow[]
  readonly page: number
  readonly pageCount: number
  readonly total: number
}

export async function loadArchive(options: {
  readonly type: AnyContentType
  readonly locale: Locale
  readonly page: number
  readonly perPage?: number
}): Promise<Archive> {
  const perPage = options.perPage ?? PER_PAGE
  const now = new Date()

  /*
   * One tag for the whole listing. Publishing anything of this type in this
   * language changes what every page of the archive shows — including the
   * pages that do not contain the new document, because it pushed one off the
   * end of each of them.
   */
  collectTags(contentListTag(options.type.name, options.locale))

  const [rows, total] = await Promise.all([
    listPublished(db, {
      type: options.type.name,
      locale: options.locale,
      now,
      limit: perPage,
      offset: (options.page - 1) * perPage,
    }),
    countPublished(db, { type: options.type.name, locale: options.locale, now }),
  ])

  for (const row of rows) collectTags(contentTag(row.id))

  return { rows, total, page: options.page, pageCount: pageCount(total, perPage) }
}

export async function loadDocument(options: {
  readonly type: AnyContentType
  readonly locale: Locale
  readonly slug: string
}): Promise<ContentRow | null> {
  const row = await findPublishedBySlug(db, {
    type: options.type.name,
    locale: options.locale,
    slug: options.slug,
  })

  if (!row) return null

  collectTags(contentTag(row.id), translationGroupTag(row.translationGroupId))
  return row
}

/** The ancestor chain a canonical URL is built from. Null for a flat type. */
export async function loadAncestry(
  row: ContentRow,
  type: AnyContentType,
): Promise<Ancestry | null> {
  if (!type.hierarchical) return null
  return resolveAncestry(db, { id: row.id, type: type.name, locale: row.locale })
}

/**
 * Every asset a document's blocks reference, resolved once.
 *
 * Resolved here rather than by the theme, because a theme that could turn a
 * media id into a URL is a theme that has to know where media lives — and
 * because the tags below are what make an alt-text edit reach the pages that
 * display the image. Rendering is the theme's; knowing what to render is not.
 */
export async function loadMedia(
  row: ContentRow,
  locale: Locale,
): Promise<ReadonlyMap<string, ResolvedMedia>> {
  const ids = mediaIdsIn(row.blocks)
  if (ids.length === 0) return new Map()

  const rows = await findMediaByIds(db, ids)
  for (const media of rows) collectTags(mediaTag(media.id))

  const resolve = mediaResolver(rows, locale)
  const resolved = new Map<string, ResolvedMedia>()
  for (const id of ids) {
    const media = resolve(id)
    if (media) resolved.set(id, media)
  }

  return resolved
}

export interface Sibling {
  readonly row: ContentRow
  /** Root first, its own slug last. Null when its path cannot be resolved. */
  readonly path: readonly string[] | null
}

/**
 * The published translations of a document, each with the path it is reachable
 * at.
 *
 * A sibling whose ancestry cannot be resolved is returned with a null path and
 * dropped by the caller rather than advertised at a guessed URL: an hreflang
 * that answers 404 is worse than a missing one, because a search engine
 * follows it and a reader switching language lands on nothing.
 */
export async function loadTranslations(row: ContentRow, type: AnyContentType): Promise<Sibling[]> {
  collectTags(translationGroupTag(row.translationGroupId))

  const siblings = await listPublishedTranslations(db, {
    translationGroupId: row.translationGroupId,
  })

  return Promise.all(
    siblings.map(async (sibling) => {
      collectTags(contentTag(sibling.id))

      if (!type.hierarchical) return { row: sibling, path: [sibling.slug] }

      const ancestry = await resolveAncestry(db, {
        id: sibling.id,
        type: type.name,
        locale: sibling.locale,
      })

      return { row: sibling, path: ancestry?.complete ? ancestry.slugs : null }
    }),
  )
}

/**
 * Every publicly visible document, with its path. For the sitemap, which is
 * the one page that has to know about all of them at once.
 */
export async function loadEveryPublishedPath(): Promise<PublishedPathRow[]> {
  // Every list of every type in every language: publishing anything changes
  // this page, and there is no narrower tag that would be true.
  for (const type of createBuiltinRegistry().all()) {
    for (const locale of localeConfig.locales) collectTags(contentListTag(type.name, locale))
  }

  return listPublishedPaths(db, {})
}

/**
 * The assets referenced by a set of documents, in one query rather than one
 * per document. A feed renders twenty entries; twenty round trips for their
 * images is the difference between a feed and a load test.
 */
export async function loadMediaForMany(
  rows: readonly ContentRow[],
  locale: Locale,
): Promise<ReadonlyMap<string, ResolvedMedia>> {
  const ids = [...new Set(rows.flatMap((row) => mediaIdsIn(row.blocks)))]
  if (ids.length === 0) return new Map()

  const media = await findMediaByIds(db, ids)
  for (const asset of media) collectTags(mediaTag(asset.id))

  const resolve = mediaResolver(media, locale)
  const resolved = new Map<string, ResolvedMedia>()
  for (const id of ids) {
    const asset = resolve(id)
    if (asset) resolved.set(id, asset)
  }

  return resolved
}

/**
 * A document by id, whatever its status. Only ever reached with a valid
 * preview token, which is the authorization — nothing here checks one, and
 * nothing else in this module can return an unpublished row.
 */
export async function loadForPreview(id: string): Promise<ContentRow | null> {
  return findContentById(db, id)
}
