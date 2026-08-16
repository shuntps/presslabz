import { defineContentType } from '@presslabz/core'
import { hasIntegrationEnv } from '@presslabz/db/testing'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { contentRevisions, contents } from '../schema/contents.ts'
import {
  ContentConflictError,
  ContentForbiddenError,
  type ContentState,
  createContent,
  findContentBySlug,
  listContents,
  listTranslations,
  updateContent,
} from './contents.ts'

/*
 * These run against a real Postgres, because everything worth asserting here
 * is a property of the transaction: a lock that serializes two writers, a
 * constraint that holds when the check loses a race, a rollback that takes
 * the revision with it. None of that survives a fake.
 *
 * hasIntegrationEnv skips when a person runs these without Docker up, and
 * throws when CI does — a suite that quietly vanishes from a green build is
 * worse than one that fails.
 */
const ready = hasIntegrationEnv()
const url = process.env.DATABASE_URL

/** Its own type name, so nothing here can see or disturb real documents. */
const TYPE = 'test-doc'
const testType = defineContentType({ name: TYPE })

function state(overrides: Partial<ContentState> = {}): ContentState {
  return {
    slug: 'first',
    title: 'First',
    status: 'draft',
    blocks: [],
    meta: {},
    ...overrides,
  }
}

describe.skipIf(!ready)('contents repository', () => {
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(() => {
    handle = createDb(url as string, { maxConnections: 5 })
    db = handle.db
  })

  afterEach(async () => {
    await db.delete(contents).where(eq(contents.type, TYPE))
  })

  afterAll(async () => {
    await handle.close()
  })

  describe('locale scoping', () => {
    it('never returns another language from a listing', async () => {
      await createContent(db, { type: TYPE, locale: 'fr', authorId: null, state: state() })
      await createContent(db, {
        type: TYPE,
        locale: 'en',
        authorId: null,
        state: state({ slug: 'first-en' }),
      })

      const french = await listContents(db, { type: TYPE, locale: 'fr' })
      expect(french).toHaveLength(1)
      expect(french[0]?.locale).toBe('fr')
    })

    it('lets the same slug exist once per language', async () => {
      await createContent(db, { type: TYPE, locale: 'fr', authorId: null, state: state() })
      await expect(
        createContent(db, { type: TYPE, locale: 'en', authorId: null, state: state() }),
      ).resolves.toBeDefined()

      await expect(
        createContent(db, { type: TYPE, locale: 'fr', authorId: null, state: state() }),
      ).rejects.toMatchObject({ reason: 'slug-taken' })
    })

    it('finds by slug only within the language asked for', async () => {
      await createContent(db, { type: TYPE, locale: 'fr', authorId: null, state: state() })
      expect(
        await findContentBySlug(db, { type: TYPE, locale: 'fr', slug: 'first' }),
      ).not.toBeNull()
      expect(await findContentBySlug(db, { type: TYPE, locale: 'en', slug: 'first' })).toBeNull()
    })
  })

  describe('translation groups', () => {
    it('links a sibling and reports both, across locales, on request', async () => {
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })
      await createContent(db, {
        type: TYPE,
        locale: 'en',
        authorId: null,
        translationGroupId: first.translationGroupId,
        state: state({ slug: 'first-en' }),
      })

      const group = await listTranslations(db, first.translationGroupId)
      expect(group.map((row) => row.locale)).toEqual(['en', 'fr'])
    })

    it('refuses a second document in a language the group already has', async () => {
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await expect(
        createContent(db, {
          type: TYPE,
          locale: 'fr',
          authorId: null,
          translationGroupId: first.translationGroupId,
          state: state({ slug: 'second' }),
        }),
      ).rejects.toBeInstanceOf(ContentConflictError)
    })

    it('refuses a group that holds another type', async () => {
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await expect(
        createContent(db, {
          type: `${TYPE}-other`,
          locale: 'en',
          authorId: null,
          translationGroupId: first.translationGroupId,
          state: state({ slug: 'other' }),
        }),
      ).rejects.toMatchObject({ reason: 'group-type-mismatch' })

      await db.delete(contents).where(eq(contents.type, `${TYPE}-other`))
    })

    it('serializes two writers racing for the same language', async () => {
      // The claim being tested is that locking the siblings makes the check
      // atomic, and that the unique index catches it if the lock ever does not.
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const race = [1, 2].map((n) =>
        createContent(db, {
          type: TYPE,
          locale: 'en',
          authorId: null,
          translationGroupId: first.translationGroupId,
          state: state({ slug: `race-${n}` }),
        }),
      )

      const results = await Promise.allSettled(race)
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ContentConflictError)

      const group = await listTranslations(db, first.translationGroupId)
      expect(group.filter((row) => row.locale === 'en')).toHaveLength(1)
    })
  })

  describe('updates validate the merged state', () => {
    it('accepts a schedule when the stored row already carries a date', async () => {
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state({ publishedAt: new Date('2026-09-01T09:00:00Z') }),
      })

      // The patch alone says nothing about whether a date exists. Only the
      // merge with the stored row does.
      const updated = await updateContent(db, testType, row.id, { status: 'scheduled' })
      expect(updated?.status).toBe('scheduled')
    })

    it('refuses the same patch when the stored row has no date', async () => {
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await expect(updateContent(db, testType, row.id, { status: 'scheduled' })).rejects.toThrow()

      const after = await findContentBySlug(db, { type: TYPE, locale: 'fr', slug: 'first' })
      expect(after?.status).toBe('draft')
    })

    it('leaves fields the patch did not mention alone', async () => {
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state({ excerpt: 'Un extrait', title: 'Titre' }),
      })

      const updated = await updateContent(db, testType, row.id, { title: 'Nouveau titre' })
      expect(updated?.title).toBe('Nouveau titre')
      expect(updated?.excerpt).toBe('Un extrait')
    })

    it('returns null rather than throwing for a document that is not there', async () => {
      const missing = '00000000-0000-4000-8000-0000000000ff'
      expect(await updateContent(db, testType, missing, { title: 'x' })).toBeNull()
    })
  })

  describe('atomicity', () => {
    it('records what the document was, not what it became', async () => {
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state({ title: 'Avant' }),
      })

      await updateContent(db, testType, row.id, { title: 'Après' })

      const revisions = await db
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.contentId, row.id))

      expect(revisions).toHaveLength(1)
      expect(revisions[0]?.title).toBe('Avant')
    })

    it('takes the revision with it when authorization refuses', async () => {
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state({ title: 'Avant' }),
      })

      await expect(
        updateContent(db, testType, row.id, { title: 'Après' }, { authorize: () => false }),
      ).rejects.toBeInstanceOf(ContentForbiddenError)

      const after = await findContentBySlug(db, { type: TYPE, locale: 'fr', slug: 'first' })
      expect(after?.title).toBe('Avant')

      const revisions = await db
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.contentId, row.id))
      expect(revisions).toHaveLength(0)
    })

    it('decides on the state the write would produce, not on the patch', async () => {
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state({ publishedAt: new Date('2026-09-01T09:00:00Z') }),
      })

      // This is what closes the publish hole: the callback is handed the
      // locked row and the resulting state together, so it can see that a
      // draft is becoming publishable without reading anything itself.
      let sawTransition: [string, string] | null = null
      await updateContent(
        db,
        testType,
        row.id,
        { status: 'published' },
        {
          authorize: (current, next) => {
            sawTransition = [current.status, next.status]
            return true
          },
        },
      )

      expect(sawTransition).toEqual(['draft', 'published'])
    })
  })
})
