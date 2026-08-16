import { randomUUID } from 'node:crypto'
import { defineContentType } from '@presslabz/core'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { contentRevisions, contents, translationGroups } from '../schema/contents.ts'
import { createScratchDatabase, hasIntegrationEnv } from '../testing.ts'
import {
  ContentConflictError,
  ContentForbiddenError,
  type ContentState,
  createContent,
  deleteContent,
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
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    /*
     * Its own database, created and migrated for this run and dropped after.
     *
     * These used to run against whatever DATABASE_URL pointed at, cleaning up
     * by deleting every row of a fixed test type — which meant the suite could
     * remove rows it had not created, and two runs against the same server
     * would delete each other's fixtures. It also means every run now
     * exercises the migration from an empty database rather than from whatever
     * state the last one left.
     */
    scratch = await createScratchDatabase('contents')
    // Enough for the controlled interleavings below, which hold one
    // transaction open while a second waits on it.
    handle = createDb(scratch.url, { maxConnections: 10 })
    db = handle.db
  }, 60_000)

  afterEach(async () => {
    // Inside the scratch database only. Contents first: the foreign key is
    // RESTRICT, so a group cannot go while it still has members.
    for (const type of [TYPE, `${TYPE}-other`]) {
      await db.delete(contents).where(eq(contents.type, type))
      await db.delete(translationGroups).where(eq(translationGroups.type, type))
    }
  })

  afterAll(async () => {
    await handle.close()
    await scratch.drop()
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
        authorizeJoin: () => true,
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
          authorizeJoin: () => true,
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
          authorizeJoin: () => true,
          state: state({ slug: 'other' }),
        }),
      ).rejects.toMatchObject({ reason: 'group-type-mismatch' })
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
          authorizeJoin: () => true,
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

  describe('group integrity', () => {
    it('refuses an invented group id instead of opening one', async () => {
      // This is the reproduced bug. While an unknown id created a group
      // implicitly, two concurrent creates both found no siblings, both passed
      // the type check, and the group ended up holding two content types.
      const invented = randomUUID()

      await expect(
        createContent(db, {
          type: TYPE,
          locale: 'fr',
          translationGroupId: invented,
          authorId: null,
          state: state(),
          authorizeJoin: () => {
            throw new Error('authorization must not be reached for a group that does not exist')
          },
        }),
      ).rejects.toMatchObject({ reason: 'group-not-found' })
    })

    it('cannot be raced into a mixed-type group', async () => {
      const invented = randomUUID()

      const results = await Promise.allSettled([
        createContent(db, {
          type: TYPE,
          locale: 'fr',
          translationGroupId: invented,
          authorId: null,
          state: state({ slug: 'race-a' }),
          authorizeJoin: () => {
            throw new Error('authorization must not be reached for a group that does not exist')
          },
        }),
        createContent(db, {
          type: `${TYPE}-other`,
          locale: 'en',
          translationGroupId: invented,
          authorId: null,
          state: state({ slug: 'race-b' }),
          authorizeJoin: () => {
            throw new Error('authorization must not be reached for a group that does not exist')
          },
        }),
      ])

      // Neither can succeed: there is no group to join, and a group is opened
      // only by the server.
      expect(results.every((result) => result.status === 'rejected')).toBe(true)
      expect(await listTranslations(db, invented)).toHaveLength(0)
    })

    it('refuses a join the caller does not authorize, before saying what is inside', async () => {
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      // Same locale as the existing member: if authorization ran second, the
      // answer would be "that language is taken", which describes the group to
      // somebody who may not see it.
      await expect(
        createContent(db, {
          type: TYPE,
          locale: 'fr',
          translationGroupId: first.translationGroupId,
          authorId: null,
          state: state({ slug: 'nope' }),
          authorizeJoin: () => false,
        }),
      ).rejects.toMatchObject({ reason: 'group-forbidden' })
    })

    it('hands the authorizer the members it is deciding about', async () => {
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      let seen: string[] = []
      await createContent(db, {
        type: TYPE,
        locale: 'en',
        translationGroupId: first.translationGroupId,
        authorId: null,
        state: state({ slug: 'sibling' }),
        authorizeJoin: (members) => {
          seen = members.map((member) => member.id)
          return true
        },
      })

      expect(seen).toEqual([first.id])
    })

    it('serializes concurrent joins of the same language', async () => {
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
          translationGroupId: first.translationGroupId,
          authorId: null,
          state: state({ slug: `join-${n}` }),
          authorizeJoin: () => true,
        }),
      )

      const results = await Promise.allSettled(race)
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
      expect(await listTranslations(db, first.translationGroupId)).toHaveLength(2)
    })
  })

  describe('group lifecycle', () => {
    it('takes the group with the last member', async () => {
      // Under the join rule nobody can attach to a group with no members —
      // there is nothing to hold update permission over — so an empty one is a
      // row no path can use again.
      const only = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await deleteContent(db, only.id)

      await expect(
        createContent(db, {
          type: TYPE,
          locale: 'en',
          translationGroupId: only.translationGroupId,
          authorId: null,
          state: state({ slug: 'orphan' }),
          authorizeJoin: () => true,
        }),
      ).rejects.toMatchObject({ reason: 'group-not-found' })
    })

    it('keeps the group while any member remains', async () => {
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })
      const second = await createContent(db, {
        type: TYPE,
        locale: 'en',
        translationGroupId: first.translationGroupId,
        authorId: null,
        state: state({ slug: 'kept' }),
        authorizeJoin: () => true,
      })

      await deleteContent(db, first.id)

      const group = await listTranslations(db, first.translationGroupId)
      expect(group.map((row) => row.id)).toEqual([second.id])
    })

    it('does not let a join authorize against a member being deleted', async () => {
      /*
       * Both take the group lock, and both take it first, so they serialize.
       * Either the delete wins and the group is gone — the join then has
       * nothing to attach to — or the join wins and the group keeps a member.
       * What cannot happen is a join that authorized against a document this
       * transaction was already removing.
       */
      const only = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const [deletion, join] = await Promise.allSettled([
        deleteContent(db, only.id),
        createContent(db, {
          type: TYPE,
          locale: 'en',
          translationGroupId: only.translationGroupId,
          authorId: null,
          state: state({ slug: 'contender' }),
          authorizeJoin: (members) => members.length > 0,
        }),
      ])

      const group = await listTranslations(db, only.translationGroupId)

      if (join.status === 'fulfilled') {
        // The join went first: the group survives, holding what is left.
        expect(group.length).toBeGreaterThan(0)
      } else {
        // The delete went first: the group went with its last member, and the
        // join found nothing to join.
        expect(group).toHaveLength(0)
        expect(deletion.status).toBe('fulfilled')
      }
    })
  })

  describe('locks that hold under a controlled interleaving', () => {
    /** Lets a test hold a transaction open at a chosen point. */
    function gate() {
      let open: () => void = () => {}
      const opened = new Promise<void>((resolve) => {
        open = resolve
      })
      return { open, opened }
    }

    const settle = () => new Promise((resolve) => setTimeout(resolve, 250))

    it('decides a deletion against the row as it is, not as it was', async () => {
      /*
       * updateContent locks the content row and never the group, so the group
       * lock alone does not serialize the two. With a plain read here, a
       * deletion authorized while the document was a draft would still run
       * after another transaction published it.
       */
      const row = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const holding = gate()
      const release = gate()

      const writer = db.transaction(async (tx) => {
        await tx.select().from(contents).where(eq(contents.id, row.id)).limit(1).for('update')
        holding.open()
        await release.opened
        await tx.update(contents).set({ status: 'published' }).where(eq(contents.id, row.id))
      })

      await holding.opened

      let sawStatus: string | null = null
      const deletion = deleteContent(db, row.id, {
        authorize: (current) => {
          sawStatus = current.status
          return current.status === 'draft'
        },
      })

      try {
        // The deletion is now waiting on the content row, not reading past it.
        await settle()
        expect(sawStatus).toBeNull()
      } finally {
        // Released whatever the assertion decided: a failed expectation must
        // fail the test, not leave a transaction open and hang the suite.
        release.open()
      }
      await writer

      await expect(deletion).rejects.toBeInstanceOf(ContentForbiddenError)
      expect(sawStatus).toBe('published')
      expect(
        await findContentBySlug(db, { type: TYPE, locale: 'fr', slug: 'first' }),
      ).not.toBeNull()
    })

    it('never authorizes a join against a member already being removed', async () => {
      /*
       * The assertion is about what the authorizer was shown, not about who
       * won. A final state can look correct because the foreign key rolled one
       * transaction back, while the join still made its decision against a
       * document that was on its way out.
       */
      const only = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const removing = gate()
      const release = gate()

      const remover = db.transaction(async (tx) => {
        await tx
          .select()
          .from(translationGroups)
          .where(eq(translationGroups.id, only.translationGroupId))
          .limit(1)
          .for('update')
        await tx.delete(contents).where(eq(contents.id, only.id))
        removing.open()
        await release.opened
        await tx.delete(translationGroups).where(eq(translationGroups.id, only.translationGroupId))
      })

      await removing.opened

      let sawMembers: string[] | null = null
      const join = createContent(db, {
        type: TYPE,
        locale: 'en',
        translationGroupId: only.translationGroupId,
        authorId: null,
        state: state({ slug: 'contender' }),
        authorizeJoin: (members) => {
          sawMembers = members.map((member) => member.id)
          return members.length > 0
        },
      })

      try {
        await settle()
        // Blocked on the group row, so it has not seen anything to authorize
        // against — least of all the document being deleted.
        expect(sawMembers).toBeNull()
      } finally {
        release.open()
      }
      await remover

      await expect(join).rejects.toMatchObject({ reason: 'group-not-found' })
      expect(sawMembers).toBeNull()
    })

    it('waits for the group before removing a member of it', async () => {
      // Two members, so the deletion never reaches the group delete: what it
      // waits on can only be the group lock it takes first.
      const first = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state(),
      })
      await createContent(db, {
        type: TYPE,
        locale: 'en',
        translationGroupId: first.translationGroupId,
        authorId: null,
        state: state({ slug: 'sibling' }),
        authorizeJoin: () => true,
      })

      const holding = gate()
      const release = gate()

      const holder = db.transaction(async (tx) => {
        await tx
          .select()
          .from(translationGroups)
          .where(eq(translationGroups.id, first.translationGroupId))
          .limit(1)
          .for('update')
        holding.open()
        await release.opened
      })

      await holding.opened

      let finished = false
      const deletion = deleteContent(db, first.id).then((result) => {
        finished = true
        return result
      })

      try {
        await settle()
        expect(finished).toBe(false)
      } finally {
        release.open()
      }
      await holder
      expect(await deletion).toBe(true)
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
