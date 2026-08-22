import { randomUUID } from 'node:crypto'
import { defineContentType, postType } from '@presslabz/core'
import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { contentMedia, mediaReferenceSync } from '../schema/content-media.ts'
import {
  backendsWaitingOnLocks,
  createScratchDatabase,
  gate,
  hasIntegrationEnv,
  held,
  settle,
} from '../testing.ts'
import { createContent, MediaReferenceError, updateContent } from './contents.ts'
import { reconcileMediaReferences } from './media-references.ts'

/**
 * A document may not name an asset that is not there, and an asset a document
 * names may not be removed.
 *
 * Against a real Postgres, because the guarantee *is* Postgres: the foreign
 * key is what refuses, and what makes the two orders of the race come out one
 * way rather than the other. A fake would agree with whatever it was told.
 */
const ready = hasIntegrationEnv()

const imageType = defineContentType({
  name: 'test-illustrated',
  meta: postType.meta,
  mediaIn: (meta) =>
    meta.featuredMediaId ? [{ mediaId: meta.featuredMediaId, at: 'featuredMediaId' }] : [],
})

describe.skipIf(!ready)('media references a document holds', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    scratch = await createScratchDatabase('media-refs')
    handle = createDb(scratch.url, { maxConnections: 10 })
    db = handle.db
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  })

  /** An asset, inserted with a known id so a block can name it first. */
  async function asset(): Promise<string> {
    const id = randomUUID()
    await db.execute(sql`
      insert into media (id, storage_key, mime_type, byte_size)
      values (${id}::uuid, ${`media/${id}.avif`}, 'image/avif', 10)
    `)
    return id
  }

  const imageBlock = (mediaId: string) => ({ id: randomUUID(), type: 'image' as const, mediaId })

  function state(overrides: Record<string, unknown> = {}) {
    return {
      slug: `doc-${randomUUID()}`,
      title: 'A document',
      status: 'draft' as const,
      blocks: [],
      meta: {},
      ...overrides,
    }
  }

  const write = (overrides: Record<string, unknown> = {}) =>
    createContent(db, { type: imageType, locale: 'en', authorId: null, state: state(overrides) })

  const rowsFor = (contentId: string) =>
    db
      .select({ mediaId: contentMedia.mediaId, source: contentMedia.source })
      .from(contentMedia)
      .where(eq(contentMedia.contentId, contentId))

  describe('writing one', () => {
    it('mirrors an asset named by a block', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })

      expect(await rowsFor(document.id)).toEqual([{ mediaId: picture, source: 'block' }])
    })

    it('mirrors an asset named by metadata', async () => {
      const picture = await asset()
      const document = await write({ meta: { featuredMediaId: picture } })

      expect(await rowsFor(document.id)).toEqual([{ mediaId: picture, source: 'meta' }])
    })

    /* One asset in both places is two rows, because they are two places. */
    it('tells the two places apart', async () => {
      const picture = await asset()
      const document = await write({
        blocks: [imageBlock(picture)],
        meta: { featuredMediaId: picture },
      })

      expect((await rowsFor(document.id)).map((row) => row.source).sort()).toEqual([
        'block',
        'meta',
      ])
    })

    /* Three blocks naming one asset is one row: the question is whether the
     * document uses it, not how often. */
    it('counts an asset once however many blocks name it', async () => {
      const picture = await asset()
      const document = await write({
        blocks: [imageBlock(picture), imageBlock(picture), imageBlock(picture)],
      })

      expect(await rowsFor(document.id)).toHaveLength(1)
    })

    it('refuses a block naming an asset that does not exist', async () => {
      const invented = randomUUID()

      const refused = write({ blocks: [imageBlock(invented)] })

      await expect(refused).rejects.toBeInstanceOf(MediaReferenceError)
      await expect(refused).rejects.toMatchObject({
        reason: 'media-missing',
        references: [{ mediaId: invented, source: 'block' }],
      })
    })

    it('refuses metadata naming an asset that does not exist', async () => {
      const invented = randomUUID()

      await expect(write({ meta: { featuredMediaId: invented } })).rejects.toMatchObject({
        reason: 'media-missing',
        references: [{ mediaId: invented, source: 'meta', at: 'featuredMediaId' }],
      })
    })

    /* The refusal is the database's, so nothing survives it. */
    it('writes no document at all when a reference is refused', async () => {
      const slug = `refused-${randomUUID()}`

      await expect(
        createContent(db, {
          type: imageType,
          locale: 'en',
          authorId: null,
          state: state({ slug, blocks: [imageBlock(randomUUID())] }),
        }),
      ).rejects.toBeInstanceOf(MediaReferenceError)

      const found = await db.execute<{ count: number }>(
        sql`select count(*)::int as count from contents where slug = ${slug}`,
      )
      expect(Number((found as unknown as { count: number }[])[0]?.count)).toBe(0)
    })

    /* Only the ones actually absent, not every reference in the document. */
    it('names the missing asset and not the ones that are fine', async () => {
      const real = await asset()
      const invented = randomUUID()

      await expect(
        write({ blocks: [imageBlock(real), imageBlock(invented)] }),
      ).rejects.toMatchObject({ references: [{ mediaId: invented }] })
    })
  })

  describe('changing one', () => {
    it('adds and removes rows as the document changes', async () => {
      const first = await asset()
      const second = await asset()
      const document = await write({ blocks: [imageBlock(first)] })

      await updateContent(
        db,
        imageType,
        document.id,
        { blocks: [imageBlock(second)] },
        { expectedVersion: document.version },
      )

      expect(await rowsFor(document.id)).toEqual([{ mediaId: second, source: 'block' }])
    })

    it('leaves the rows alone when nothing about them changed', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })

      /*
       * The difference is what makes this observable: a save that rewrote the
       * set would delete and re-insert, and `xmin` — the transaction that
       * wrote the row — would move. It does not.
       */
      const before = await db.execute<{ xmin: string }>(
        sql`select xmin::text from content_media where content_id = ${document.id}::uuid`,
      )

      await updateContent(
        db,
        imageType,
        document.id,
        { title: 'A different title' },
        { expectedVersion: document.version },
      )

      const after = await db.execute<{ xmin: string }>(
        sql`select xmin::text from content_media where content_id = ${document.id}::uuid`,
      )

      expect((after as unknown as { xmin: string }[])[0]?.xmin).toBe(
        (before as unknown as { xmin: string }[])[0]?.xmin,
      )
    })

    it('empties the rows when the last reference goes', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })

      await updateContent(
        db,
        imageType,
        document.id,
        { blocks: [] },
        { expectedVersion: document.version },
      )

      expect(await rowsFor(document.id)).toEqual([])
    })

    /*
     * The state that results, not the change. A document that already held a
     * dangling reference cannot be saved at all until it is repaired — there
     * is no inheriting an invalid state by not touching it.
     */
    it('refuses a save whose result names a missing asset, even untouched', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })

      // Removed behind the mirror's back, the way a restored backup might.
      await db.execute(sql`delete from content_media where media_id = ${picture}::uuid`)
      await db.execute(sql`delete from media where id = ${picture}::uuid`)

      await expect(
        updateContent(
          db,
          imageType,
          document.id,
          { title: 'Just the title' },
          { expectedVersion: document.version },
        ),
      ).rejects.toMatchObject({ reason: 'media-missing', references: [{ mediaId: picture }] })
    })

    it('takes the rows with the document when it is deleted', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })

      await db.execute(sql`delete from contents where id = ${document.id}::uuid`)

      expect(await rowsFor(document.id)).toEqual([])
    })
  })

  describe('the two orders', () => {
    it('refuses the deletion when the reference was committed first', async () => {
      const picture = await asset()
      await write({ blocks: [imageBlock(picture)] })

      const refused = db.execute(sql`delete from media where id = ${picture}::uuid`)

      await expect(refused).rejects.toMatchObject({
        cause: expect.objectContaining({ constraint_name: 'content_media_media_fk' }),
      })
    })

    it('refuses the reference when the deletion was committed first', async () => {
      const picture = await asset()
      await db.execute(sql`delete from media where id = ${picture}::uuid`)

      await expect(write({ blocks: [imageBlock(picture)] })).rejects.toMatchObject({
        reason: 'media-missing',
      })
    })

    /*
     * The race itself, made to happen rather than hoped for. A control
     * transaction deletes the asset and holds; the save reaches for it, is
     * observed waiting on the lock, and only then is the deletion committed.
     * Whichever way Postgres orders them, both cannot win.
     */
    it('serializes a save and a deletion that overlap', async () => {
      const picture = await asset()
      const document = await write()

      const holding = gate()
      const release = gate()

      const deleting = held(
        db.transaction(async (tx) => {
          await tx.execute(sql`delete from media where id = ${picture}::uuid`)
          holding.open()
          await release.opened
        }),
      )

      await holding.opened

      const saving = held(
        updateContent(
          db,
          imageType,
          document.id,
          { blocks: [imageBlock(picture)] },
          { expectedVersion: document.version },
        ),
      )

      let waiting = 0
      try {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          waiting = await backendsWaitingOnLocks(db)
          if (waiting >= 1) break
          await settle()
        }
      } finally {
        release.open()
      }

      await deleting
      const outcome = await saving.then(
        () => 'saved',
        (error: unknown) => (error instanceof MediaReferenceError ? 'refused' : 'other'),
      )

      // It really waited, and it really lost.
      expect(waiting).toBeGreaterThanOrEqual(1)
      expect(outcome).toBe('refused')
      expect(await rowsFor(document.id)).toEqual([])
    })
  })

  describe('reconciling', () => {
    const resolve = (name: string) => (name === imageType.name ? imageType : undefined)

    /*
     * A clean slate per test. The suite above deliberately leaves a document
     * holding a reference whose asset was removed behind the mirror's back —
     * which is exactly what a reconciliation is supposed to notice, and would
     * make every test here notice it instead of its own subject.
     */
    beforeEach(async () => {
      await db.execute(sql`delete from contents`)
      await db.execute(sql`delete from media`)
      await db
        .update(mediaReferenceSync)
        .set({ state: 'ready' })
        .where(eq(mediaReferenceSync.id, true))
    })

    it('marks a database that was empty when it was migrated as ready', async () => {
      // The scratch database this suite runs against was migrated empty.
      const rows = await db.select().from(mediaReferenceSync)
      expect(rows[0]?.state).toBe('ready')
    })

    it('puts back a row somebody removed behind its back', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })
      await db.execute(sql`delete from content_media where content_id = ${document.id}::uuid`)

      const result = await reconcileMediaReferences(db, resolve)

      expect(result.added).toBeGreaterThanOrEqual(1)
      expect(result.dangling).toEqual([])
      expect(result.state).toBe('ready')
      expect(await rowsFor(document.id)).toEqual([{ mediaId: picture, source: 'block' }])
    })

    it('changes nothing the second time', async () => {
      await write({ blocks: [imageBlock(await asset())] })
      await reconcileMediaReferences(db, resolve)

      const again = await reconcileMediaReferences(db, resolve)

      expect(again).toMatchObject({ added: 0, removed: 0, dangling: [], state: 'ready' })
    })

    /*
     * A half-built mirror marked ready is the failure the marker exists to
     * prevent, so a diagnosis that finds anything leaves every mirror row
     * exactly as it was. The marker is the one thing it does write.
     */
    it('reports a dangling reference, touches no mirror row, and stays pending', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })
      await db.execute(sql`delete from content_media where media_id = ${picture}::uuid`)
      await db.execute(sql`delete from media where id = ${picture}::uuid`)
      await db
        .update(mediaReferenceSync)
        .set({ state: 'pending' })
        .where(eq(mediaReferenceSync.id, true))

      const result = await reconcileMediaReferences(db, resolve)

      expect(result.dangling).toEqual([
        expect.objectContaining({ contentId: document.id, mediaId: picture, source: 'block' }),
      ])
      expect(result.added).toBe(0)
      expect(result.state).toBe('pending')

      // Repaired, and then it goes through.
      await db.execute(sql`delete from contents where id = ${document.id}::uuid`)
      expect((await reconcileMediaReferences(db, resolve)).state).toBe('ready')
    })

    /*
     * The failure this transaction exists to prevent, made to happen.
     *
     * A reconciliation that read the documents, the media and the mirror
     * without holding anything would take three separate snapshots under READ
     * COMMITTED. A save landing between them would be mirrored by itself and
     * then written over by the older set — and the marker set to ready on top
     * of the wrong answer.
     *
     * So: a content write is held open, the reconciliation is started, and it
     * is observed **waiting** rather than reading. The write is what it is
     * waiting for; when that commits, what the reconciliation sees is the new
     * document.
     *
     * The held write is spelled out rather than routed through
     * `updateContent`, which commits on its own and cannot be paused. It does
     * what that function does inside its transaction, and nothing else.
     */
    it('waits for a save in flight rather than overwriting it with a stale snapshot', async () => {
      const picture = await asset()
      const document = await write()
      await reconcileMediaReferences(db, resolve)
      expect(await rowsFor(document.id)).toEqual([])

      const block = imageBlock(picture)
      const holding = gate()
      const release = gate()

      const saving = held(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`update contents set blocks = ${JSON.stringify([block])}::jsonb where id = ${document.id}::uuid`,
          )
          await tx.execute(
            sql`insert into content_media (content_id, media_id, source) values (${document.id}::uuid, ${picture}::uuid, 'block')`,
          )
          holding.open()
          await release.opened
        }),
      )

      await holding.opened

      const reconciling = held(reconcileMediaReferences(db, resolve))

      let waiting = 0
      try {
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          waiting = await backendsWaitingOnLocks(db)
          if (waiting >= 1) break
          await settle()
        }
      } finally {
        release.open()
      }

      await saving
      const result = await reconciling

      // It really waited, and what it then saw was the save.
      expect(waiting).toBeGreaterThanOrEqual(1)
      expect(result.state).toBe('ready')
      expect(result.removed).toBe(0)
      expect(await rowsFor(document.id)).toEqual([{ mediaId: picture, source: 'block' }])
    })

    /*
     * An installation that was ready and has since acquired a dangling
     * reference is not ready any more. Leaving the old marker would let a
     * server start against a mirror that cannot be completed.
     */
    it('takes a ready marker back to pending when it finds one', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })
      await reconcileMediaReferences(db, resolve)
      expect((await db.select().from(mediaReferenceSync))[0]?.state).toBe('ready')

      await db.execute(sql`delete from content_media where media_id = ${picture}::uuid`)
      await db.execute(sql`delete from media where id = ${picture}::uuid`)

      const result = await reconcileMediaReferences(db, resolve)

      expect(result.dangling).toHaveLength(1)
      expect(result.state).toBe('pending')
      expect((await db.select().from(mediaReferenceSync))[0]?.state).toBe('pending')
      // And nothing was half-written on the way.
      expect(result.added).toBe(0)
      expect(result.removed).toBe(0)

      await db.execute(sql`delete from contents where id = ${document.id}::uuid`)
    })

    /*
     * History is not a fault. A revision can hold whatever it was written
     * with, and a value that is not a uuid must not be the reason an
     * installation cannot be reconciled — this line is a report.
     */
    it('is not stopped by a revision holding something that is not an identifier', async () => {
      const picture = await asset()
      const document = await write({ blocks: [imageBlock(picture)] })

      await db.execute(sql`
        insert into content_revisions (content_id, slug, title, status, blocks, meta, version)
        values (
          ${document.id}::uuid, 'historical', 'Historical', 'draft',
          ${JSON.stringify([{ id: 'b1', type: 'image', mediaId: 'not-a-uuid-at-all' }])}::jsonb,
          '{}'::jsonb, 1
        )
      `)

      const result = await reconcileMediaReferences(db, resolve)

      expect(result.state).toBe('ready')
      expect(result.revisionsNamingAbsentMedia).toBe(0)
    })

    /*
     * The row is the migration's, and a database without it is not one this
     * code knows how to reconcile. Carrying on would end by reporting `ready`
     * after updating nothing — the most misleading answer available.
     */
    it('refuses to reconcile a database whose marker row is gone', async () => {
      await db.execute(sql`delete from media_reference_sync`)

      try {
        await expect(reconcileMediaReferences(db, resolve)).rejects.toThrow(/db:migrate/)
      } finally {
        await db.execute(sql`insert into media_reference_sync (id, state) values (true, 'ready')`)
      }
    })

    it('refuses to reconcile a type this build does not know', async () => {
      const picture = await asset()
      await write({ blocks: [imageBlock(picture)] })

      const result = await reconcileMediaReferences(db, () => undefined)

      expect(result.unknownTypes).toEqual([imageType.name])
      expect(result.added).toBe(0)
    })
  })
})
