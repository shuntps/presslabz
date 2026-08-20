import { type Cursor, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '@presslabz/core'
import { asc, desc, eq, inArray, or, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { contents } from '../schema/contents.ts'
import { media, mediaOrphans } from '../schema/media.ts'

export type MediaRow = typeof media.$inferSelect

/**
 * A rendition is one encoding of one asset. They live in `meta` rather than in
 * their own table because they are never queried, never listed and never
 * addressed on their own — they are read together, as a `<picture>` is
 * written, and a join for that would be a join for nothing.
 */
export interface Rendition {
  readonly key: string
  readonly contentType: string
  readonly byteSize: number
}

export interface MediaMeta {
  readonly renditions?: Record<string, Rendition>
  readonly originalName?: string
}

export interface CreateMediaInput {
  /** The primary rendition's object key. Others are listed in meta. */
  readonly storageKey: string
  readonly mimeType: string
  readonly byteSize: number
  readonly width: number
  readonly height: number
  readonly alt: Record<string, string>
  readonly meta: MediaMeta
  readonly uploadedById: string | null
}

export async function createMedia(db: Database, input: CreateMediaInput): Promise<MediaRow> {
  const rows = await db
    .insert(media)
    .values({ ...input, meta: input.meta as Record<string, unknown> })
    .returning()

  const created = rows[0]
  if (!created) throw new Error('Insert returned no row')
  return created
}

export interface ListMediaQuery {
  readonly limit?: number
  /** Where the previous page stopped; rows strictly after it are returned. */
  readonly after?: Cursor
}

/**
 * The library, newest first, one page at a time.
 *
 * Keyset rather than offset for the same reason the content listing uses one:
 * an upload landing while the picker is open shifts every offset by one, so
 * the reader scrolling to "load more" would be shown a row they have already
 * seen and never shown the one it displaced.
 */
export async function listMedia(db: Database, query: ListMediaQuery = {}): Promise<MediaRow[]> {
  const where = query.after
    ? sql`(${media.createdAt}, ${media.id}) < (${query.after.at.toISOString()}::timestamptz, ${query.after.id}::uuid)`
    : undefined

  return db
    .select()
    .from(media)
    .where(where)
    .orderBy(desc(media.createdAt), desc(media.id))
    .limit(Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(query.limit ?? DEFAULT_PAGE_SIZE))))
}

