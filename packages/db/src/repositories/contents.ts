import type { Blocks } from '@presslabz/blocks'
import { type AnyContentType, type ContentStatus, PUBLIC_CONTENT_STATUSES } from '@presslabz/core'
import { and, desc, eq, inArray, or } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { contentRevisions, contents } from '../schema/contents.ts'

/**
 * Reads are locale-scoped and there is no way to ask for "all locales" by
 * accident: `locale` is a required field on every query below, and the one
 * function that deliberately crosses locales says so in its name.
 *
 * Retrofitting locale into a content model touches every query, route and
 * cache key, which is why it is here from the first call rather than added
 * once the shape of the admin is settled.
 */

export type ContentRow = typeof contents.$inferSelect

/** The columns a caller may set. Ids, timestamps and authorship are ours. */
export interface ContentState {
  readonly slug: string
  readonly title: string
  readonly excerpt?: string | undefined
  readonly status: ContentStatus
  readonly blocks: Blocks
  readonly meta: Record<string, unknown>
  readonly publishedAt?: Date | undefined
  readonly parentId?: string | undefined
}

export type ContentConflictReason = 'translation-exists' | 'group-type-mismatch' | 'slug-taken'

/**
 * Assigned in the body rather than declared as a constructor parameter
 * property. Node 24 strips types rather than compiling them, and a parameter
 * property is the one piece of TypeScript that needs real emit — `tsc
 * --noEmit` accepts it and the API then fails to load the module at runtime.
 */
export class ContentConflictError extends Error {
  readonly reason: ContentConflictReason

  constructor(reason: ContentConflictReason, message: string) {
    super(message)
    this.name = 'ContentConflictError'
    this.reason = reason
  }
}

export class ContentForbiddenError extends Error {
  constructor(message = 'Not allowed to write this document') {
    super(message)
    this.name = 'ContentForbiddenError'
  }
}

/** Postgres unique violation. */
const UNIQUE_VIOLATION = '23505'

interface DriverError {
  code?: unknown
  constraint_name?: unknown
}

/**
 * Drizzle wraps the driver's error and puts the real one on `cause`, so the
 * SQLSTATE is not on the object that arrives here. Walking the chain rather
 * than reading the top level is what makes this work — and what stops it
 * silently reverting to "unknown error" if that wrapping ever changes again.
 */
function driverError(error: unknown): DriverError | null {
  let current: unknown = error

  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null; depth++) {
    const candidate = current as DriverError & { cause?: unknown }
    if (candidate.code !== undefined) return candidate
    current = candidate.cause
  }

  return null
}

function isUniqueViolation(error: unknown): boolean {
  return driverError(error)?.code === UNIQUE_VIOLATION
}

/**
 * Turns the database's own guarantee into the same error the in-transaction
 * check raises, so a caller sees one failure mode whether it lost a race or
 * was simply wrong.
 */
function translateUniqueViolation(error: unknown): never {
  const constraint = String(driverError(error)?.constraint_name ?? '')

  if (constraint === 'contents_group_locale_uq') {
    throw new ContentConflictError(
      'translation-exists',
      'That translation group already has a document in this language',
    )
  }
  if (constraint === 'contents_type_locale_slug_uq') {
    throw new ContentConflictError('slug-taken', 'That slug is already used in this language')
  }
  throw error
}

/** Rows carry null where the domain uses absence. */
function toState(row: ContentRow): ContentState {
  return {
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt ?? undefined,
    status: row.status,
    blocks: row.blocks,
    meta: row.meta,
    publishedAt: row.publishedAt ?? undefined,
    parentId: row.parentId ?? undefined,
  }
}

/** Absent means "leave it alone", so an undefined value must not overwrite. */
function definedEntries(patch: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined))
}

function toColumns(state: ContentState) {
  return {
    slug: state.slug,
    title: state.title,
    excerpt: state.excerpt ?? null,
    status: state.status,
    blocks: state.blocks,
    meta: state.meta,
    publishedAt: state.publishedAt ?? null,
    parentId: state.parentId ?? null,
  }
}

