import { desc, eq, inArray } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { media } from '../schema/media.ts'

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

export async function listMedia(db: Database, limit = 60, offset = 0): Promise<MediaRow[]> {
  return db.select().from(media).orderBy(desc(media.createdAt)).limit(limit).offset(offset)
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
export async function deleteMedia(db: Database, id: string): Promise<MediaRow | null> {
  const rows = await db.delete(media).where(eq(media.id, id)).returning()
  return rows[0] ?? null
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
