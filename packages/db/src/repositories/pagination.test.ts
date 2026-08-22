import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { contents, translationGroups } from '../schema/contents.ts'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '../testing.ts'
import { listContents } from './contents.ts'

/**
 * Whether a page stays a page as the archive grows.
 *
 * The listing is the one query whose cost is allowed to be paid on every
 * screen of the admin, and nothing served it: `contents_listing_idx` leads
 * with (type, locale) and continues with status and published_at, while the
 * listing sorts by modification time — so every page read the whole filtered
 * set and sorted it, and the tenth page read it again.
 *
 * Asserting that from the plan rather than from a stopwatch. A timing test on
 * a laptop measures the laptop; `EXPLAIN ANALYZE` says which index was used
 * and how many rows were actually touched, which is the claim being made.
 *
 * The statement examined is the one the repository sent, captured through
 * drizzle's logger — not a hand-written equivalent, which would be a second
 * query that agrees with the first until somebody edits one of them.
 */
const ready = hasIntegrationEnv()

/** Enough rows that a sequential scan is a visibly different plan. */
const ROWS = 4000
const PAGE = 25

interface PlanNode {
  'Node Type': string
  'Index Name'?: string
  'Actual Rows'?: number
  Plans?: PlanNode[]
}

function walk(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(walk)]
}

describe.skipIf(!ready)('a page of the listing, at volume', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let client: ReturnType<typeof postgres>
  let db: ReturnType<typeof drizzle>
  const statements: { sql: string; params: unknown[] }[] = []

  beforeAll(async () => {
    scratch = await createScratchDatabase('pagination')
    client = postgres(scratch.url, { max: 4 })
    db = drizzle(client, {
      casing: 'snake_case',
      // The point of building the handle here rather than with createDb: the
      // statement under examination has to be the one the repository sent.
      logger: { logQuery: (sql, params) => statements.push({ sql, params }) },
    })

    const now = Date.now()

    // One group per row: a group holds at most one document per language, so
    // sharing one would be a fixture the schema refuses — and it does.
    const groups = Array.from({ length: ROWS }, () => ({ id: randomUUID(), type: 'post' }))
    for (let start = 0; start < groups.length; start += 500) {
      await db.insert(translationGroups).values(groups.slice(start, start + 500))
    }

    const rows = Array.from({ length: ROWS }, (_, index) => ({
      id: randomUUID(),
      type: 'post',
      translationGroupId: groups[index]?.id as string,
      locale: index % 4 === 0 ? 'fr' : 'en',
      slug: `row-${index}`,
      title: `Row ${index}`,
      status: index % 3 === 0 ? ('draft' as const) : ('published' as const),
      blocks: [],
      meta: {},
      // Spread over a year, one minute apart, so the sort has real work to do.
      updatedAt: new Date(now - index * 60_000),
      createdAt: new Date(now - index * 60_000),
    }))

    for (let start = 0; start < rows.length; start += 500) {
      await db.insert(contents).values(rows.slice(start, start + 500))
    }

    // Without statistics the planner is guessing, and a plan chosen from
    // guesses is not evidence of anything.
    await client.unsafe('analyze contents')
  }, 120_000)

  afterAll(async () => {
    await client?.end({ timeout: 5 })
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /** Runs the repository, then explains the statement it sent. */
  async function planOf(call: () => Promise<unknown>): Promise<PlanNode[]> {
    statements.length = 0
    await call()

    const statement = statements.at(-1)
    if (!statement) throw new Error('the repository sent no statement to explain')

    const explained = await client.unsafe(
      `explain (analyze, format json) ${statement.sql}`,
      statement.params as never[],
    )

    const plan = (explained[0] as unknown as { 'QUERY PLAN': { Plan: PlanNode }[] })[
      'QUERY PLAN'
    ][0]
    if (!plan) throw new Error('no plan')
    return walk(plan.Plan)
  }

  const query = { type: 'post', locale: 'en', limit: PAGE } as const

  it('reads the listing through the index built for it', async () => {
    const nodes = await planOf(() => listContents(db as never, query))

    expect(nodes.map((node) => node['Index Name'])).toContain('contents_updated_idx')
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Seq Scan')
  })

  /*
   * The half that matters more than the index name. A plan that sorts is a
   * plan that read everything first, whatever it read it through.
   */
  it('does not sort the whole archive to hand back twenty-five rows', async () => {
    const nodes = await planOf(() => listContents(db as never, query))

    expect(nodes.map((node) => node['Node Type'])).not.toContain('Sort')
    expect(nodes.map((node) => node['Node Type'])).not.toContain('Incremental Sort')
  })

  /*
   * The claim keyset pagination exists to make: the hundredth page costs what
   * the first one costs. With an offset the scan reads offset + limit rows and
   * throws away the offset — the same query, three thousand rows in, reading
   * three thousand rows to return twenty-five.
   */
  it('reads no more of the table on a deep page than on the first', async () => {
    const first = await planOf(() => listContents(db as never, query))

    // A cursor a hundred and twenty pages in.
    const deep = await listContents(db as never, { ...query, limit: 3000 })
    const anchor = deep.at(-1)
    expect(anchor).toBeDefined()

    const nodes = await planOf(() =>
      listContents(db as never, {
        ...query,
        after: { at: anchor?.updatedAt as Date, id: anchor?.id as string },
      }),
    )

    const rowsRead = (plan: PlanNode[]) =>
      Math.max(...plan.map((node) => node['Actual Rows'] ?? 0), 0)

    expect(rowsRead(nodes)).toBeLessThanOrEqual(PAGE)
    expect(rowsRead(nodes)).toBeLessThanOrEqual(rowsRead(first))
  })
})
