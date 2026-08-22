import { randomUUID } from 'node:crypto'
import { defineContentType } from '@presslabz/core'
import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { contentRevisions, contents, translationGroups } from '../schema/contents.ts'
import {
  backendsWaitingOnLocks,
  createScratchDatabase,
  gate,
  hasIntegrationEnv,
  held,
  holdContentRow,
  settle,
} from '../testing.ts'
import {
  ContentConflictError,
  ContentForbiddenError,
  type ContentState,
  createContent,
  deleteContent,
  findContentById,
  findContentBySlug,
  listContents,
  listRevisions,
  listTranslations,
  MAX_HIERARCHY_DEPTH,
  publishDueContent,
  REVISION_LIMIT,
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
const testType = defineContentType({ name: TYPE, mediaIn: () => [] })
/** A second declaration, for the cases that are about types disagreeing. */
const otherTestType = defineContentType({ name: `${TYPE}-other`, mediaIn: () => [] })

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
      await createContent(db, { type: testType, locale: 'fr', authorId: null, state: state() })
      await createContent(db, {
        type: testType,
        locale: 'en',
        authorId: null,
        state: state({ slug: 'first-en' }),
      })

      const french = await listContents(db, { type: TYPE, locale: 'fr' })
      expect(french).toHaveLength(1)
      expect(french[0]?.locale).toBe('fr')
    })

    it('lets the same slug exist once per language', async () => {
      await createContent(db, { type: testType, locale: 'fr', authorId: null, state: state() })
      await expect(
        createContent(db, { type: testType, locale: 'en', authorId: null, state: state() }),
      ).resolves.toBeDefined()

      await expect(
        createContent(db, { type: testType, locale: 'fr', authorId: null, state: state() }),
      ).rejects.toMatchObject({ reason: 'slug-taken' })
    })

    it('finds by slug only within the language asked for', async () => {
      await createContent(db, { type: testType, locale: 'fr', authorId: null, state: state() })
      expect(
        await findContentBySlug(db, { type: TYPE, locale: 'fr', slug: 'first' }),
      ).not.toBeNull()
      expect(await findContentBySlug(db, { type: TYPE, locale: 'en', slug: 'first' })).toBeNull()
    })
  })

  describe('translation groups', () => {
    it('links a sibling and reports both, across locales, on request', async () => {
      const first = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })
      await createContent(db, {
        type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await expect(
        createContent(db, {
          type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await expect(
        createContent(db, {
          type: otherTestType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const race = [1, 2].map((n) =>
        createContent(db, {
          type: testType,
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
          type: testType,
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
          type: testType,
          locale: 'fr',
          translationGroupId: invented,
          authorId: null,
          state: state({ slug: 'race-a' }),
          authorizeJoin: () => {
            throw new Error('authorization must not be reached for a group that does not exist')
          },
        }),
        createContent(db, {
          type: otherTestType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      // Same locale as the existing member: if authorization ran second, the
      // answer would be "that language is taken", which describes the group to
      // somebody who may not see it.
      await expect(
        createContent(db, {
          type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      let seen: string[] = []
      await createContent(db, {
        type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const race = [1, 2].map((n) =>
        createContent(db, {
          type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await deleteContent(db, only.id)

      await expect(
        createContent(db, {
          type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })
      const second = await createContent(db, {
        type: testType,
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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const [deletion, join] = await Promise.allSettled([
        deleteContent(db, only.id),
        createContent(db, {
          type: testType,
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
    it('decides a deletion against the row as it is, not as it was', async () => {
      /*
       * updateContent locks the content row and never the group, so the group
       * lock alone does not serialize the two. With a plain read here, a
       * deletion authorized while the document was a draft would still run
       * after another transaction published it.
       */
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const holding = gate()
      const release = gate()

      const writer = held(
        db.transaction(async (tx) => {
          await tx.select().from(contents).where(eq(contents.id, row.id)).limit(1).for('update')
          holding.open()
          await release.opened
          await tx.update(contents).set({ status: 'published' }).where(eq(contents.id, row.id))
        }),
      )

      await holding.opened

      let sawStatus: string | null = null
      const deletion = held(
        deleteContent(db, row.id, {
          authorize: (current) => {
            sawStatus = current.status
            return current.status === 'draft'
          },
        }),
      )

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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      const removing = gate()
      const release = gate()

      const remover = held(
        db.transaction(async (tx) => {
          await tx
            .select()
            .from(translationGroups)
            .where(eq(translationGroups.id, only.translationGroupId))
            .limit(1)
            .for('update')
          await tx.delete(contents).where(eq(contents.id, only.id))
          removing.open()
          await release.opened
          await tx
            .delete(translationGroups)
            .where(eq(translationGroups.id, only.translationGroupId))
        }),
      )

      await removing.opened

      let sawMembers: string[] | null = null
      const join = held(
        createContent(db, {
          type: testType,
          locale: 'en',
          translationGroupId: only.translationGroupId,
          authorId: null,
          state: state({ slug: 'contender' }),
          authorizeJoin: (members) => {
            sawMembers = members.map((member) => member.id)
            return members.length > 0
          },
        }),
      )

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
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })
      await createContent(db, {
        type: testType,
        locale: 'en',
        translationGroupId: first.translationGroupId,
        authorId: null,
        state: state({ slug: 'sibling' }),
        authorizeJoin: () => true,
      })

      const holding = gate()
      const release = gate()

      const holder = held(
        db.transaction(async (tx) => {
          await tx
            .select()
            .from(translationGroups)
            .where(eq(translationGroups.id, first.translationGroupId))
            .limit(1)
            .for('update')
          holding.open()
          await release.opened
        }),
      )

      await holding.opened

      let finished = false
      const deletion = held(
        deleteContent(db, first.id).then((result) => {
          finished = true
          return result
        }),
      )

      try {
        await settle()
        expect(finished).toBe(false)
      } finally {
        release.open()
      }
      await holder
      expect((await deletion)?.id).toBe(first.id)
    })
  })

  describe('updates validate the merged state', () => {
    it('accepts a schedule when the stored row already carries a date', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ publishedAt: new Date('2026-09-01T09:00:00Z') }),
      })

      // The patch alone says nothing about whether a date exists. Only the
      // merge with the stored row does.
      const updated = await updateContent(
        db,
        testType,
        row.id,
        { status: 'scheduled' },
        {
          expectedVersion: 'any',
        },
      )
      expect(updated?.status).toBe('scheduled')
    })

    it('refuses the same patch when the stored row has no date', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state(),
      })

      await expect(
        updateContent(db, testType, row.id, { status: 'scheduled' }, { expectedVersion: 'any' }),
      ).rejects.toThrow()

      const after = await findContentBySlug(db, { type: TYPE, locale: 'fr', slug: 'first' })
      expect(after?.status).toBe('draft')
    })

    it('leaves fields the patch did not mention alone', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ excerpt: 'Un extrait', title: 'Titre' }),
      })

      const updated = await updateContent(
        db,
        testType,
        row.id,
        { title: 'Nouveau titre' },
        { expectedVersion: 'any' },
      )
      expect(updated?.title).toBe('Nouveau titre')
      expect(updated?.excerpt).toBe('Un extrait')
    })

    it('returns null rather than throwing for a document that is not there', async () => {
      const missing = '00000000-0000-4000-8000-0000000000ff'
      expect(
        await updateContent(db, testType, missing, { title: 'x' }, { expectedVersion: 'any' }),
      ).toBeNull()
    })
  })

  describe('atomicity', () => {
    it('records what the document was, not what it became', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ title: 'Avant' }),
      })

      await updateContent(db, testType, row.id, { title: 'Après' }, { expectedVersion: 'any' })

      const revisions = await db
        .select()
        .from(contentRevisions)
        .where(eq(contentRevisions.contentId, row.id))

      expect(revisions).toHaveLength(1)
      expect(revisions[0]?.title).toBe('Avant')
    })

    it('takes the revision with it when authorization refuses', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ title: 'Avant' }),
      })

      await expect(
        updateContent(
          db,
          testType,
          row.id,
          { title: 'Après' },
          {
            authorize: () => false,
            expectedVersion: 'any',
          },
        ),
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
        type: testType,
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
          expectedVersion: 'any',
        },
      )

      expect(sawTransition).toEqual(['draft', 'published'])
    })
  })

  describe('publishing what has come due', () => {
    const at = (iso: string) => new Date(iso)
    const NOW = at('2026-08-20T12:00:00.000Z')

    async function scheduled(slug: string, when: Date) {
      return createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ slug, status: 'scheduled', publishedAt: when }),
      })
    }

    it('publishes what is due and leaves the rest alone', async () => {
      const due = await scheduled('due-now', at('2026-08-20T11:00:00.000Z'))
      const later = await scheduled('due-later', at('2026-08-21T11:00:00.000Z'))
      const draft = await createContent(db, {
        type: testType,
        locale: 'en',
        authorId: null,
        state: state({ slug: 'still-drafting', status: 'draft' }),
      })

      const published = await publishDueContent(db, NOW)

      expect(published.map((row) => row.id)).toEqual([due.id])
      expect(published[0]?.status).toBe('published')
      expect((await findContentById(db, later.id))?.status).toBe('scheduled')
      expect((await findContentById(db, draft.id))?.status).toBe('draft')
    })

    /*
     * A schedule is a promise about a moment. An installation that was down
     * for an hour owes the documents that came due while it was gone, and
     * publishing them late is what an author expects — silently skipping them
     * is how a post never appears at all.
     */
    it('publishes what came due while nothing was running', async () => {
      const missed = await scheduled('missed-it', at('2026-08-19T09:00:00.000Z'))

      const published = await publishDueContent(db, NOW)

      expect(published.map((row) => row.id)).toContain(missed.id)
    })

    it('publishes exactly at the moment named, not a moment later', async () => {
      const exact = await scheduled('on-the-dot', NOW)

      expect(await publishDueContent(db, at('2026-08-20T11:59:59.999Z'))).toEqual([])
      expect((await publishDueContent(db, NOW)).map((row) => row.id)).toEqual([exact.id])
    })

    /*
     * A publication is a write, and every write in this file leaves the same
     * trace. It used to leave none: `status` and `updated_at` moved, the
     * version did not, and no revision was written — so a published document
     * sat at the version an editor still had open.
     */
    it('versions the row once and records the state it superseded', async () => {
      const when = at('2026-08-20T10:00:00.000Z')
      const row = await scheduled('a-promise-kept', when)
      expect(row.version).toBe(1)

      const [published] = await publishDueContent(db, NOW)

      expect(published?.status).toBe('published')
      expect(published?.version).toBe(2)
      // The moment it was promised for, not the moment it was noticed.
      expect(published?.publishedAt?.toISOString()).toBe(when.toISOString())

      const revisions = await listRevisions(db, row.id)
      expect(revisions).toHaveLength(1)

      const [snapshot] = revisions
      expect(snapshot).toMatchObject({
        version: 1,
        status: 'scheduled',
        slug: 'a-promise-kept',
        title: row.title,
        authorId: row.authorId,
        parentId: row.parentId,
      })
      expect(snapshot?.blocks).toEqual(row.blocks)
      expect(snapshot?.meta).toEqual(row.meta)
      expect(snapshot?.publishedAt?.toISOString()).toBe(when.toISOString())
    })

    /*
     * The defect, as a sequence. An editor opens a scheduled document, the
     * moment arrives, and their next save carries a form that still says
     * `scheduled` with the version they loaded. That save used to be accepted
     * — the row really was still at that version — and it took the
     * publication back down.
     */
    it('refuses the save of an editor who had it open when it went live', async () => {
      const row = await scheduled('open-in-a-tab', at('2026-08-20T10:00:00.000Z'))
      const openedAt = row.version

      await publishDueContent(db, NOW)

      const stale = updateContent(
        db,
        testType,
        row.id,
        { title: 'Edited while it was going live', status: 'scheduled' },
        { expectedVersion: openedAt },
      )

      await expect(stale).rejects.toBeInstanceOf(ContentConflictError)
      await expect(stale).rejects.toMatchObject({ reason: 'stale-version' })

      const after = await findContentById(db, row.id)
      expect(after?.status).toBe('published')
      expect(after?.version).toBe(openedAt + 1)
      // A refused save writes nothing, including no revision of its own.
      expect(await listRevisions(db, row.id)).toHaveLength(1)
    })

    /*
     * The property the whole design rests on: several API instances run this
     * on their own timers, and a document must be claimed — and therefore
     * versioned and announced to every hook handler — exactly once.
     *
     * The guarantee is no longer "it is one statement". It is the row lock,
     * the predicate re-evaluated under READ COMMITTED once the lock is
     * granted, and the transaction around both.
     */
    it('hands the document to one caller when two are made to run at once', async () => {
      /*
       * One row, so the control transaction below locks exactly what both
       * claimants will reach for, and there is no ordering to get wrong.
       *
       * `Promise.all` on its own proves nothing here: the first call can be
       * finished before the second one starts, and the test passes without
       * anything ever having overlapped. So the row is taken and held first,
       * both claimants are started and observed to be waiting, and only then
       * is it released — which is the moment the property is actually about.
       *
       * Nothing is asserted until the lock is released and every promise this
       * test started has settled. A failed expectation in the middle would
       * otherwise leave a transaction holding a row and two more waiting on
       * it, and the suite would hang rather than fail.
       */
      const row = await scheduled('race-for-one', at('2026-08-20T10:00:00.000Z'))
      const release = await holdContentRow(db, row.id)

      let finished = 0
      const claim = () =>
        held(
          publishDueContent(db, NOW).then((rows) => {
            finished += 1
            return rows
          }),
        )

      const first = claim()
      const second = claim()

      /* Recorded while the row is held; checked once everything has settled. */
      let waiting = 0
      let finishedWhileHeld = -1
      let claimed: string[] = []

      try {
        /*
         * Two observations, because one of them is weak on its own. Neither
         * claimant has finished — but "it had time and did nothing" is also
         * true of work that never started, so the database is asked directly
         * how many backends are blocked on a lock.
         */
        const deadline = Date.now() + 5_000
        while (Date.now() < deadline) {
          waiting = await backendsWaitingOnLocks(db)
          if (waiting >= 2) break
          await settle()
        }

        finishedWhileHeld = finished
      } finally {
        /*
         * Started, not awaited, before the claimants: the gate opens
         * synchronously inside it, so both can proceed while this waits for
         * the holding transaction to finish.
         */
        const releasing = release()
        const [firstRows, secondRows] = await Promise.all([first, second])
        claimed = [...firstRows, ...secondRows].map((claimedRow) => claimedRow.id)
        await releasing
      }

      expect(waiting).toBeGreaterThanOrEqual(2)
      expect(finishedWhileHeld).toBe(0)

      // Exactly one of the two got it, and it appears exactly once.
      expect(claimed.filter((id) => id === row.id)).toEqual([row.id])

      const after = await findContentById(db, row.id)
      expect(after?.status).toBe('published')
      // Twice-claimed would be 3. Never claimed would be 1.
      expect(after?.version).toBe(2)

      const revisions = await listRevisions(db, row.id)
      expect(revisions).toHaveLength(1)
      expect(revisions[0]).toMatchObject({ status: 'scheduled', version: 1 })

      // And nothing is left for a third caller to find.
      expect(await publishDueContent(db, NOW)).toEqual([])
    })

    /*
     * A publication is an ordinary write, so its revision is an ordinary
     * revision: it takes a place among the fifty rather than being exempt
     * from the cap, and what falls off the end is the oldest — not the one
     * just written.
     */
    it('spends one of the fifty revisions, and keeps the newest', async () => {
      const row = await scheduled('much-edited-then-published', at('2026-08-20T10:00:00.000Z'))

      for (let index = 0; index < REVISION_LIMIT; index += 1) {
        await updateContent(
          db,
          testType,
          row.id,
          { title: `Draft ${index}` },
          { expectedVersion: index + 1 },
        )
      }

      expect(await listRevisions(db, row.id, REVISION_LIMIT)).toHaveLength(REVISION_LIMIT)

      const [published] = await publishDueContent(db, NOW)
      expect(published?.version).toBe(REVISION_LIMIT + 2)

      const kept = await listRevisions(db, row.id, REVISION_LIMIT)
      expect(kept).toHaveLength(REVISION_LIMIT)

      // The publication's own revision survived; the oldest draft did not.
      expect(kept[0]).toMatchObject({
        status: 'scheduled',
        version: REVISION_LIMIT + 1,
        title: `Draft ${REVISION_LIMIT - 1}`,
      })
      // What fell off the end is the state it was created in.
      expect(kept.map((revision) => revision.title)).not.toContain('First')
    })

    /*
     * Atomic in both directions. A revision recording a supersession that
     * never happened is as wrong as a publication with no record of what it
     * replaced, and the only way to assert either is to break one half on
     * purpose — a trigger that refuses, scoped to one row and dropped again.
     */
    describe('when half of it fails', () => {
      /** Every message in the chain, because the driver wraps the store's. */
      async function refusalFrom(work: Promise<unknown>): Promise<string> {
        try {
          await work
          return 'it did not fail at all'
        } catch (error) {
          const messages: string[] = []
          let current: unknown = error
          while (current) {
            messages.push(String((current as { message?: unknown }).message ?? current))
            current = (current as { cause?: unknown }).cause
          }
          return messages.join(' | ')
        }
      }

      async function refusing(
        table: string,
        column: string,
        id: string,
      ): Promise<() => Promise<void>> {
        await db.execute(sql`
          create or replace function presslabz_refuse() returns trigger
          language plpgsql as $$ begin raise exception 'refused, on purpose'; end $$
        `)
        await db.execute(
          sql.raw(`
            create trigger presslabz_refuse_trigger before insert or update on ${table}
            for each row when (new.${column} = '${id}') execute function presslabz_refuse()
          `),
        )

        return async () => {
          await db.execute(sql.raw(`drop trigger if exists presslabz_refuse_trigger on ${table}`))
          await db.execute(sql`drop function if exists presslabz_refuse()`)
        }
      }

      it('writes no revision when the publication itself cannot be written', async () => {
        const row = await scheduled('update-refused', at('2026-08-20T10:00:00.000Z'))
        const drop = await refusing('contents', 'id', row.id)

        try {
          expect(await refusalFrom(publishDueContent(db, NOW))).toMatch(/refused, on purpose/)
        } finally {
          await drop()
        }

        const after = await findContentById(db, row.id)
        expect(after?.status).toBe('scheduled')
        expect(after?.version).toBe(1)
        expect(await listRevisions(db, row.id)).toEqual([])
      })

      it('publishes nothing when the revision cannot be written', async () => {
        const row = await scheduled('revision-refused', at('2026-08-20T10:00:00.000Z'))
        const drop = await refusing('content_revisions', 'content_id', row.id)

        try {
          expect(await refusalFrom(publishDueContent(db, NOW))).toMatch(/refused, on purpose/)
        } finally {
          await drop()
        }

        const after = await findContentById(db, row.id)
        expect(after?.status).toBe('scheduled')
        expect(after?.version).toBe(1)
        expect(await listRevisions(db, row.id)).toEqual([])
      })
    })

    it('finds nothing to do twice in a row', async () => {
      await scheduled('once-only', at('2026-08-20T10:00:00.000Z'))

      expect((await publishDueContent(db, NOW)).length).toBeGreaterThan(0)
      expect(await publishDueContent(db, NOW)).toEqual([])
    })
  })

  describe('clearing a field', () => {
    const NESTING = 'test-nesting'
    const nestingType = defineContentType({ name: NESTING, hierarchical: true, mediaIn: () => [] })

    it('removes a parent when the patch says null, and keeps it when silent', async () => {
      const parent = await createContent(db, {
        type: nestingType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'le-parent' }),
      })
      const child = await createContent(db, {
        type: nestingType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'l-enfant', parentId: parent.id }),
      })

      const renamed = await updateContent(
        db,
        nestingType,
        child.id,
        { title: 'Renommé' },
        {
          expectedVersion: 1,
        },
      )
      expect(renamed?.parentId).toBe(parent.id)

      const detached = await updateContent(
        db,
        nestingType,
        child.id,
        { parentId: null },
        {
          expectedVersion: 2,
        },
      )
      expect(detached?.parentId).toBeNull()
    })
  })

  describe('history a restore can use', () => {
    it('snapshots every editorial field, not the three somebody thought of', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({
          slug: 'complete-snapshot',
          title: 'Avant',
          excerpt: 'Le résumé',
          status: 'draft',
        }),
      })

      await updateContent(db, testType, row.id, { title: 'Après' }, { expectedVersion: 1 })

      const [snapshot] = await listRevisions(db, row.id)

      expect(snapshot).toMatchObject({
        slug: 'complete-snapshot',
        title: 'Avant',
        excerpt: 'Le résumé',
        status: 'draft',
        version: 1,
      })
      expect(snapshot?.publishedAt).toBeNull()
    })

    it('counts the version up on every write', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'counted' }),
      })

      expect(row.version).toBe(1)

      const second = await updateContent(
        db,
        testType,
        row.id,
        { title: 'Deux' },
        {
          expectedVersion: 1,
        },
      )
      expect(second?.version).toBe(2)

      const third = await updateContent(
        db,
        testType,
        row.id,
        { title: 'Trois' },
        {
          expectedVersion: 2,
        },
      )
      expect(third?.version).toBe(3)
    })

    /*
     * The lock serializes the two writes; it does not notice that the second
     * was composed against a version the first replaced. Without this the
     * later save wins and the earlier author's work is gone with no error.
     */
    it('refuses a write composed against a version that has moved', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'contested-row' }),
      })

      await updateContent(db, testType, row.id, { title: 'Premier' }, { expectedVersion: 1 })

      await expect(
        updateContent(db, testType, row.id, { title: 'Second' }, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ reason: 'stale-version' })

      expect((await findContentById(db, row.id))?.title).toBe('Premier')
    })

    it('lets a caller say it does not care, and only if it says so', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'restores-and-migrations' }),
      })

      await updateContent(db, testType, row.id, { title: 'Un' }, { expectedVersion: 1 })
      const forced = await updateContent(
        db,
        testType,
        row.id,
        { title: 'Deux' },
        {
          expectedVersion: 'any',
        },
      )

      expect(forced?.title).toBe('Deux')
    })

    /*
     * A cap rather than a duration: a document edited twice a year keeps its
     * history, and one edited by an automation does not fill the table.
     */
    it('keeps a bounded history', async () => {
      const row = await createContent(db, {
        type: testType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'much-edited' }),
      })

      for (let index = 0; index < REVISION_LIMIT + 5; index += 1) {
        await updateContent(
          db,
          testType,
          row.id,
          { title: `Version ${index}` },
          {
            expectedVersion: index + 1,
          },
        )
      }

      const kept = await listRevisions(db, row.id, REVISION_LIMIT)

      expect(kept.length).toBe(REVISION_LIMIT)
      // The oldest went, not the newest.
      expect(kept[0]?.title).toBe(`Version ${REVISION_LIMIT + 3}`)
    })
  })

  describe('what a parent may be', () => {
    const TREE = 'test-tree'
    const treeType = defineContentType({ name: TREE, hierarchical: true, mediaIn: () => [] })
    const otherTreeType = defineContentType({
      name: 'test-other-tree',
      hierarchical: true,
      mediaIn: () => [],
    })

    async function page(slug: string, parentId?: string, locale = 'fr') {
      return createContent(db, {
        type: treeType,
        locale,
        authorId: null,
        state: state({ slug, ...(parentId === undefined ? {} : { parentId }) }),
      })
    }

    it('refuses a parent that does not exist', async () => {
      await expect(page('orphan', '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({
        reason: 'parent-not-found',
      })
    })

    /*
     * The composite foreign key makes this impossible; the check is here so
     * the answer names what is wrong instead of surfacing a driver error.
     */
    it('refuses a parent in another language', async () => {
      const english = await page('english-parent', undefined, 'en')

      await expect(page('french-child', english.id)).rejects.toMatchObject({
        reason: 'parent-mismatch',
      })
    })

    it('refuses a parent of another type', async () => {
      const otherType = await createContent(db, {
        type: otherTreeType,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'not-a-page' }),
      })

      await expect(page('wrong-kind', otherType.id)).rejects.toMatchObject({
        reason: 'parent-mismatch',
      })
    })

    it('refuses a document that would be its own parent', async () => {
      const alone = await page('itself')

      await expect(
        updateContent(db, treeType, alone.id, { parentId: alone.id }, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ reason: 'parent-cycle' })
    })

    /*
     * The case the read path had to defend against twice: a document under one
     * of its own descendants has no root, so it has no path and no URL.
     */
    it('refuses a document placed under its own child', async () => {
      const top = await page('grandparent')
      const middle = await page('parent-page', top.id)
      const bottom = await page('child-page', middle.id)

      await expect(
        updateContent(db, treeType, top.id, { parentId: bottom.id }, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ reason: 'parent-cycle' })
    })

    it('refuses a tree deeper than a URL can express', async () => {
      let parent = await page('depth-1')
      for (let level = 2; level <= MAX_HIERARCHY_DEPTH; level += 1) {
        parent = await page(`depth-${level}`, parent.id)
      }

      await expect(page(`depth-${MAX_HIERARCHY_DEPTH + 1}`, parent.id)).rejects.toMatchObject({
        reason: 'parent-too-deep',
      })
    })

    /*
     * The document's own depth is not the whole question: everything under it
     * moves down with it, and those leaves would have no URL either.
     */
    it('refuses a move that would take the children past the limit', async () => {
      let deep = await page('graft-1')
      for (let level = 2; level < MAX_HIERARCHY_DEPTH; level += 1) {
        deep = await page(`graft-${level}`, deep.id)
      }

      const branchTop = await page('branch-top')
      const branchLeaf = await page('branch-leaf', branchTop.id)
      expect(branchLeaf.parentId).toBe(branchTop.id)

      await expect(
        updateContent(db, treeType, branchTop.id, { parentId: deep.id }, { expectedVersion: 1 }),
      ).rejects.toMatchObject({ reason: 'parent-too-deep' })
    })

    it('accepts an ordinary nesting, and lets it be undone', async () => {
      const parent = await page('ordinary-parent')
      const child = await page('ordinary-child')

      const nested = await updateContent(
        db,
        treeType,
        child.id,
        { parentId: parent.id },
        {
          expectedVersion: 1,
        },
      )
      expect(nested?.parentId).toBe(parent.id)

      const detached = await updateContent(
        db,
        treeType,
        child.id,
        { parentId: null },
        {
          expectedVersion: 2,
        },
      )
      expect(detached?.parentId).toBeNull()
    })

    /*
     * Documented behaviour: children become roots rather than disappearing.
     * Deleting an index page must not silently delete the pages under it.
     */
    it('turns children into roots when their parent is deleted', async () => {
      const parent = await page('doomed-parent')
      const child = await page('surviving-child', parent.id)

      await deleteContent(db, parent.id, {})

      const after = await findContentById(db, child.id)
      expect(after).not.toBeNull()
      expect(after?.parentId).toBeNull()
    })
  })
})
