import { CONTENT_STATUSES, type ContentStatus, isPubliclyVisible } from '@presslabz/core'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { contents } from '../schema/contents.ts'
import { createScratchDatabase, hasIntegrationEnv } from '../testing.ts'
import { type ContentRow, type ContentState, createContent } from './contents.ts'
import {
  countPublished,
  findPublishedBySlug,
  listPublished,
  listPublishedPaths,
  listPublishedTranslations,
  resolveAncestry,
} from './public-contents.ts'

/*
 * A real Postgres, for the same reason the write path uses one: what is being
 * asserted is what the database returns, and the central claim — that the SQL
 * predicate and the domain rule select the same rows — is meaningless against
 * a fake that implements one of them.
 */
const ready = hasIntegrationEnv()

const NOW = new Date('2026-08-20T12:00:00.000Z')
const PAST = new Date('2026-08-19T12:00:00.000Z')
const FUTURE = new Date('2026-08-21T12:00:00.000Z')

function state(overrides: Partial<ContentState> = {}): ContentState {
  return { slug: 'first', title: 'First', status: 'draft', blocks: [], meta: {}, ...overrides }
}

describe.skipIf(!ready)('public content reads', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    scratch = await createScratchDatabase('public')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  })

  /** Its own type per group of tests, so no two of them can see each other. */
  async function open(type: string, overrides: Partial<ContentState>): Promise<ContentRow> {
    return createContent(db, {
      type,
      locale: 'en',
      authorId: null,
      state: state(overrides),
    })
  }

  describe('visibility', () => {
    const TYPE = 'public-matrix'
    const dates: readonly (Date | null)[] = [PAST, NOW, FUTURE, null]
    const fixtures: { row: ContentRow; status: ContentStatus; publishedAt: Date | null }[] = []

    beforeAll(async () => {
      for (const status of CONTENT_STATUSES) {
        for (const [index, publishedAt] of dates.entries()) {
          const row = await createContent(db, {
            type: TYPE,
            locale: 'en',
            authorId: null,
            state: state({
              slug: `${status}-${index}`,
              title: `${status} ${index}`,
              status,
              ...(publishedAt === null ? {} : { publishedAt }),
            }),
          })
          fixtures.push({ row, status, publishedAt })
        }
      }
    })

    /*
     * The one test that justifies restating the rule in SQL. Every status
     * crossed with every relation the date can have to now, both halves asked
     * the same question, and the answers compared as sets rather than counted.
     */
    it('selects exactly what the domain rule selects', async () => {
      const rows = await listPublished(db, { type: TYPE, locale: 'en', now: NOW, limit: 100 })

      const fromSql = new Set(rows.map((row) => row.slug))
      const fromDomain = new Set(
        fixtures
          .filter((fixture) => isPubliclyVisible(fixture.row, NOW))
          .map((fixture) => fixture.row.slug),
      )

      expect(fromSql).toEqual(fromDomain)
      expect(fromDomain.size).toBeGreaterThan(0)
    })

    it('counts the same set it lists', async () => {
      const total = await countPublished(db, { type: TYPE, locale: 'en', now: NOW })
      const rows = await listPublished(db, { type: TYPE, locale: 'en', now: NOW, limit: 100 })
      expect(total).toBe(rows.length)
    })

    it('withholds a published document until its date arrives, then releases it', async () => {
      const query = { type: TYPE, locale: 'en', slug: 'published-2' } as const

      expect(await findPublishedBySlug(db, { ...query, now: NOW })).toBeNull()
      expect(await findPublishedBySlug(db, { ...query, now: FUTURE })).not.toBeNull()
    })

    it('never releases a scheduled document, however old its date', async () => {
      const found = await findPublishedBySlug(db, {
        type: TYPE,
        locale: 'en',
        slug: 'scheduled-0',
        now: FUTURE,
      })
      expect(found).toBeNull()
    })
  })

  describe('scoping', () => {
    const TYPE = 'public-scope'

    beforeAll(async () => {
      const english = await open(TYPE, { slug: 'shared', status: 'published', publishedAt: PAST })
      await createContent(db, {
        type: TYPE,
        locale: 'fr',
        translationGroupId: english.translationGroupId,
        authorizeJoin: () => true,
        authorId: null,
        state: state({ slug: 'partage', title: 'Partagé', status: 'draft' }),
      })
      await open(TYPE, { slug: 'other-draft', status: 'draft' })
    })

    it('does not answer one locale with another locale row', async () => {
      expect(
        await findPublishedBySlug(db, { type: TYPE, locale: 'fr', slug: 'shared', now: NOW }),
      ).toBeNull()
    })

    it('omits a translation that is not public yet', async () => {
      const english = await findPublishedBySlug(db, {
        type: TYPE,
        locale: 'en',
        slug: 'shared',
        now: NOW,
      })
      const siblings = await listPublishedTranslations(db, {
        translationGroupId: (english as ContentRow).translationGroupId,
        now: NOW,
      })

      expect(siblings.map((row) => row.locale)).toEqual(['en'])
    })
  })

  describe('pagination', () => {
    const TYPE = 'public-pages'
    const SIZE = 7

    beforeAll(async () => {
      for (let index = 0; index < SIZE; index += 1) {
        await open(TYPE, {
          slug: `page-${index}`,
          title: `Page ${index}`,
          status: 'published',
          // Deliberately identical dates: the tie-break is what is under test.
          publishedAt: PAST,
        })
      }
    })

    it('walks every document once across pages', async () => {
      const seen: string[] = []
      for (let offset = 0; offset < SIZE + 2; offset += 2) {
        const rows = await listPublished(db, {
          type: TYPE,
          locale: 'en',
          now: NOW,
          limit: 2,
          offset,
        })
        seen.push(...rows.map((row) => row.slug))
      }

      expect(seen).toHaveLength(SIZE)
      expect(new Set(seen).size).toBe(SIZE)
    })

    it('refuses to serve an unbounded page', async () => {
      const rows = await listPublished(db, {
        type: TYPE,
        locale: 'en',
        now: NOW,
        limit: Number.POSITIVE_INFINITY,
      })
      expect(rows.length).toBeLessThanOrEqual(SIZE)
    })
  })

  describe('every published path', () => {
    const TYPE = 'public-paths'

    it('reports each document once, with the path it is reachable at', async () => {
      const root = await open(TYPE, { slug: 'guide', status: 'published', publishedAt: PAST })
      await open(TYPE, {
        slug: 'chapter',
        status: 'published',
        publishedAt: PAST,
        parentId: root.id,
      })
      await open(TYPE, { slug: 'hidden', status: 'draft' })

      const rows = (await listPublishedPaths(db, { now: NOW })).filter((row) => row.type === TYPE)
      const paths = rows.map((row) => row.path.join('/')).sort()

      expect(paths).toEqual(['guide', 'guide/chapter'])

      /*
       * A raw query returns what the driver decoded, not what drizzle would
       * have typed: without mapping, these arrive as strings and the first
       * caller to call toISOString on one fails in production.
       */
      for (const row of rows) {
        expect(row.updatedAt).toBeInstanceOf(Date)
        expect(row.publishedAt === null || row.publishedAt instanceof Date).toBe(true)
        expect(row.translationGroupId).toMatch(/^[0-9a-f-]{36}$/)
      }
    })

    /*
     * A row inside a cycle has no root ancestor, so the walk never reaches it.
     * That is the right answer for a sitemap — a document with no resolvable
     * path has no canonical URL — and it is what makes the query terminate on
     * data the schema still allows.
     */
    it('omits a document whose path cannot be resolved', async () => {
      const first = await open(TYPE, { slug: 'ring-a', status: 'published', publishedAt: PAST })
      const second = await open(TYPE, {
        slug: 'ring-b',
        status: 'published',
        publishedAt: PAST,
        parentId: first.id,
      })
      await db.update(contents).set({ parentId: second.id }).where(eq(contents.id, first.id))

      const rows = await listPublishedPaths(db, { now: NOW })
      const slugs = rows.map((row) => row.slug)

      expect(slugs).not.toContain('ring-a')
      expect(slugs).not.toContain('ring-b')
    })

    it('withholds what is not public yet, whatever its depth', async () => {
      const rows = await listPublishedPaths(db, { now: NOW })
      const slugs = rows.map((row) => row.slug)

      expect(slugs).not.toContain('still-a-draft')
      expect(slugs).not.toContain('hidden')
    })
  })

  describe('ancestry', () => {
    const TYPE = 'public-tree'

    it('reads a nested path root first', async () => {
      const root = await open(TYPE, { slug: 'about', status: 'published', publishedAt: PAST })
      const child = await open(TYPE, {
        slug: 'team',
        status: 'published',
        publishedAt: PAST,
        parentId: root.id,
      })

      const ancestry = await resolveAncestry(db, { id: child.id, type: TYPE, locale: 'en' })

      expect(ancestry).toEqual({ slugs: ['about', 'team'], complete: true })
    })

    it('reports an unknown id as nothing rather than as a root', async () => {
      expect(
        await resolveAncestry(db, {
          id: '00000000-0000-4000-8000-000000000000',
          type: TYPE,
          locale: 'en',
        }),
      ).toBeNull()
    })

    /*
     * This walk used to be the only thing standing between a French parent and
     * an English URL: the state was representable, and the guard was to stop
     * at the language boundary and report an incomplete chain.
     *
     * It cannot be created any more — the composite foreign key on
     * (parent_id, type, locale) refuses it, and the repository names it before
     * the key has to — so what is asserted here is the invariant itself. The
     * filter stays in the query regardless: it costs nothing, and a database
     * restored from a backup taken before the constraint existed would still
     * hold rows that need it.
     */
    it('cannot be given a parent in another language at all', async () => {
      const frenchParent = await createContent(db, {
        type: TYPE,
        locale: 'fr',
        authorId: null,
        state: state({ slug: 'a-propos', title: 'À propos', status: 'published' }),
      })

      await expect(
        open(TYPE, {
          slug: 'stranded',
          status: 'published',
          publishedAt: PAST,
          parentId: frenchParent.id,
        }),
      ).rejects.toMatchObject({ reason: 'parent-mismatch' })
    })

    /*
     * `parentId` has no cycle check behind it, so this state is representable
     * today. The walk has to terminate and report failure — a recursive query
     * with no depth guard would not return at all.
     */
    it('terminates on a cycle instead of hanging', async () => {
      const first = await open(TYPE, { slug: 'loop-a', status: 'published', publishedAt: PAST })
      const second = await open(TYPE, {
        slug: 'loop-b',
        status: 'published',
        publishedAt: PAST,
        parentId: first.id,
      })
      await db.update(contents).set({ parentId: second.id }).where(eq(contents.id, first.id))

      const ancestry = await resolveAncestry(db, { id: second.id, type: TYPE, locale: 'en' })

      expect(ancestry?.complete).toBe(false)
    })
  })
})
