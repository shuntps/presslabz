import type { ResolvedMedia } from '@presslabz/blocks'
import {
  collectTags,
  contentListTag,
  contentTag,
  mediaTag,
  translationGroupTag,
} from '@presslabz/cache'
import type { AnyContentType } from '@presslabz/core'
import {
  type Ancestry,
  type ContentRow,
  countPublished,
  findMediaByIds,
  findPublishedBySlug,
  listPublished,
  resolveAncestry,
} from '@presslabz/db'
import type { Locale } from '@presslabz/i18n'
import { db } from '../db.ts'
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

export const PER_PAGE = 10

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
