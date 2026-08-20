import { type ContentStatus, PUBLIC_CONTENT_STATUSES } from '@presslabz/core'
import { and, asc, count, desc, eq, inArray, isNull, lte, or, type SQL, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { contents } from '../schema/contents.ts'
import type { ContentRow } from './contents.ts'

/**
 * The read path the public site uses, kept apart from the write path on
 * purpose: nothing here takes an actor, and no query here can be reached
 * without the visibility predicate below.
 *
 * The predicate is the SQL half of `isPubliclyVisible` in packages/core. Two
 * expressions of one rule is exactly the duplication this project treats as a
 * defect, and the alternative — fetching rows and filtering in JavaScript —
 * would mean paginating over a set the database cannot count. So the rule
 * stays in core, this restates it in SQL, and an integration test asserts the
 * two answer identically over every status and date combination. If that test
 * ever fails, the SQL is the copy that is wrong.
 */
function publiclyVisible(now: Date): SQL {
  const predicate = and(
    inArray(contents.status, [...PUBLIC_CONTENT_STATUSES] as ContentStatus[]),
    or(isNull(contents.publishedAt), lte(contents.publishedAt, now)),
  )
  // and() is only undefined when given nothing; both arguments are present.
  return predicate as SQL
}

/**
 * Newest first, and stable. `publishedAt` is nullable even on a published row,
 * so ordering on it alone puts those rows in whatever order the plan happens
 * to produce — and an unstable order is a paginated list that can show the
 * same document on two pages and skip a third. The fallback to `createdAt`
 * gives every row a date, and `id` breaks the remaining ties.
 */
const PUBLISHED_ORDER = [
  desc(sql`coalesce(${contents.publishedAt}, ${contents.createdAt})`),
  desc(contents.id),
]

/** A page nobody asked to be that large is a denial of service with a URL. */
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 20

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT
  if (!Number.isFinite(limit)) return DEFAULT_LIMIT
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)))
}

export interface PublishedListQuery {
  readonly type: string
  /** Required, like every listing. One language's archive. */
  readonly locale: string
  readonly now?: Date
  readonly limit?: number
  readonly offset?: number
}

export async function listPublished(
  db: Database,
  query: PublishedListQuery,
): Promise<ContentRow[]> {
  return db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.type, query.type),
        eq(contents.locale, query.locale),
        publiclyVisible(query.now ?? new Date()),
      ),
    )
    .orderBy(...PUBLISHED_ORDER)
    .limit(clampLimit(query.limit))
    .offset(Math.max(0, Math.trunc(query.offset ?? 0)))
}

/**
 * The total the listing is a page of. Separate from `listPublished` rather
 * than a window function beside it, because an archive's first page needs
 * both and its later pages need the count for the same reason — a page number
 * the reader can be sent to has to exist.
 */
export async function countPublished(
  db: Database,
  query: Omit<PublishedListQuery, 'limit' | 'offset'>,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(contents)
    .where(
      and(
        eq(contents.type, query.type),
        eq(contents.locale, query.locale),
        publiclyVisible(query.now ?? new Date()),
      ),
    )

  return rows[0]?.total ?? 0
}

export interface PublishedSlugQuery {
  readonly type: string
  readonly locale: string
  readonly slug: string
  readonly now?: Date
}

export async function findPublishedBySlug(
  db: Database,
  query: PublishedSlugQuery,
): Promise<ContentRow | null> {
  const rows = await db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.type, query.type),
        eq(contents.locale, query.locale),
        eq(contents.slug, query.slug),
        publiclyVisible(query.now ?? new Date()),
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/**
 * The published siblings of a document, for `hreflang` and the language
 * switcher. It crosses locales, which is the whole point, and says so in its
 * name — the same convention `listTranslations` follows on the write side.
 *
 * A sibling that is not public yet is simply absent. Announcing a translation
 * that answers 404 is worse than announcing none: a search engine follows it,
 * and a reader who switches language lands on nothing.
 */
export async function listPublishedTranslations(
  db: Database,
  query: { readonly translationGroupId: string; readonly now?: Date },
): Promise<ContentRow[]> {
  return db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.translationGroupId, query.translationGroupId),
        publiclyVisible(query.now ?? new Date()),
      ),
    )
    .orderBy(asc(contents.locale))
}

/**
 * How deep a page may nest before the walk gives up.
 *
 * It is a guard, not a limit anyone should reach. `parentId` has no cycle
 * check behind it yet, so a row that is its own ancestor is representable —
 * and a recursive query over a cycle does not terminate on its own. Eight is
 * far past any navigable page hierarchy, and an incomplete answer is reported
 * rather than returned as if it were a path.
 */
const MAX_ANCESTRY_DEPTH = 8

export interface Ancestry {
  /** Root first, the document's own slug last. */
  readonly slugs: readonly string[]
  /**
   * False when the chain hit the depth cap, or stopped at a parent that is
   * missing from this type and locale. The caller must not build a URL out of
   * an incomplete chain: it would be a path to a different document, or to
   * none, presented as canonical.
   */
  readonly complete: boolean
}

/** Extends the index signature drizzle's `execute` generic requires. */
interface AncestryRow extends Record<string, unknown> {
  slug: string
  depth: number
  parent_id: string | null
}

/**
 * The slug path of a document, resolved in one round trip.
 *
 * Pages nest, and the unique index is on `(type, locale, slug)` rather than on
 * a path — so a slug already identifies a row, and the ancestors are only
 * needed to know which URL is the canonical one. That is also why the walk is
 * restricted to the same type and locale: a parent in another language is not
 * part of this language's path, and following it would produce a URL that
 * mixes the two.
 */
export async function resolveAncestry(
  db: Database,
  query: { readonly id: string; readonly type: string; readonly locale: string },
): Promise<Ancestry | null> {
  const result = await db.execute<AncestryRow>(sql`
    with recursive ancestry as (
      select id, parent_id, slug, 1 as depth
      from ${contents}
      where id = ${query.id}
        and type = ${query.type}
        and locale = ${query.locale}
      union all
      select parent.id, parent.parent_id, parent.slug, child.depth + 1
      from ${contents} parent
      join ancestry child on parent.id = child.parent_id
      where child.depth < ${MAX_ANCESTRY_DEPTH}
        and parent.type = ${query.type}
        and parent.locale = ${query.locale}
    )
    select slug, depth, parent_id from ancestry order by depth desc
  `)

  const rows = [...result]
  if (rows.length === 0) return null

  // Ordered deepest first, so the last row of the walk is the topmost one
  // reached. The chain is complete only when that row is an actual root.
  const topmost = rows[0] as AncestryRow
  return {
    slugs: rows.map((row) => row.slug),
    complete: topmost.parent_id === null,
  }
}