export interface ListContentsQuery {
  readonly type: string
  /** Required. Every listing is one language's listing. */
  readonly locale: string
  readonly statuses?: readonly ContentStatus[]
  /**
   * Restricts the listing to what one actor is allowed to see: anything
   * published, plus anything they wrote. Omit only for an actor who may
   * already read every draft.
   *
   * This is a filter, not a nicety. `content:read` is held by every role
   * including subscriber, so a listing that ignores authorship hands every
   * unpublished document to anyone who can log in.
   */
  readonly visibleTo?: { readonly authorId: string | null }
  readonly limit?: number
  readonly offset?: number
}

export async function listContents(db: Database, query: ListContentsQuery): Promise<ContentRow[]> {
  const filters = [eq(contents.type, query.type), eq(contents.locale, query.locale)]
  if (query.statuses && query.statuses.length > 0) {
    filters.push(inArray(contents.status, [...query.statuses]))
  }

  if (query.visibleTo) {
    const published = inArray(contents.status, [...PUBLIC_CONTENT_STATUSES])
    const authorId = query.visibleTo.authorId
    // An anonymous actor authored nothing, so they get the published set only.
    const visible = authorId === null ? published : or(published, eq(contents.authorId, authorId))
    if (visible) filters.push(visible)
  }

  return db
    .select()
    .from(contents)
    .where(and(...filters))
    .orderBy(desc(contents.updatedAt))
    .limit(query.limit ?? 50)
    .offset(query.offset ?? 0)
}

export async function findContentBySlug(
  db: Database,
  where: { type: string; locale: string; slug: string },
): Promise<ContentRow | null> {
  const rows = await db
    .select()
    .from(contents)
    .where(
      and(
        eq(contents.type, where.type),
        eq(contents.locale, where.locale),
        eq(contents.slug, where.slug),
      ),
    )
    .limit(1)

  return rows[0] ?? null
}

/** An id already names one translation, so no locale is needed to find it. */
export async function findContentById(db: Database, id: string): Promise<ContentRow | null> {
  const rows = await db.select().from(contents).where(eq(contents.id, id)).limit(1)
  return rows[0] ?? null
}

/**
 * The one read that crosses locales, named so a reviewer can see it does.
 * Everything the translation UI shows about a document's siblings comes from
 * here rather than from a listing that quietly dropped its locale filter.
 */
export async function listTranslations(
  db: Database,
  translationGroupId: string,
): Promise<ContentRow[]> {
  return db
    .select()
    .from(contents)
    .where(eq(contents.translationGroupId, translationGroupId))
    .orderBy(contents.locale)
}

export interface CreateContentInput {
  readonly type: string
  readonly locale: string
  /** Attaches this document to an existing group. Omit to start a new one. */
  readonly translationGroupId?: string | undefined
  readonly authorId: string | null
  /** Already validated by the type's createSchema. */
  readonly state: ContentState
}

export async function createContent(db: Database, input: CreateContentInput): Promise<ContentRow> {
  try {
    return await db.transaction(async (tx) => {
      if (input.translationGroupId !== undefined) {
        /*
         * Locking the existing siblings is what makes these checks mean
         * anything: two transactions adding the same language to the same
         * group both take this lock, so the second one sees the first one's
         * row instead of an empty result. A group with no siblings yet cannot
         * be raced, because its id was generated by the insert that made it.
         *
         * The unique index still backs this up. A check is a good error
         * message; the constraint is the guarantee.
         */
        const siblings = await tx
          .select({ type: contents.type, locale: contents.locale })
          .from(contents)
          .where(eq(contents.translationGroupId, input.translationGroupId))
          .for('update')

        const mismatched = siblings.find((sibling) => sibling.type !== input.type)
        if (mismatched) {
          throw new ContentConflictError(
            'group-type-mismatch',
            `That translation group holds "${mismatched.type}" documents, not "${input.type}"`,
          )
        }

        if (siblings.some((sibling) => sibling.locale === input.locale)) {
          throw new ContentConflictError(
            'translation-exists',
            'That translation group already has a document in this language',
          )
        }
      }

      const rows = await tx
        .insert(contents)
        .values({
          type: input.type,
          locale: input.locale,
          ...(input.translationGroupId !== undefined
            ? { translationGroupId: input.translationGroupId }
            : {}),
          authorId: input.authorId,
          ...toColumns(input.state),
        })
        .returning()

      const created = rows[0]
      if (!created) throw new Error('Insert returned no row')
      return created
    })
  } catch (error) {
    if (isUniqueViolation(error)) translateUniqueViolation(error)
    throw error
  }
}

