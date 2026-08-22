import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { media } from '../schema/media.ts'
import { users } from '../schema/users.ts'
import {
  createScratchDatabase,
  gate,
  hasIntegrationEnv,
  held,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
  settle,
} from '../testing.ts'
import {
  createMedia,
  findMediaById,
  MediaForbiddenError,
  type MediaRow,
  patchMediaAlt,
} from './media.ts'
import { createUser } from './users.ts'

/*
 * On a scratch database, because the interleaving below needs two transactions
 * writing the same row at a moment this test chooses — and because deleting a
 * user account to see what it does to an asset is not something to do to
 * whatever DATABASE_URL happens to point at.
 */
const ready = hasIntegrationEnv()

describe.skipIf(!ready)('media metadata', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let owner: string
  let other: string

  const asset = async (uploadedById: string | null, alt: Record<string, string> = {}) =>
    createMedia(db, {
      storageKey: `media/${randomUUID()}.avif`,
      mimeType: 'image/avif',
      byteSize: 1024,
      width: 40,
      height: 30,
      alt,
      meta: {},
      uploadedById,
    })

  const allowed = { authorize: () => true }

  beforeAll(async () => {
    scratch = await createScratchDatabase('media')
    // Enough connections that the two transactions below genuinely overlap
    // rather than queueing on the pool and passing for the wrong reason.
    handle = createDb(scratch.url, { maxConnections: 10 })
    db = handle.db

    owner = (
      await createUser(db, {
        email: 'owner@presslabz.test',
        displayName: 'Owner',
        role: 'author',
        passwordHash: null,
      })
    ).id

    other = (
      await createUser(db, {
        email: 'other@presslabz.test',
        displayName: 'Other',
        role: 'author',
        passwordHash: null,
      })
    ).id
  }, 60_000)

  afterAll(async () => {
    await handle.close()
    await scratch.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  describe('the authorizer decides, and it decides inside the transaction', () => {
    it('writes when it says yes', async () => {
      const row = await asset(owner)

      const updated = await patchMediaAlt(db, row.id, { fr: 'Un vélo rouge' }, allowed)

      expect(updated?.alt).toEqual({ fr: 'Un vélo rouge' })
      expect((await findMediaById(db, row.id))?.alt).toEqual({ fr: 'Un vélo rouge' })
    })

    it('writes nothing at all when it says no', async () => {
      // Not "throws and then also wrote": the whole thing is one transaction,
      // so the refusal has to take the update with it.
      const row = await asset(owner)

      await expect(
        patchMediaAlt(db, row.id, { fr: 'Détourné' }, { authorize: () => false }),
      ).rejects.toBeInstanceOf(MediaForbiddenError)

      expect((await findMediaById(db, row.id))?.alt).toEqual({})
    })

    it('is shown the stored row, not what the caller believes about it', async () => {
      const row = await asset(other)

      let sawOwner: string | null | undefined
      await patchMediaAlt(
        db,
        row.id,
        { en: 'A bicycle' },
        {
          authorize: (current: MediaRow) => {
            sawOwner = current.uploadedById
            return true
          },
        },
      )

      expect(sawOwner).toBe(other)
    })

    it('answers null for an asset that is not there, rather than inventing one', async () => {
      const missing = await patchMediaAlt(db, randomUUID(), { en: 'x' }, allowed)
      expect(missing).toBeNull()
    })
  })

  describe('a patch by language, not a replacement of the map', () => {
    it('leaves a language the patch does not mention alone', async () => {
      const row = await asset(owner, { en: 'A red bicycle' })

      const updated = await patchMediaAlt(db, row.id, { fr: 'Un vélo rouge' }, allowed)

      expect(updated?.alt).toEqual({ en: 'A red bicycle', fr: 'Un vélo rouge' })
    })

    it('removes one when it is set to null', async () => {
      // An empty description is an absent one, not an empty string a screen
      // reader has to announce.
      const row = await asset(owner, { en: 'A red bicycle', fr: 'Un vélo rouge' })

      const updated = await patchMediaAlt(db, row.id, { fr: null }, allowed)

      expect(updated?.alt).toEqual({ en: 'A red bicycle' })
    })

    it('does not lose a write that landed after the caller last read the row', async () => {
      /*
       * Two people describing the same image in two languages. Both start from
       * the same state; the second one's request is prepared before the first
       * one lands. Sending the whole map would make the second write delete the
       * first, because it would carry a snapshot that predates it.
       */
      const row = await asset(owner)

      await patchMediaAlt(db, row.id, { en: 'A red bicycle' }, allowed)
      // Prepared against the row as it was before that write, and applied now.
      await patchMediaAlt(db, row.id, { fr: 'Un vélo rouge' }, allowed)

      expect((await findMediaById(db, row.id))?.alt).toEqual({
        en: 'A red bicycle',
        fr: 'Un vélo rouge',
      })
    })

    it('merges against the locked row when two patches genuinely overlap', async () => {
      const row = await asset(owner)

      const [first, second] = await Promise.all([
        patchMediaAlt(db, row.id, { en: 'A red bicycle' }, allowed),
        patchMediaAlt(db, row.id, { fr: 'Un vélo rouge' }, allowed),
      ])

      // Whichever committed second sees both; the row is the authority.
      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect((await findMediaById(db, row.id))?.alt).toEqual({
        en: 'A red bicycle',
        fr: 'Un vélo rouge',
      })
    })
  })

  describe('ownership survives a concurrent write', () => {
    it('orphans an asset when the account that uploaded it goes', async () => {
      // The premise of the test below, asserted rather than assumed: this is
      // the ON DELETE SET NULL on media.uploaded_by_id, and it is the reason
      // ownership is a fact that can change under a decision.
      const leaving = await createUser(db, {
        email: 'leaving@presslabz.test',
        displayName: 'Leaving',
        role: 'author',
        passwordHash: null,
      })
      const row = await asset(leaving.id)

      await db.delete(users).where(eq(users.id, leaving.id))

      expect((await findMediaById(db, row.id))?.uploadedById).toBeNull()
    })

    it('waits for the row rather than deciding against an owner being removed', async () => {
      /*
       * Read the owner, decide, then update, and the decision is about a row
       * version that no longer exists by the time the write lands: an asset
       * this actor owned when they were asked has become one that needs
       * media:update:any. The lock is what makes the answer still true.
       */
      const row = await asset(owner)

      const holding = gate()
      const release = gate()

      // Exactly what deleting the uploader's account does, held open.
      const orphaning = held(
        db.transaction(async (tx) => {
          await tx.update(media).set({ uploadedById: null }).where(eq(media.id, row.id))
          holding.open()
          await release.opened
        }),
      )

      await holding.opened

      let sawOwner: string | null | undefined
      const editing = held(
        patchMediaAlt(
          db,
          row.id,
          { fr: 'Décrite' },
          {
            authorize: (current: MediaRow) => {
              sawOwner = current.uploadedById
              return current.uploadedById === owner
            },
          },
        ),
      )

      try {
        // Waiting on the row, not reading past it into the old snapshot.
        await settle()
        expect(sawOwner).toBeUndefined()
      } finally {
        // Released whatever the assertion decided: a failed expectation must
        // fail the test, not leave a transaction open and hang the suite.
        release.open()
      }
      await orphaning

      await expect(editing).rejects.toBeInstanceOf(MediaForbiddenError)
      expect(sawOwner).toBeNull()
      expect((await findMediaById(db, row.id))?.alt).toEqual({})
    })
  })
})