export async function findMediaById(db: Database, id: string): Promise<MediaRow | null> {
  const rows = await db.select().from(media).where(eq(media.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * Resolves several at once, because a document renders every image it holds
 * and asking per block is how a page ends up making twenty round trips.
 */
export async function findMediaByIds(db: Database, ids: readonly string[]): Promise<MediaRow[]> {
  if (ids.length === 0) return []
  return db
    .select()
    .from(media)
    .where(inArray(media.id, [...ids]))
}

/**
 * Returns the row it removed, so the caller can delete the objects it named.
 * The row goes first: an orphaned object costs storage, while an orphaned row
 * points at nothing and breaks every page that renders it.
 */
/**
 * Deletes the row and records every object it owned as an orphan, atomically.
 *
 * The two systems cannot share a transaction, so the delete is split: what
 * Postgres can promise happens together, and the object store is dealt with
 * afterwards by whoever called. Writing the orphans here rather than after the
 * delete is what makes a crash in between survivable — the bytes are always
 * listed somewhere before the row that named them is gone.
 */
export async function deleteMedia(db: Database, id: string): Promise<MediaRow | null> {
  return db.transaction(async (tx) => {
    const rows = await tx.delete(media).where(eq(media.id, id)).returning()
    const row = rows[0]
    if (!row) return null

    const keys = storageKeysOf(row)
    if (keys.length > 0) {
      await tx
        .insert(mediaOrphans)
        .values(keys.map((storageKey) => ({ storageKey, mediaId: row.id })))
        // A key already listed is one a previous delete failed to remove; the
        // sweep owns it either way, and its attempt count is worth keeping.
        .onConflictDoNothing({ target: mediaOrphans.storageKey })
    }

    return row
  })
}

export type MediaOrphanRow = typeof mediaOrphans.$inferSelect

/** The oldest orphans, for a sweep. */
export async function listOrphans(db: Database, limit = 100): Promise<MediaOrphanRow[]> {
  return db
    .select()
    .from(mediaOrphans)
    .orderBy(asc(mediaOrphans.createdAt))
    .limit(Math.min(500, Math.max(1, Math.trunc(limit))))
}

/** The object is gone; the record of it should be too. */
export async function forgetOrphan(db: Database, storageKey: string): Promise<void> {
  await db.delete(mediaOrphans).where(eq(mediaOrphans.storageKey, storageKey))
}

/**
 * The store refused. The count and the message stay on the row so a sweep that
 * never succeeds explains itself to whoever eventually looks.
 */
export async function recordOrphanFailure(
  db: Database,
  storageKey: string,
  reason: string,
): Promise<void> {
  await db
    .update(mediaOrphans)
    .set({
      attempts: sql`${mediaOrphans.attempts} + 1`,
      lastError: reason.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(mediaOrphans.storageKey, storageKey))
}

/** Objects written but never claimed by a row, so an upload can undo itself. */
export async function recordOrphans(
  db: Database,
  mediaId: string,
  keys: readonly string[],
): Promise<void> {
  if (keys.length === 0) return

  await db
    .insert(mediaOrphans)
    .values(keys.map((storageKey) => ({ storageKey, mediaId })))
    .onConflictDoNothing({ target: mediaOrphans.storageKey })
}

/** Every object key an asset owns, primary rendition included. */
export function storageKeysOf(row: MediaRow): string[] {
  const meta = row.meta as MediaMeta
  const renditions = Object.values(meta.renditions ?? {}).map((rendition) => rendition.key)
  return [...new Set([row.storageKey, ...renditions])]
}

export class MediaForbiddenError extends Error {
  constructor(message = 'Not allowed to edit this asset') {
    super(message)
    this.name = 'MediaForbiddenError'
  }
}

export interface PatchMediaAltOptions {
  /**
   * Consulted inside the transaction, against the locked row. Required rather
   * than optional: whether an actor may edit an asset depends on who owns it,
   * so a caller that does not answer this has not decided, and a repository
   * that let it skip the question would be the place the rule went missing.
   * Returning false aborts the transaction.
   */
  readonly authorize: (current: MediaRow) => boolean
}

/**
 * A patch, by locale. A string sets that language's description; `null`
 * removes it; a language the patch does not mention is left alone.
 */
export type AltPatch = Readonly<Record<string, string | null>>

/**
 * Alt text is the only thing about an asset a person edits after upload.
 *
 * **A patch, not a replacement.** Taking the whole map from a caller means
 * taking a snapshot with it: two people describing the same image in two
 * languages both send `{...whatever they last saw, theirs}`, and the second
 * write silently deletes the first. The merge happens here, against the row
 * this transaction has locked, so a language nobody touched survives a write
 * that started from a stale read of it.
 *
 * The row is locked from the read to the write, and the authorization decision
 * is made in between. Reading the owner, deciding, and then updating would be
 * deciding about a row that can change in the gap: `uploadedById` carries
 * `ON DELETE SET NULL`, so deleting the uploader's account rewrites this
 * column, and an asset that becomes owned by nobody needs `media:update:any`.
 * `FOR UPDATE` makes that account deletion wait rather than land underneath
 * the answer.
 *
 * Returns null when there is no such asset.
 */
export async function patchMediaAlt(
  db: Database,
  id: string,
  patch: AltPatch,
  options: PatchMediaAltOptions,
): Promise<MediaRow | null> {
  return db.transaction(async (tx) => {
    const locked = await tx.select().from(media).where(eq(media.id, id)).limit(1).for('update')

    const current = locked[0]
    if (!current) return null

    if (!options.authorize(current)) throw new MediaForbiddenError()

    const merged = { ...current.alt }
    for (const [locale, text] of Object.entries(patch)) {
      if (text === null) delete merged[locale]
      else merged[locale] = text
    }

    const rows = await tx
      .update(media)
      .set({ alt: merged, updatedAt: new Date() })
      .where(eq(media.id, id))
      .returning()

    return rows[0] ?? null
  })
}

export interface MediaReference {
  readonly id: string
  readonly type: string
  readonly locale: string
  readonly slug: string
  readonly title: string
  /** Where it is used: in the document's blocks, in its metadata, or both. */
  readonly where: readonly ('blocks' | 'meta')[]
}

/**
 * Which documents use an asset.
 *
 * Deleting media used to check nothing, so a page could lose its illustration
 * because somebody tidied the library — and the loss showed up as a hole in a
 * published article, not as an error anybody saw.
 *
 * Containment against the GIN indexes rather than reading every document: the
 * question is asked before every deletion, and an installation with ten
 * thousand documents should not scan them to answer it. Two predicates, since
 * an image block names the asset in `blocks` and a featured image names it in
 * `meta`.
 */
export async function findMediaReferences(
  db: Database,
  mediaId: string,
  limit = 20,
): Promise<MediaReference[]> {
  const inBlocks = sql`${contents.blocks} @> ${JSON.stringify([{ mediaId }])}::jsonb`
  const inMeta = sql`${contents.meta} @> ${JSON.stringify({ featuredMediaId: mediaId })}::jsonb`

  const rows = await db
    .select({
      id: contents.id,
      type: contents.type,
      locale: contents.locale,
      slug: contents.slug,
      title: contents.title,
      blocks: sql<boolean>`${inBlocks}`,
      meta: sql<boolean>`${inMeta}`,
    })
    .from(contents)
    .where(or(inBlocks, inMeta))
    .orderBy(asc(contents.title))
    .limit(Math.min(100, Math.max(1, Math.trunc(limit))))

  return rows.map((row) => ({
    id: row.id,
    type: row.type,
    locale: row.locale,
    slug: row.slug,
    title: row.title,
    where: [...(row.blocks ? (['blocks'] as const) : []), ...(row.meta ? (['meta'] as const) : [])],
  }))
}
