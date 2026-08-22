import { randomUUID } from 'node:crypto'
import { blocksToPlainText } from '@presslabz/blocks'
import { postType } from '@presslabz/core'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import { createScratchDatabase, hasIntegrationEnv } from '../testing.ts'
import { createContent } from './contents.ts'

/**
 * What a search would find, if there were one.
 *
 * `contents.search_vector` is a generated column and nothing queries it yet.
 * It indexed the title and the excerpt only — a search that cannot find a
 * paragraph, which is the thing people search for. It covers the document's
 * own words now, through an immutable SQL function that walks the blocks.
 *
 * That function is a second expression of `blocksToPlainText`, in another
 * language, and two expressions of one rule drift. These tests cross them:
 * every word the TypeScript extractor returns must be findable through the
 * column, for the same document.
 */
const ready = hasIntegrationEnv()

describe.skipIf(!ready)('the search vector', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let documentId: string

  /*
   * The image block names a real asset. A document cannot name one that does
   * not exist any more — the mirror's foreign key refuses the row — so this
   * suite creates the asset it is about to reference, which is also what a
   * person does through the picker.
   */
  const PICTURED = randomUUID()

  /** One of each block type that carries words, and one that carries none. */
  const blocks = [
    {
      id: randomUUID(),
      type: 'heading' as const,
      level: 2 as const,
      content: [{ type: 'text' as const, text: 'Cartography' }],
    },
    {
      id: randomUUID(),
      type: 'paragraph' as const,
      content: [{ type: 'text' as const, text: 'A paragraph about isopleths' }],
    },
    {
      id: randomUUID(),
      type: 'quote' as const,
      content: [{ type: 'text' as const, text: 'Quoted words' }],
      attribution: 'Attributed to somebody',
    },
    {
      id: randomUUID(),
      type: 'list' as const,
      ordered: false,
      items: [[{ type: 'text' as const, text: 'listed thing' }]],
    },
    { id: randomUUID(), type: 'code' as const, language: 'ts', code: 'const meridian = 1' },
    {
      id: randomUUID(),
      type: 'image' as const,
      mediaId: PICTURED,
      caption: [{ type: 'text' as const, text: 'a captioned photograph' }],
    },
    { id: randomUUID(), type: 'divider' as const },
  ]

  beforeAll(async () => {
    scratch = await createScratchDatabase('search')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db

    await db.execute(sql`
      insert into media (id, storage_key, mime_type, byte_size, width, height)
      values (${PICTURED}::uuid, 'media/searchable.avif', 'image/avif', 10, 4, 4)
    `)

    const created = await createContent(db, {
      type: postType,
      locale: 'en',
      authorId: null,
      state: {
        slug: 'a-searchable-document',
        title: 'Projections',
        excerpt: 'About the excerpt',
        status: 'draft',
        blocks,
        meta: {},
      },
    })
    documentId = created.id
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  })

  /** Whether the stored vector matches a query, as a search route would ask. */
  async function finds(term: string): Promise<boolean> {
    const rows = await db.execute<{ hit: boolean }>(sql`
      select search_vector @@ plainto_tsquery('simple', ${term}) as hit
      from contents where id = ${documentId}::uuid
    `)

    return Boolean((rows as unknown as { hit: boolean }[])[0]?.hit)
  }

  it('finds the title and the excerpt, as it always did', async () => {
    expect(await finds('Projections')).toBe(true)
    expect(await finds('excerpt')).toBe(true)
  })

  it.for([
    ['a heading', 'Cartography'],
    ['a paragraph', 'isopleths'],
    ['a quotation', 'Quoted'],
    ["a quotation's attribution", 'Attributed'],
    ['a list item', 'listed'],
    ['a code block', 'meridian'],
    ["an image's caption", 'captioned'],
  ])('finds %s', async ([, term]) => {
    expect(await finds(term as string)).toBe(true)
  })

  it('does not find what the document does not say', async () => {
    expect(await finds('isobar')).toBe(false)
  })

  /*
   * The column is generated, so this is not "does the write path remember to
   * reindex" — it cannot forget. What it proves is that the expression is
   * applied to the new value rather than to a cached one.
   */
  it('follows an edit', async () => {
    await db.execute(sql`
      update contents
         set blocks = ${JSON.stringify([
           {
             id: randomUUID(),
             type: 'paragraph',
             content: [{ type: 'text', text: 'entirely different words' }],
           },
         ])}::jsonb
       where id = ${documentId}::uuid
    `)

    expect(await finds('entirely')).toBe(true)
    expect(await finds('isopleths')).toBe(false)
  })

  /*
   * The SQL function and blocksToPlainText are one rule written twice. This is
   * what keeps them honest: every word one of them returns has to be findable
   * through the other.
   */
  it('indexes every word the plain-text extractor returns', async () => {
    await db.execute(sql`
      update contents set blocks = ${JSON.stringify(blocks)}::jsonb where id = ${documentId}::uuid
    `)

    const words = blocksToPlainText(blocks)
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word.length > 2)

    expect(words.length).toBeGreaterThan(5)

    for (const word of words) {
      expect(await finds(word), `"${word}" is in the text and not in the index`).toBe(true)
    }
  })
})
