import type { AnyContentType, ContentMediaReference } from '@presslabz/core'
import { mediaReferencesOf } from '@presslabz/core'
import { eq, inArray, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { contentMedia, mediaReferenceSync } from '../schema/content-media.ts'
import { contents } from '../schema/contents.ts'
import { media } from '../schema/media.ts'

/**
 * Whether the relational mirror has been built, and the one operation that
 * builds it.
 *
 * A schema migration and a reconciliation are separate events. Applying the
 * first without the second leaves a server enforcing nothing against an empty
 * table, and no way to tell from the outside. The marker is what tells.
 */

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

export type MediaReferenceSyncState = 'pending' | 'ready'

/**
 * One row, read at boot. Not a scan of every document — the whole point of a
 * durable marker is that the expensive answer was computed once.
 */
export async function readMediaReferenceSyncState(db: Database): Promise<MediaReferenceSyncState> {
  const rows = await db
    .select({ state: mediaReferenceSync.state })
    .from(mediaReferenceSync)
    .limit(1)
  const state = rows[0]?.state

  if (!state) {
    // The row is seeded by the migration that creates the table. Its absence
    // means the schema is older than this code, which is not something to
    // guess about.
    throw new Error(
      'media_reference_sync holds no row: run `pnpm db:migrate` before starting the API',
    )
  }

  return state
}

/** A live reference whose asset is not there. */
export interface DanglingReference {
  readonly contentId: string
  readonly type: string
  readonly locale: string
  readonly slug: string
  readonly title: string
  readonly mediaId: string
  readonly source: 'block' | 'meta'
  readonly at: string
}

export interface ReconcileResult {
  readonly documents: number
  /** Live references naming an asset that does not exist. Blocking. */
  readonly dangling: readonly DanglingReference[]
  /** Content types a document claims and this build does not know. Blocking. */
  readonly unknownTypes: readonly string[]
  /** Historical references in revisions. Reported, never blocking. */
  readonly revisionsNamingAbsentMedia: number
  readonly added: number
  readonly removed: number
  readonly state: MediaReferenceSyncState
}

/**
 * Brings `content_media` in line with every live document, and marks the
 * installation ready — atomically, or not at all.
 *
 * The extractors come from the caller, because they are declared in TypeScript
 * and the registry that holds them is assembled by the application: this
 * package must stay usable by a test that migrates an empty scratch database
 * without pulling the API in behind it.
 *
 * Diagnose first, and refuse to half-do it. A document naming an asset that
 * does not exist cannot be mirrored — the foreign key would refuse the row —
 * and writing the rows that *do* work while marking the installation ready
 * would be worse than doing nothing: it would look finished. So the dangling
 * references are reported, **no mirror row is touched**, and the marker is set
 * to `pending` — including when it was `ready` before, because an installation
 * that has acquired a dangling reference has stopped being ready.
 *
 * Idempotent, and safe to interrupt. The whole reconciliation is one
 * transaction, so an interrupted run leaves neither rows nor a marker behind
 * and the next attempt starts from where it would have started anyway.
 */
export async function reconcileMediaReferences(
  db: Database,
  resolveType: (name: string) => AnyContentType | undefined,
): Promise<ReconcileResult> {
  return db.transaction(async (tx) => {
    /*
     * Two locks, in this order, before anything is read.
     *
     * The marker first, `FOR UPDATE`: two reconciliations must not build
     * snapshots of the same database at once, and this is the row they both
     * want.
     *
     * Then `contents` in SHARE mode, which conflicts with the ROW EXCLUSIVE
     * every INSERT, UPDATE and DELETE takes. Content writes already in flight
     * commit before this is granted, and none can start until this transaction
     * ends — so the successive statements below see one unchanging set of
     * documents.
     *
     * That is what makes this a snapshot rather than a guess. READ COMMITTED
     * gives each *statement* its own view, so reading the documents, then the
     * media, then the mirror without holding anything would let a save land
     * between two of them — and the stale set would then be written over the
     * newer one, with the marker set to ready on top.
     */
    const marker = await tx
      .select({ state: mediaReferenceSync.state })
      .from(mediaReferenceSync)
      .where(eq(mediaReferenceSync.id, true))
      .for('update')

    /*
     * The row is seeded by the migration that creates the table. If it is not
     * there, this database is not one this code knows how to reconcile — and
     * carrying on would end by reporting `ready` after updating nothing, which
     * is the most misleading answer available.
     */
    if (!marker[0]) {
      throw new Error(
        'media_reference_sync holds no row: this database has not had the migration that ' +
          'creates it, or the row was removed. Run `pnpm db:migrate` and try again.',
      )
    }

    await tx.execute(sql`lock table ${contents} in share mode`)

    const documents = await tx
      .select({
        id: contents.id,
        type: contents.type,
        locale: contents.locale,
        slug: contents.slug,
        title: contents.title,
        blocks: contents.blocks,
        meta: contents.meta,
      })
      .from(contents)

    const unknownTypes = new Set<string>()
    const wanted: (ContentMediaReference & { contentId: string })[] = []
    const describing = new Map<string, (typeof documents)[number]>()

    for (const document of documents) {
      const type = resolveType(document.type)
      if (!type) {
        unknownTypes.add(document.type)
        continue
      }

      describing.set(document.id, document)
      for (const reference of mediaReferencesOf(type, document)) {
        wanted.push({ ...reference, contentId: document.id })
      }
    }

    const referenced = [...new Set(wanted.map((reference) => reference.mediaId))]
    const present = new Set(
      referenced.length === 0
        ? []
        : (await tx.select({ id: media.id }).from(media).where(inArray(media.id, referenced))).map(
            (row) => row.id,
          ),
    )

    const dangling: DanglingReference[] = wanted
      .filter((reference) => !present.has(reference.mediaId))
      .map((reference) => {
        const document = describing.get(reference.contentId) as (typeof documents)[number]
        return {
          contentId: document.id,
          type: document.type,
          locale: document.locale,
          slug: document.slug,
          title: document.title,
          mediaId: reference.mediaId,
          source: reference.source,
          at: reference.at,
        }
      })

    const revisionsNamingAbsentMedia = await countRevisionsNamingAbsentMedia(tx)

    /*
     * A diagnosis that finds anything leaves **every mirror row exactly as it
     * was** and takes the marker back to `pending`. Those are two different
     * facts and the report says so separately: an installation that was ready
     * and has since acquired a dangling reference is not ready any more, and
     * leaving the old marker would let a server start against a mirror nothing
     * can complete.
     */
    if (dangling.length > 0 || unknownTypes.size > 0) {
      await tx
        .update(mediaReferenceSync)
        .set({ state: 'pending', reconciledAt: null })
        .where(eq(mediaReferenceSync.id, true))

      return {
        documents: documents.length,
        dangling,
        unknownTypes: [...unknownTypes],
        revisionsNamingAbsentMedia,
        added: 0,
        removed: 0,
        state: 'pending' as const,
      }
    }

    const key = (row: { contentId: string; mediaId: string; source: string }) =>
      `${row.contentId}:${row.mediaId}:${row.source}`

    const current = await tx
      .select({
        contentId: contentMedia.contentId,
        mediaId: contentMedia.mediaId,
        source: contentMedia.source,
      })
      .from(contentMedia)

    const held = new Set(current.map(key))
    const shouldHold = new Set(wanted.map(key))

    const stale = current.filter((row) => !shouldHold.has(key(row)))
    const fresh = wanted.filter((row) => !held.has(key(row)))

    for (const row of stale) {
      await tx
        .delete(contentMedia)
        .where(
          sql`${contentMedia.contentId} = ${row.contentId} and ${contentMedia.mediaId} = ${row.mediaId} and ${contentMedia.source} = ${row.source}`,
        )
    }

    for (const row of fresh) {
      await tx
        .insert(contentMedia)
        .values({ contentId: row.contentId, mediaId: row.mediaId, source: row.source })
    }

    /*
     * Read back and compared before the marker moves. The difference above is
     * computed from a set this transaction assembled; this asks the table what
     * it actually holds now. A mismatch means something wrote around the lock,
     * and the honest response is to abandon the whole transaction rather than
     * to declare an installation ready on the strength of arithmetic.
     */
    const settled = await tx
      .select({
        contentId: contentMedia.contentId,
        mediaId: contentMedia.mediaId,
        source: contentMedia.source,
      })
      .from(contentMedia)

    const actual = new Set(settled.map(key))
    const missing = [...shouldHold].filter((entry) => !actual.has(entry))
    const extra = [...actual].filter((entry) => !shouldHold.has(entry))

    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `The media reference mirror does not match the documents after reconciling: ` +
          `${missing.length} missing, ${extra.length} unexpected. Nothing was committed.`,
      )
    }

    await tx
      .update(mediaReferenceSync)
      .set({ state: 'ready', reconciledAt: new Date() })
      .where(eq(mediaReferenceSync.id, true))

    return {
      documents: documents.length,
      dangling: [],
      unknownTypes: [],
      revisionsNamingAbsentMedia,
      added: fresh.length,
      removed: stale.length,
      state: 'ready' as const,
    }
  })
}

