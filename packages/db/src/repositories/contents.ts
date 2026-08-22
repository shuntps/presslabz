import type { Blocks } from '@presslabz/blocks'
import {
  type AnyContentType,
  type ContentMediaReference,
  type ContentStatus,
  type Cursor,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  mediaReferencesOf,
  PUBLIC_CONTENT_STATUSES,
} from '@presslabz/core'
import { and, desc, eq, inArray, isNotNull, lte, ne, or, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { contentMedia } from '../schema/content-media.ts'
import { contentRevisions, contents, translationGroups } from '../schema/contents.ts'
import { media } from '../schema/media.ts'

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
  /** The document moved on since the client last read it. */
  | 'stale-version'
  | 'parent-not-found'
  /** A parent of another type or another language. */
  | 'parent-mismatch'
  /** The document would become its own ancestor. */
  | 'parent-cycle'
  /** The tree would grow deeper than a URL can express. */
  | 'parent-too-deep'

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

/**
 * A document named an asset that does not exist.
 *
 * Its own class rather than a reason on `ContentConflictError`, which means
 * 409 and a conflict between two writers — this is neither. It carries no HTTP
 * status: the API layer decides that a missing reference is 422, and the
 * repository has no business knowing what a status code is.
 *
 * The references it carries are best-effort *details*, not the refusal. The
 * refusal is the database's, and it stands whether or not this list could be
 * filled in afterwards.
 */
export class MediaReferenceError extends Error {
  readonly reason = 'media-missing'
  readonly references: readonly ContentMediaReference[]

  constructor(references: readonly ContentMediaReference[]) {
    super(
      references.length > 0
        ? `No media with ${references.map((reference) => reference.mediaId).join(', ')}`
        : 'A media reference in this document no longer exists',
    )
    this.name = 'MediaReferenceError'
    this.references = references
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
/** Postgres foreign key violation. */
const FOREIGN_KEY_VIOLATION = '23503'

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
function isMediaForeignKeyViolation(error: unknown): boolean {
  const driver = driverError(error)
  return (
    driver?.code === FOREIGN_KEY_VIOLATION &&
    String(driver.constraint_name ?? '') === 'content_media_media_fk'
  )
}

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
  /**
   * Where the previous page stopped. Rows strictly after it are returned, in
   * the same order — never "skip the first fifty", because the sort column is
   * modification time and a colleague saving a document while somebody reads
   * the list would push a row across the boundary, showing it twice or not at
   * all.
   */
  readonly after?: Cursor
}

/**
 * Filters shared by the listing and its counts, so the number in the heading
 * describes the set the rows come from. Two expressions of one predicate would
 * be a heading that says five about a list of four.
 */
function listFilters(query: ListContentsQuery) {
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

  return filters
}

export async function listContents(db: Database, query: ListContentsQuery): Promise<ContentRow[]> {
  const filters = listFilters(query)

  /*
   * A row comparison, not two comparisons joined by OR. `(a, b) < (x, y)` is
   * one predicate Postgres can answer from an index whose leading columns are
   * exactly those two, where the equivalent `a < x OR (a = x AND b < y)` is
   * usually not. The index is `(type, locale, updated_at DESC, id DESC)`, in
   * that order, which is also why the sort below names both columns.
   */
  if (query.after) {
    filters.push(
      sql`(${contents.updatedAt}, ${contents.id}) < (${query.after.at.toISOString()}::timestamptz, ${query.after.id}::uuid)`,
    )
  }

  return db
    .select()
    .from(contents)
    .where(and(...filters))
    .orderBy(desc(contents.updatedAt), desc(contents.id))
    .limit(pageSize(query.limit))
}

/** Bounded here as well as at the route: a repository is called from tests too. */
function pageSize(limit: number | undefined): number {
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.trunc(limit ?? DEFAULT_PAGE_SIZE)))
}

/**
 * How many documents the listing describes, and how many of them are drafts.
 *
 * One pass over the same filtered set rather than two queries: the heading
 * states both numbers about the same set, and asking twice invites them to
 * disagree by whatever landed in between.
 */
