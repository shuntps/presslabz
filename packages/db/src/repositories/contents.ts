import type { Blocks } from '@presslabz/blocks'
import { type AnyContentType, type ContentStatus, PUBLIC_CONTENT_STATUSES } from '@presslabz/core'
import { and, desc, eq, inArray, isNotNull, lte, or } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { contentRevisions, contents, translationGroups } from '../schema/contents.ts'

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

export type ContentConflictReason =
  | 'group-not-found'
  | 'group-type-mismatch'
  | 'translation-exists'
  | 'slug-taken'

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

export type ContentForbiddenReason = 'document-forbidden' | 'group-forbidden'

export class ContentForbiddenError extends Error {
  readonly reason: ContentForbiddenReason

  constructor(reason: ContentForbiddenReason = 'document-forbidden', message?: string) {
    super(message ?? 'Not allowed to write this document')
    this.name = 'ContentForbiddenError'
    this.reason = reason
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

/*
 * contents_translation_group_fk is deliberately not translated to a reason.
 * The one constraint covers two different conditions — a group that does not
 * exist and a group of another type — so its name cannot tell them apart, and
 * guessing would report a type mismatch for a missing group. The specific
 * reason comes from the application check made under the group lock; if the
 * constraint fires anyway the lock protocol has failed, and that is an
 * unexpected error rather than something to dress up as a conflict.
 */

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

interface CreateContentBase {
  readonly type: string
  readonly locale: string
  readonly authorId: string | null
  /** Already validated by the type's createSchema. */
  readonly state: ContentState
}

/** Opens a new group. Its id comes from the insert, never from the caller. */
export interface OpenGroupInput extends CreateContentBase {
  readonly translationGroupId?: undefined
  readonly authorizeJoin?: undefined
}

export interface JoinGroupInput extends CreateContentBase {
  readonly translationGroupId: string
  /**
   * Consulted inside the transaction, with the group row locked and its
   * current members in hand.
   *
   * Attaching a translation is a claim about existing content, so the caller
   * decides whether this actor may make it. Asking outside would ask about a
   * member set that can change before the insert lands; the group lock is what
   * keeps the answer true when it does.
   */
  readonly authorizeJoin: (members: ContentRow[]) => boolean
}

/**
 * Two variants rather than one shape with optional fields, so that supplying a
 * group id without an authorizer does not compile. It did: the policy lived
 * entirely in the one route that happened to pass a callback, and the next
 * caller would have joined any group it could name.
 */
export type CreateContentInput = OpenGroupInput | JoinGroupInput

/**
 * Opens a translation group or joins one, then inserts the document.
 *
 * The group row is the serialization point for every membership change, and
 * every path takes it in the same order: group first, then members. Joining
 * locks it before reading the members it authorizes against; deleting the last
 * member locks it before removing anything. Without that order a join can
 * authorize against a document another transaction is deleting.
 *
 * A client cannot open a group by naming one. The id of a new group is the
 * server's, generated by the insert below — a supplied id must already resolve
 * to a row. That is what closes the race this function used to have: while an
 * unknown id created a group implicitly, two concurrent creates both found no
 * siblings, both passed the type check, and the group ended up holding a post
 * and a page.
 */
export async function createContent(db: Database, input: CreateContentInput): Promise<ContentRow> {
  try {
    return await db.transaction(async (tx) => {
      const groupId =
        input.translationGroupId === undefined
          ? await openGroup(tx, input.type)
          : await joinGroup(tx, input)

      const rows = await tx
        .insert(contents)
        .values({
          type: input.type,
          locale: input.locale,
          translationGroupId: groupId,
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

type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]

async function openGroup(tx: Transaction, type: string): Promise<string> {
  const rows = await tx.insert(translationGroups).values({ type }).returning({
    id: translationGroups.id,
  })

  const group = rows[0]
  if (!group) throw new Error('Insert returned no row')
  return group.id
}

async function joinGroup(tx: Transaction, input: JoinGroupInput): Promise<string> {
  const groupId = input.translationGroupId

  /*
   * The lock comes before anything is read about the group, and it is the same
   * lock a deletion takes. Postgres holds a FOR UPDATE row against
   * modification, deletion and incompatible locking until the transaction
   * ends, which is what makes the member set below stable through the insert.
   */
  const locked = await tx
    .select()
    .from(translationGroups)
    .where(eq(translationGroups.id, groupId))
    .limit(1)
    .for('update')

  const group = locked[0]
  if (!group) {
    throw new ContentConflictError(
      'group-not-found',
      'No translation group with that id. A group is opened by creating its first document.',
    )
  }

  if (group.type !== input.type) {
    throw new ContentConflictError(
      'group-type-mismatch',
      `That translation group holds "${group.type}" documents, not "${input.type}"`,
    )
  }

  const members = await tx.select().from(contents).where(eq(contents.translationGroupId, groupId))

  /*
   * Authorization before the locale check, deliberately. Answering "that
   * language is taken" to somebody who may not join the group at all tells
   * them what is in it.
   */
  if (!input.authorizeJoin(members)) {
    throw new ContentForbiddenError('group-forbidden', 'Not allowed to join that translation group')
  }

  if (members.some((member) => member.locale === input.locale)) {
    throw new ContentConflictError(
      'translation-exists',
      'That translation group already has a document in this language',
    )
  }

  return groupId
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
 * Removes a document, and the group with it when it was the last member.
 *
 * The group lock comes first — before the content is read for the decision,
 * before it is deleted — because that is the order a join takes them in.
 * Reversing it here would let a join read this document, authorize against it,
 * and insert, while this transaction removes the very row that granted the
 * permission.
 *
 * An empty group is then deleted rather than kept. Under the join rule nobody
 * can ever attach to a group with no members — there is nothing to hold update
 * permission over — so an empty one is a row that no path can use again.
 */
/**
 * Returns the row that was deleted, or null when there was none.
 *
 * The row rather than a boolean, because every caller has something to do with
 * it that only the deleted version can answer: which cache tags to purge,
 * which document a hook is being told about. Re-reading it afterwards is not
 * an option — it is gone — and reading it before means acting on a version the
 * lock below may have replaced.
 */
export async function deleteContent(
  db: Database,
  id: string,
  options: DeleteContentOptions = {},
): Promise<ContentRow | null> {
  return db.transaction(async (tx) => {
    // Read once, unlocked, only to learn which group to lock.
    const found = await tx
      .select({ translationGroupId: contents.translationGroupId })
      .from(contents)
      .where(eq(contents.id, id))
      .limit(1)

    const groupId = found[0]?.translationGroupId
    if (groupId === undefined) return null

    await tx
      .select({ id: translationGroups.id })
      .from(translationGroups)
      .where(eq(translationGroups.id, groupId))
      .limit(1)
      .for('update')

    /*
     * Re-read under a row lock, not a plain select. The group lock serializes
     * membership changes, but updateContent never takes it — it locks the
     * content row and nothing else. A plain read here would decide against a
     * version another transaction is already rewriting, and Postgres does not
     * block a plain SELECT against a writer; only FOR UPDATE does.
     *
     * It also covers the row having gone while this waited for the group.
     */
    const locked = await tx
      .select()
      .from(contents)
      .where(eq(contents.id, id))
      .limit(1)
      .for('update')

    const current = locked[0]
    if (!current) return null

    if (options.authorize && !options.authorize(current)) {
      throw new ContentForbiddenError()
    }

    await tx.delete(contents).where(eq(contents.id, id))

    const remaining = await tx
      .select({ id: contents.id })
      .from(contents)
      .where(eq(contents.translationGroupId, groupId))
      .limit(1)

    if (remaining.length === 0) {
      await tx.delete(translationGroups).where(eq(translationGroups.id, groupId))
    }

    return current
  })
}

/**
 * Publishes everything whose moment has come, and returns what it published.
 *
 * One statement, deliberately. `UPDATE … WHERE status = 'scheduled' AND
 * published_at <= now RETURNING *` takes a row lock per row it touches, so two
 * API instances running this at the same second cannot both claim a document:
 * the loser re-evaluates its condition after the winner commits, finds the row
 * already published, and returns fewer rows. Reading the due set and then
 * updating it would have that race, and it would announce the same publication
 * twice — once per instance — to every hook handler.
 *
 * Anything overdue is published, however overdue. A schedule is a promise
 * about a moment, and an installation that was down for an hour owes the
 * documents that came due while it was: publishing them late is what an author
 * expects, and skipping them silently is how a post never appears at all.
 */
export async function publishDueContent(
  db: Database,
  now: Date = new Date(),
): Promise<ContentRow[]> {
  return db
    .update(contents)
    .set({ status: 'published', updatedAt: new Date() })
    .where(
      and(
        eq(contents.status, 'scheduled'),
        isNotNull(contents.publishedAt),
        lte(contents.publishedAt, now),
      ),
    )
    .returning()
}