export interface UpdateContentOptions {
  /**
   * Adjusts the merged state before it is validated, with the locked row in
   * hand. It exists for values that only a transition can decide — stamping a
   * publication date is the one — which cannot be computed outside because
   * outside does not know the status being left.
   *
   * Whatever it returns still goes through the type's rules, so it can be
   * wrong without being dangerous.
   */
  readonly derive?: (current: ContentRow, merged: ContentState) => ContentState

  /**
   * Consulted inside the transaction, against the locked row and the state
   * the write would produce.
   *
   * Authorizing outside would read a status, decide, and then write against a
   * row that had moved in between — the check and the thing checked would be
   * different states. Since whether a write needs `content:publish` depends on
   * the status it is leaving, that gap is exactly where a publish slips
   * through. Returning false aborts the transaction.
   */
  readonly authorize?: (current: ContentRow, next: ContentState) => boolean
}

/**
 * Reads, merges, validates and writes one state, all inside one transaction.
 *
 * The merge is the point. A patch cannot be judged on its own: `{ status:
 * 'scheduled' }` is valid against a row that already carries a publication
 * date and invalid against one that does not, and only the stored row knows
 * which. So the type's business rules run against the merge rather than
 * against the patch, and the row is locked from the read until the write so
 * nothing can change underneath that decision.
 *
 * `patch` must already have been parsed by the type's updateSchema, which is
 * where an unknown key or an attempted language move is refused.
 *
 * Returns null when there is no such document.
 */
export async function updateContent(
  db: Database,
  type: AnyContentType,
  id: string,
  patch: Record<string, unknown>,
  options: UpdateContentOptions = {},
): Promise<ContentRow | null> {
  try {
    return await db.transaction(async (tx) => {
      const locked = await tx
        .select()
        .from(contents)
        .where(eq(contents.id, id))
        .limit(1)
        .for('update')

      const current = locked[0]
      if (!current) return null

      const rawMerge = { ...toState(current), ...definedEntries(patch) } as ContentState
      const merged = options.derive ? options.derive(current, rawMerge) : rawMerge
      // AnyContentType erases the schema's output type; the shape is the one
      // toState produces, which stateSchema is built from.
      const next = type.stateSchema.parse(merged) as ContentState

      if (options.authorize && !options.authorize(current, next)) {
        throw new ContentForbiddenError()
      }

      /*
       * The revision records what the document was, not what it becomes, so
       * restoring one means restoring a state that actually existed. Written
       * in the same transaction as the change it supersedes, or a crash
       * between the two loses the only copy of the previous text.
       */
      await tx.insert(contentRevisions).values({
        contentId: current.id,
        title: current.title,
        blocks: current.blocks,
        meta: current.meta,
        authorId: current.authorId,
      })

      const rows = await tx
        .update(contents)
        .set({ ...toColumns(next), updatedAt: new Date() })
        .where(eq(contents.id, id))
        .returning()

      return rows[0] ?? null
    })
  } catch (error) {
    if (isUniqueViolation(error)) translateUniqueViolation(error)
    throw error
  }
}

export interface DeleteContentOptions {
  /** Consulted inside the transaction, against the locked row. */
  readonly authorize?: (current: ContentRow) => boolean
}

/**
 * Locked and authorized the same way an update is. Reading the row, deciding,
 * and then deleting by id would decide about a row that may have changed
 * author in between — a smaller window than the publish one, but there is no
 * reason for delete to be the careless sibling.
 */
export async function deleteContent(
  db: Database,
  id: string,
  options: DeleteContentOptions = {},
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const locked = await tx
      .select()
      .from(contents)
      .where(eq(contents.id, id))
      .limit(1)
      .for('update')

    const current = locked[0]
    if (!current) return false

    if (options.authorize && !options.authorize(current)) {
      throw new ContentForbiddenError()
    }

    await tx.delete(contents).where(eq(contents.id, id))
    return true
  })
}
