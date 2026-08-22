import { randomUUID } from 'node:crypto'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '../testing.ts'

/**
 * What the terms tables refuse.
 *
 * These tables carry no repository and no routes — the feature is reserved,
 * and `docs/ARCHITECTURE.md` says so. What they do carry is every invariant it
 * will need, which is the point of this suite: a schema that is present and
 * unconstrained invites rows that a later version cannot make sense of, and
 * the migration that repairs them is written against data nobody can
 * reconstruct.
 *
 * Asserted through SQL rather than through a repository, because there is no
 * repository to assert through. The database is the whole subject here.
 */
const ready = hasIntegrationEnv()

describe.skipIf(!ready)('the terms schema', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  const CATEGORY = randomUUID()
  const ENGLISH_TERM = randomUUID()
  const FRENCH_TERM = randomUUID()
  let englishPost: string

  beforeAll(async () => {
    scratch = await createScratchDatabase('terms')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db

    await db.execute(
      sql`insert into term_groups (id, taxonomy) values (${CATEGORY}::uuid, 'category')`,
    )
    await db.execute(sql`
      insert into terms (id, taxonomy, locale, translation_group_id, slug, name)
      values (${ENGLISH_TERM}::uuid, 'category', 'en', ${CATEGORY}::uuid, 'news', 'News'),
             (${FRENCH_TERM}::uuid, 'category', 'fr', ${CATEGORY}::uuid, 'actualites', 'Actualités')
    `)

    const group = randomUUID()
    englishPost = randomUUID()
    await db.execute(sql`insert into translation_groups (id, type) values (${group}::uuid, 'post')`)
    await db.execute(sql`
      insert into contents (id, type, locale, translation_group_id, slug, title, status, blocks, meta)
      values (${englishPost}::uuid, 'post', 'en', ${group}::uuid, 'a-post', 'A post', 'draft', '[]'::jsonb, '{}'::jsonb)
    `)
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /** The constraint a statement broke, or null when the database took it. */
  async function refusalFor(statement: ReturnType<typeof sql>): Promise<string | null> {
    try {
      await db.execute(statement)
      return null
    } catch (error) {
      const message = String((error as { cause?: unknown }).cause ?? error)
      return /constraint "([^"]+)"/.exec(message)?.[1] ?? message
    }
  }

  describe('a group holds one taxonomy and one translation per language', () => {
    /*
     * `translationGroupId` used to default to a fresh uuid with no group to
     * point at, so both of these were rows the database would have accepted —
     * and a second English "News" is a term nothing can choose between.
     */
    it('refuses a second translation in the same language', async () => {
      expect(
        await refusalFor(sql`
          insert into terms (taxonomy, locale, translation_group_id, slug, name)
          values ('category', 'en', ${CATEGORY}::uuid, 'news-again', 'News again')
        `),
      ).toBe('terms_group_locale_uq')
    })

    it('refuses a term of another taxonomy in the group', async () => {
      expect(
        await refusalFor(sql`
          insert into terms (taxonomy, locale, translation_group_id, slug, name)
          values ('tag', 'de', ${CATEGORY}::uuid, 'neu', 'Neu')
        `),
      ).toBe('terms_group_fk')
    })

    it('refuses a group nobody created', async () => {
      expect(
        await refusalFor(sql`
          insert into terms (taxonomy, locale, translation_group_id, slug, name)
          values ('category', 'de', ${randomUUID()}::uuid, 'neu', 'Neu')
        `),
      ).toBe('terms_group_fk')
    })
  })

  describe('a parent is the same kind of thing, in the same language', () => {
    it('refuses a parent in another language', async () => {
      expect(
        await refusalFor(
          sql`update terms set parent_id = ${FRENCH_TERM}::uuid where id = ${ENGLISH_TERM}::uuid`,
        ),
      ).toBe('terms_parent_fk')
    })

    it('refuses a term that is its own parent', async () => {
      expect(
        await refusalFor(
          sql`update terms set parent_id = ${ENGLISH_TERM}::uuid where id = ${ENGLISH_TERM}::uuid`,
        ),
      ).toBe('terms_parent_not_self')
    })

    it('accepts one in the same taxonomy and language', async () => {
      const child = randomUUID()
      const group = randomUUID()
      await db.execute(
        sql`insert into term_groups (id, taxonomy) values (${group}::uuid, 'category')`,
      )

      expect(
        await refusalFor(sql`
          insert into terms (id, taxonomy, locale, translation_group_id, slug, name, parent_id)
          values (${child}::uuid, 'category', 'en', ${group}::uuid, 'sport', 'Sport', ${ENGLISH_TERM}::uuid)
        `),
      ).toBeNull()
    })
  })

  describe('filing a document under a term', () => {
    /*
     * The join carried two foreign keys and nothing else, so an English post
     * under a French category was a row it would hold — and a listing built
     * from it would show a category the reader cannot follow.
     */
    it('refuses a term in another language', async () => {
      expect(
        await refusalFor(sql`
          insert into content_terms (content_id, term_id, type, locale, taxonomy)
          values (${englishPost}::uuid, ${FRENCH_TERM}::uuid, 'post', 'en', 'category')
        `),
      ).toBe('content_terms_term_fk')
    })

    it('refuses a row that misstates the document', async () => {
      // The type and language on the row must be the document's own.
      expect(
        await refusalFor(sql`
          insert into content_terms (content_id, term_id, type, locale, taxonomy)
          values (${englishPost}::uuid, ${ENGLISH_TERM}::uuid, 'page', 'en', 'category')
        `),
      ).toBe('content_terms_content_fk')
    })

    it('refuses a row that misstates the term', async () => {
      expect(
        await refusalFor(sql`
          insert into content_terms (content_id, term_id, type, locale, taxonomy)
          values (${englishPost}::uuid, ${ENGLISH_TERM}::uuid, 'post', 'en', 'tag')
        `),
      ).toBe('content_terms_term_fk')
    })

    it('accepts one where both sides agree', async () => {
      expect(
        await refusalFor(sql`
          insert into content_terms (content_id, term_id, type, locale, taxonomy)
          values (${englishPost}::uuid, ${ENGLISH_TERM}::uuid, 'post', 'en', 'category')
        `),
      ).toBeNull()
    })
  })
})