export async function countContents(
  db: Database,
  query: ListContentsQuery,
): Promise<{ total: number; drafts: number }> {
  const rows = await db
    .select({
      total: sql<string>`count(*)`,
      drafts: sql<string>`count(*) filter (where ${contents.status} = 'draft')`,
    })
    .from(contents)
    .where(and(...listFilters(query)))

  return { total: Number(rows[0]?.total ?? 0), drafts: Number(rows[0]?.drafts ?? 0) }
}

/**
 * The other languages of a page's documents, in one query.
 *
 * Deliberately crossing locales, which is why it says so in its name. It
 * exists because the pair is what the interface works in and pairing two
 * independently paginated listings in the browser cannot be made to work — the
 * second page of one language has no reason to hold the partners of the second
 * page of the other. The visibility filter travels with it: a translation this
 * actor may not read must not arrive as somebody else's sibling.
 */
export async function listSiblingsAcrossLocales(
  db: Database,
  query: {
    readonly groupIds: readonly string[]
    readonly excludeLocale: string
    readonly visibleTo?: { readonly authorId: string | null }
  },
): Promise<ContentRow[]> {
  if (query.groupIds.length === 0) return []

  const filters = [
    inArray(contents.translationGroupId, [...query.groupIds]),
    ne(contents.locale, query.excludeLocale),
  ]

  if (query.visibleTo) {
    const published = inArray(contents.status, [...PUBLIC_CONTENT_STATUSES])
    const authorId = query.visibleTo.authorId
    const visible = authorId === null ? published : or(published, eq(contents.authorId, authorId))
    if (visible) filters.push(visible)
  }

  return db
    .select()
    .from(contents)
    .where(and(...filters))
    .orderBy(desc(contents.updatedAt))
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
  /**
   * The declared type, not its name.
   *
   * A document cannot be written without the declaration that says where its
   * media references are — the mirror this write maintains is built from
   * `type.mediaIn`, and a caller holding only a string could not have one.
   * `updateContent` has always taken the type; this is the same rule, applied
   * to the other funnel.
   */
  readonly type: AnyContentType
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
  const references = mediaReferencesOf(input.type, input.state)

  try {
    return await db.transaction(async (tx) => {
      const groupId =
        input.translationGroupId === undefined
          ? await openGroup(tx, input.type.name)
          : await joinGroup(tx, input)

      if (input.state.parentId !== undefined) {
        await assertUsableParent(tx, {
          // Nothing exists yet, so nothing can be its own ancestor: the walk
          // is only checking that the parent itself is usable.
          childId: null,
          parentId: input.state.parentId,
          type: input.type.name,
          locale: input.locale,
        })
      }

      const rows = await tx
        .insert(contents)
        .values({
          type: input.type.name,
          locale: input.locale,
          translationGroupId: groupId,
          authorId: input.authorId,
          ...toColumns(input.state),
        })
        .returning()

      const created = rows[0]
      if (!created) throw new Error('Insert returned no row')

      await syncMediaReferences(tx, created.id, references)

      return created
    })
  } catch (error) {
    if (isUniqueViolation(error)) translateUniqueViolation(error)
    if (isMediaForeignKeyViolation(error)) {
      throw new MediaReferenceError(await absentMedia(db, references))
    }
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

  if (group.type !== input.type.name) {
    throw new ContentConflictError(
      'group-type-mismatch',
      `That translation group holds "${group.type}" documents, not "${input.type.name}"`,
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

  /**
   * The version the caller believes it is editing, or `'any'` to say it does
   * not care.
   *
   * Required rather than optional, and a union rather than a nullable number,
   * because "I did not think about concurrency" and "I know this write cannot
   * conflict" have to look different in the code. The lock below serializes
   * writes; it does not notice that the second one was composed against a
   * version the first has already replaced, and without this the later save
   * wins silently and the earlier author's work is gone.
   *
   * `'any'` is for writes that are not somebody's edit of a document they were
   * looking at — a restore of a revision, a migration, a scheduler.
   */
  readonly expectedVersion: number | 'any'
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
  options: UpdateContentOptions,
): Promise<ContentRow | null> {
  /* Filled in once the merge has happened, and read again if it is refused. */
  let references: readonly ContentMediaReference[] = []

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

      /*
       * Before anything is merged: a stale write is refused rather than
       * applied to a document it was not composed against. The check is inside
       * the transaction, against the locked row, because a version read
       * outside it could already have moved.
       */
      if (options.expectedVersion !== 'any' && options.expectedVersion !== current.version) {
        throw new ContentConflictError(
          'stale-version',
          'This document changed since it was opened. Reload it and apply the change again.',
        )
      }

      const rawMerge = { ...toState(current), ...definedEntries(patch) } as ContentState
      const merged = options.derive ? options.derive(current, rawMerge) : rawMerge
      // AnyContentType erases the schema's output type; the shape is the one
      // toState produces, which stateSchema is built from.
      const next = type.stateSchema.parse(merged) as ContentState

      if (options.authorize && !options.authorize(current, next)) {
        throw new ContentForbiddenError()
      }

      /*
       * Only when it moves. Re-walking on every save would take a lock on
       * every ancestor of every edit, which is a lot of contention to prove
       * something that did not change.
       */
      if (next.parentId !== undefined && next.parentId !== current.parentId) {
        await assertUsableParent(tx, {
          childId: current.id,
          parentId: next.parentId,
          type: current.type,
          locale: current.locale,
        })
      }

      await insertContentRevision(tx, current)
      await pruneRevisions(tx, current.id)

      const rows = await tx
        .update(contents)
        .set({ ...toColumns(next), updatedAt: new Date(), version: current.version + 1 })
        .where(eq(contents.id, id))
        .returning()

      /*
       * The state that was just written, not the patch: a save that removes
       * the last image block has to remove the row that named it, and a patch
       * that says nothing about blocks must leave both alone.
       */
      references = mediaReferencesOf(type, next)
      await syncMediaReferences(tx, id, references)

      return rows[0] ?? null
    })
  } catch (error) {
    if (isUniqueViolation(error)) translateUniqueViolation(error)
    if (isMediaForeignKeyViolation(error)) {
      throw new MediaReferenceError(await absentMedia(db, references))
    }
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

    /*
     * The children become roots, explicitly, before the parent goes.
     *
     * The foreign key is `restrict`, so this is not a nicety: without it the
     * delete is refused. It is written here rather than left to `on delete set
     * null` because that clause nulls every column of a composite key —
     * including the type and the locale, which cannot be null — and the
     * delete failed with a not-null violation that named neither the page nor
     * the reason.
     */
    await tx.update(contents).set({ parentId: null }).where(eq(contents.parentId, id))

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
 * **A scheduled publication is a content write, and is written like one.** It
 * used to be a single `UPDATE` that set `status` and `updated_at` and nothing
 * else — no version, no revision — which left a published document sitting at
 * the version an editor had open. That editor's next save carried
 * `expectedVersion: N`, passed the staleness check because the row really was
 * still N, and applied a form that still said `scheduled`: a publication
 * undone by somebody who never asked to undo it, with no record that either
 * thing had happened. So this now does what `updateContent` does — lock,
 * record the state being superseded, write — and for the same reasons.
 *
 * **Two instances still publish a document once, and the guarantee is no
 * longer "it is one statement".** It is the row lock, the predicate, and the
 * transaction, in that order: the `SELECT … FOR UPDATE` blocks the second
 * instance on rows the first has claimed, and when the first commits, READ
 * COMMITTED makes the second re-evaluate its condition against the row as it
 * now is. `status` is no longer `scheduled`, so the row falls out of its
 * result — not skipped, gone — and it publishes, versions and announces
 * nothing. The re-check after the lock is asserted below rather than assumed,
 * because it is the whole property.
 *
 * `SKIP LOCKED` would be the other way to write this and is deliberately not
 * used — not because it would lose a row, which it would not: a skipped row is
 * excluded from that pass only, and either the transaction holding it publishes
 * it or a later pass picks it up after a rollback. It is not used because
 * waiting is the simpler thing to reason about. The second claimant waits,
 * then observes the row as published and moves on, so there is no window in
 * which a row is neither claimed nor waited for — and nothing here has to grow
 * a retry or batching policy to make sure somebody comes back for it. That is
 * a trade worth revisiting the day a pass is long enough for waiting to cost
 * something; today it is one small update per document.
 *
 * The order is `published_at`, then `id`. Two transactions that lock rows in
 * different orders can each hold what the other needs; a total order they both
 * follow means the second simply waits.
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
  return db.transaction(async (tx) => {
    const due = and(
      eq(contents.status, 'scheduled'),
      isNotNull(contents.publishedAt),
      lte(contents.publishedAt, now),
    )

    const claimed = await tx
      .select()
      .from(contents)
      .where(due)
      .orderBy(contents.publishedAt, contents.id)
      .for('update')

    const published: ContentRow[] = []

    for (const current of claimed) {
      /*
       * The predicate again, on the row this transaction now holds. Postgres
       * re-checks it while acquiring the lock, so a row another instance
       * published while we waited is already absent from `claimed` — this is
       * the belt to that braces, and it costs nothing.
       */
      if (current.status !== 'scheduled') continue
      if (!current.publishedAt || current.publishedAt > now) continue

      await insertContentRevision(tx, current)
      await pruneRevisions(tx, current.id)

      const rows = await tx
        .update(contents)
        .set({ status: 'published', updatedAt: new Date(), version: current.version + 1 })
        .where(eq(contents.id, current.id))
        .returning()

      /*
       * Not `?? continue`. A row locked in this transaction that does not come
       * back from its own update is not a case with a sensible fallback, and
       * carrying on would leave a revision recording a supersession that never
       * happened. The whole transaction goes.
       */
      const row = rows[0]
      if (!row) throw new Error(`scheduled publication lost row ${current.id} mid-transaction`)

      published.push(row)
    }

    return published
  })
}

/**
 * How much history a document keeps.
 *
 * A cap rather than a duration: a document edited twice a year should keep its
 * history, and one edited every minute by an automation should not fill the
 * table with it. Fifty is enough to walk back through a day's work and small
 * enough that the rows are never the reason a backup is large.
 *
 * Pruned in the transaction that adds one, so the table cannot grow between a
 * write and a sweep that might never run.
 */
export const REVISION_LIMIT = 50

/**
 * Brings `content_media` in line with what the document now says.
 *
 * The rows are what the database can hold to: JSONB cannot carry a foreign
 * key, so the references live twice — once where they are written, once where
 * they can be enforced. Keeping the second in step with the first is this
 * repository's job, and the reason it is not a trigger is that the shapes are
 * declared in TypeScript: a trigger would have to re-implement the block
 * vocabulary and every content type's metadata in PL/pgSQL, and could not read
 * a declaration a module added.
 *
 * **By difference.** A save that changes a title touches no reference row at
 * all. Rewriting the set every time would be churn for nothing, and would take
 * and release locks on assets whose relationship to this document did not
 * change.
 *
 * **One statement per added reference, in sorted order.** Each insert has its
 * foreign key checked, and that check takes a `FOR KEY SHARE` on the media row
 * — so the order these run in is the order locks are taken in. A single
 * multi-row insert would not promise any order at all. Two writers taking the
 * same assets in the same order cannot arrange a cycle between them when a
 * deletion queues an exclusive request in the middle.
 */
async function syncMediaReferences(
  tx: Transaction,
  contentId: string,
  references: readonly ContentMediaReference[],
): Promise<void> {
  const current = await tx
    .select({ mediaId: contentMedia.mediaId, source: contentMedia.source })
    .from(contentMedia)
    .where(eq(contentMedia.contentId, contentId))

  const held = new Set(current.map((row) => `${row.mediaId}:${row.source}`))
  const wanted = new Set(references.map((reference) => `${reference.mediaId}:${reference.source}`))

  const gone = current.filter((row) => !wanted.has(`${row.mediaId}:${row.source}`))
  const added = references.filter(
    (reference) => !held.has(`${reference.mediaId}:${reference.source}`),
  )

  for (const row of gone) {
    await tx
      .delete(contentMedia)
      .where(
        and(
          eq(contentMedia.contentId, contentId),
          eq(contentMedia.mediaId, row.mediaId),
          eq(contentMedia.source, row.source),
        ),
      )
  }

  for (const reference of added) {
    await tx.insert(contentMedia).values({
      contentId,
      mediaId: reference.mediaId,
      source: reference.source,
    })
  }
}

/**
 * Which of the ids a write named are genuinely absent, asked after the write
 * has already been rolled back.
 *
 * The violation says a foreign key failed; it does not say which row of a
 * batch caused it, and reporting every reference the document holds as missing
 * would name assets that are perfectly fine. So the ids are looked up again.
 *
 * A second write can restore or remove an asset between the rollback and this
 * query, which is why the answer is a detail and not the refusal: an empty
 * list still means the write was refused, it means only that by the time
 * anyone asked, nothing was missing any more.
 */
async function absentMedia(
  db: Database,
  references: readonly ContentMediaReference[],
): Promise<readonly ContentMediaReference[]> {
  const ids = [...new Set(references.map((reference) => reference.mediaId))]
  if (ids.length === 0) return []

  const found = await db.select({ id: media.id }).from(media).where(inArray(media.id, ids))
  const present = new Set(found.map((row) => row.id))

  return references.filter((reference) => !present.has(reference.mediaId))
}

/**
 * Records what a document was, immediately before it becomes something else.
 *
 * The revision holds the *previous* state rather than the new one, so
 * restoring it restores something that actually existed. Written in the same
 * transaction as the change it supersedes — a crash between the two would lose
 * the only copy of the previous text.
 *
 * One definition, because there are two write paths now. An editor's save and
 * a scheduled publication both supersede a state, and a scheduled publication
 * that recorded a *different* set of fields would be a hole in the history
 * that only appears for documents nobody was editing at the time.
 */
async function insertContentRevision(tx: Transaction, current: ContentRow): Promise<void> {
  await tx.insert(contentRevisions).values({
    contentId: current.id,
    slug: current.slug,
    title: current.title,
    excerpt: current.excerpt,
    status: current.status,
    blocks: current.blocks,
    meta: current.meta,
    authorId: current.authorId,
    parentId: current.parentId,
    publishedAt: current.publishedAt,
    version: current.version,
  })
}

async function pruneRevisions(tx: Transaction, contentId: string): Promise<void> {
  await tx.execute(sql`
    delete from ${contentRevisions}
    where ${contentRevisions.contentId} = ${contentId}
      and ${contentRevisions.id} not in (
        select id from ${contentRevisions}
        where ${contentRevisions.contentId} = ${contentId}
        order by ${contentRevisions.createdAt} desc, ${contentRevisions.version} desc
        limit ${REVISION_LIMIT}
      )
  `)
}

export type ContentRevisionRow = typeof contentRevisions.$inferSelect

/** A document's history, newest first. */
export async function listRevisions(
  db: Database,
  contentId: string,
  limit = REVISION_LIMIT,
): Promise<ContentRevisionRow[]> {
  return db
    .select()
    .from(contentRevisions)
    .where(eq(contentRevisions.contentId, contentId))
    .orderBy(desc(contentRevisions.createdAt), desc(contentRevisions.version))
    .limit(Math.min(REVISION_LIMIT, Math.max(1, Math.trunc(limit))))
}

/**
 * A revision as a patch that restores it.
 *
 * Nulls rather than undefined, and that is the whole subtlety: in a patch,
 * absent means "leave this alone", so a revision whose excerpt was empty would
 * restore everything *except* the emptiness — the document would come back
 * with a summary written after the version being restored. A restore states
 * every field, including the ones that were empty.
 */
export function stateOfRevision(revision: ContentRevisionRow): Record<string, unknown> {
  return {
    slug: revision.slug,
    title: revision.title,
    excerpt: revision.excerpt,
    status: revision.status,
    blocks: revision.blocks,
    meta: revision.meta,
    publishedAt: revision.publishedAt,
    parentId: revision.parentId,
  }
}

/** One revision, by id. The caller checks it belongs to the document. */
export async function findRevision(db: Database, id: string): Promise<ContentRevisionRow | null> {
  const rows = await db.select().from(contentRevisions).where(eq(contentRevisions.id, id)).limit(1)

  return rows[0] ?? null
}

/**
 * How deep a page tree may go.
 *
 * The same number the URL walk stops at, and for the same reason: a document
 * deeper than this has a path that cannot be resolved, so it has no canonical
 * URL and no place in the sitemap. Refusing the move is better than accepting
 * one that makes a page unreachable.
 */
export const MAX_HIERARCHY_DEPTH = 8

interface ParentCheck {
  readonly childId: string | null
  readonly parentId: string
  readonly type: string
  readonly locale: string
}

/**
 * Refuses a parent that would make the tree something a tree cannot be.
 *
 * Type and locale are guaranteed by the composite foreign key; they are
 * checked here anyway so the answer is a named conflict rather than a driver
 * error, and so the check happens before anything else is written.
 *
 * Cycles cannot be a constraint — no SQL check can see a path — so the walk
 * takes each ancestor `for update` as it goes. That is what makes it safe
 * against a concurrent write building the other half of the loop: two
 * transactions setting A under B and B under A each need a row the other
 * holds, so one waits, and then reads the tree the first one committed and
 * finds itself in it.
 */
async function assertUsableParent(tx: Transaction, check: ParentCheck): Promise<void> {
  let currentId: string | null = check.parentId
  let depth = 0

  while (currentId !== null) {
    if (currentId === check.childId) {
      throw new ContentConflictError(
        'parent-cycle',
        'A document cannot be placed under itself or under one of its own children',
      )
    }

    depth += 1

    /*
     * A runaway guard, not the limit. Cycles are refused now, but a row
     * written before that constraint existed is still representable in an old
     * backup, and this walk must end either way.
     */
    if (depth > MAX_HIERARCHY_DEPTH + 1) {
      throw new ContentConflictError(
        'parent-too-deep',
        `A page may be at most ${MAX_HIERARCHY_DEPTH} levels deep`,
      )
    }

    const rows: { id: string; parentId: string | null; type: string; locale: string }[] = await tx
      .select({
        id: contents.id,
        parentId: contents.parentId,
        type: contents.type,
        locale: contents.locale,
      })
      .from(contents)
      .where(eq(contents.id, currentId))
      .limit(1)
      .for('update')

    const ancestor = rows[0]

    if (!ancestor) {
      // Only reachable for the parent itself: an ancestor that disappeared
      // mid-walk would have been held by the lock.
      throw new ContentConflictError(
        'parent-not-found',
        'No document with that id to place it under',
      )
    }

    if (depth === 1 && (ancestor.type !== check.type || ancestor.locale !== check.locale)) {
      throw new ContentConflictError(
        'parent-mismatch',
        'A parent must be the same kind of document, in the same language',
      )
    }

    currentId = ancestor.parentId
  }

  /*
   * `depth` is the parent's own depth, so the document lands one below it, and
   * everything already under the document moves down with it. A new document
   * has no children and therefore a height of one.
   */
  const height = check.childId === null ? 1 : await subtreeHeight(tx, check.childId)

  if (depth + height > MAX_HIERARCHY_DEPTH) {
    throw new ContentConflictError(
      'parent-too-deep',
      `A page may be at most ${MAX_HIERARCHY_DEPTH} levels deep`,
    )
  }
}

/**
 * How many levels the document carries with it.
 *
 * Its own depth is not the whole question: everything under it moves down by
 * the same amount, so a two-level subtree grafted at the limit puts its leaves
 * beyond it — and those leaves would have no URL.
 */
async function subtreeHeight(tx: Transaction, childId: string): Promise<number> {
  const result = await tx.execute<{ height: number }>(sql`
    with recursive descendants as (
      select ${contents.id} as id, 1 as depth
      from ${contents}
      where ${contents.id} = ${childId}
      union all
      select child.id, parent.depth + 1
      from ${contents} child
      join descendants parent on child.parent_id = parent.id
      where parent.depth <= ${MAX_HIERARCHY_DEPTH}
    )
    select coalesce(max(depth), 1)::int as height from descendants
  `)

  return Number([...result][0]?.height ?? 1)
}