/**
 * How many revisions name an asset that is gone.
 *
 * Reported and never acted on. A revision keeps the identifiers it was written
 * with, exactly as it keeps a `parentId` whose document may since have been
 * deleted; restoring one that names a missing asset is refused at the point of
 * restoring, which is where somebody can do something about it.
 *
 * Asked in SQL rather than through the extractors: this is a count for a
 * report, and reading every revision's blocks into memory to produce it would
 * cost more than the number is worth. It knows the shapes the current build
 * uses, which is the right scope for an informational line.
 */
async function countRevisionsNamingAbsentMedia(tx: Transaction): Promise<number> {
  /*
   * Tolerant, and tolerant without depending on evaluation order.
   *
   * A revision holds whatever it was written with, and a value that is not a
   * uuid — an import, a hand-edited row, a shape from before a validation
   * existed — is history rather than a fault. Casting it would make this
   * informational line the reason a reconciliation failed, which is backwards.
   *
   * A regex in a CTE followed by `value::uuid` would not be enough: a
   * non-recursive CTE used once can be folded into the outer query, and
   * Postgres does not promise to evaluate a filter before an expression beside
   * it. So there is **no cast of the value at all** — the comparison is text
   * against text, with the only cast applied to a real uuid column. The regex
   * decides what counts as an identifier, not what is safe to evaluate.
   */
  const rows = await tx.execute<{ count: number }>(sql`
    with named as (
      select block->>'mediaId' as value
        from content_revisions r, lateral jsonb_array_elements(r.blocks) block
       where block->>'type' = 'image'
      union
      select r.meta->>'featuredMediaId'
        from content_revisions r
       where r.meta ? 'featuredMediaId'
    )
    select count(*)::int as count
      from named
     where value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and not exists (select 1 from media m where m.id::text = lower(named.value))
  `)

  return Number((rows as unknown as { count: number }[])[0]?.count ?? 0)
}
