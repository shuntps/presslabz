import { blocksSchema } from '@presslabz/blocks'
import { isLocale } from '@presslabz/i18n'
import { z } from 'zod'
import { type Actor, allows, type OperationAccess } from './access.ts'
import { slugSchema } from './slug.ts'

/**
 * Content types are declared in code, not stored as rows.
 *
 * Registering a content type at runtime leaves the system with no idea what
 * its metadata looks like, which is why reading a metadata field elsewhere
 * returns an unknown shape forever. Here one call fixes the metadata schema,
 * the capabilities each
 * operation needs and the taxonomies that apply, and the validation, the
 * TypeScript types and the route behaviour all come out of that single
 * declaration. They cannot disagree because there is only one of them.
 *
 * Nothing here carries a label. Everything user-visible resolves through
 * packages/i18n under `content.type.<name>.*`, so a type declaration stays
 * free of any language — the convention the whole repository runs on. Types
 * declared by third-party plugins in phase 5 will ship their own catalogue;
 * that mechanism is deliberately not invented here.
 */

export const CONTENT_STATUSES = ['draft', 'scheduled', 'published', 'archived', 'trash'] as const
export type ContentStatus = (typeof CONTENT_STATUSES)[number]

export function isContentStatus(value: unknown): value is ContentStatus {
  return typeof value === 'string' && (CONTENT_STATUSES as readonly string[]).includes(value)
}

/**
 * Statuses that put a document in front of the public.
 *
 * `scheduled` sits here with `published` because a schedule needs no further
 * human act to go live — approving a schedule *is* approving the publication,
 * only later. Treating it as a draft that happens to carry a date is how an
 * author without publishing rights ships to the site by picking a date
 * instead of pressing a button.
 */
export const PUBLISHABLE_STATUSES = [
  'published',
  'scheduled',
] as const satisfies readonly ContentStatus[]

export function isPublishable(status: ContentStatus): boolean {
  return (PUBLISHABLE_STATUSES as readonly ContentStatus[]).includes(status)
}

/** Statuses a reader without editing rights may ever be served. */
export const PUBLIC_CONTENT_STATUSES = ['published'] as const satisfies readonly ContentStatus[]

export const CONTENT_OPERATIONS = ['read', 'create', 'update', 'delete', 'publish'] as const
export type ContentOperation = (typeof CONTENT_OPERATIONS)[number]

/**
 * What each operation costs. `own` exists because authorship changes the
 * answer: a contributor may edit their own draft and not anyone else's.
 * Expressing that as two capabilities rather than as a role check is what
 * keeps `roleHasCapability` out of route handlers — see the capability model
 * in packages/core/src/capabilities.ts. The comparison itself lives in
 * access.ts, so media asks it the same way.
 */
const DEFAULT_ACCESS: Readonly<Record<ContentOperation, OperationAccess>> = {
  read: { any: 'content:read' },
  create: { any: 'content:create' },
  update: { any: 'content:update:any', own: 'content:update:own' },
  delete: { any: 'content:delete:any', own: 'content:delete:own' },
  publish: { any: 'content:publish' },
}

/** Same shape as a slug: it appears in the `type` column and in API paths. */
export const CONTENT_TYPE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

const metaDefault = z.record(z.string(), z.unknown())

export interface ContentTypeOptions<TMeta extends z.ZodType = typeof metaDefault> {
  /** Stored in `contents.type`. Also the API path segment. */
  readonly name: string
  /**
   * Whether a document may have a parent. Pages nest; posts do not, and
   * letting them would put a nesting control in an editor nobody wants it in.
   */
  readonly hierarchical?: boolean
  /** Taxonomy names whose terms may be attached. Declared in code as well. */
  readonly taxonomies?: readonly string[]
  /** Shape of `contents.meta`, in place of an unknowable key-value table. */
  readonly meta?: TMeta
  /** Overrides the defaults above, one operation at a time. */
  readonly access?: Partial<Record<ContentOperation, OperationAccess>>
  /**
   * The path segment this type's documents live under on the public site:
   * `blog` puts a post at `/en/blog/hello`, and `''` puts a page at
   * `/en/about`.
   *
   * It has to be declared rather than derived, because the unique index is on
   * `(type, locale, slug)` — a post and a page may both be called `about`, and
   * without a segment to tell them apart one of the two would be unreachable.
   *
   * Defaults to the type's own name, which is the choice that can never
   * collide. Only one type may sit at the root, and a document there cannot
   * use a slug that is another type's base path: the more specific route wins,
   * which is what makes `/en/blog` the archive rather than a page called
   * "blog".
   */
  readonly basePath?: string
}

/**
 * The erased form, for the registry and for anything that holds types whose
 * meta schemas differ.
 *
 * Note what is deliberately *not* here: defineContentType has no declared
 * return type, so each call keeps the precise schema types it built. That is
 * the half of the promise that is easy to lose — annotating createSchema as
 * z.ZodType would still validate correctly and would infer `unknown`, leaving
 * every caller to restate the shape it was supposed to be handed.
 */
export interface AnyContentType {
  readonly name: string
  readonly hierarchical: boolean
  /** Public URL segment. Empty means this type sits at the locale root. */
  readonly basePath: string
  readonly taxonomies: readonly string[]
  readonly meta: z.ZodType
  readonly access: Readonly<Record<ContentOperation, OperationAccess>>
  /**
   * The invariants of a whole document, wherever that state came from. The
   * repository validates the stored row merged with an incoming patch against
   * this, which is the only way `{ status: 'scheduled' }` can be judged at
   * all: the patch alone does not say whether a date exists.
   */
  readonly stateSchema: z.ZodType
  /** A whole document arriving from outside, plus its create-only fields. */
  readonly createSchema: z.ZodType
  /**
   * A patch. Strict, and it refuses `locale` by name rather than dropping it.
   * It deliberately carries no cross-field rule, because a patch is not a
   * state and cannot be judged as one.
   */
  readonly updateSchema: z.ZodType
}

const SCHEDULE_NEEDS_DATE = {
  message: 'A scheduled document needs a publication date',
  path: ['publishedAt'],
}

export function defineContentType<TMeta extends z.ZodType = typeof metaDefault>(
  options: ContentTypeOptions<TMeta>,
) {
  if (!CONTENT_TYPE_NAME_PATTERN.test(options.name)) {
    throw new Error(`Content type name "${options.name}" must match ${CONTENT_TYPE_NAME_PATTERN}`)
  }

  const basePath = options.basePath ?? options.name
  if (basePath !== '' && !CONTENT_TYPE_NAME_PATTERN.test(basePath)) {
    throw new Error(`Content type "${options.name}" has a base path that is not a path segment`)
  }

  const hierarchical = options.hierarchical ?? false
  const meta = (options.meta ?? metaDefault) as TMeta

  /*
   * The nullable fields, twice.
   *
   * A patch has to keep a null: it is how "clear this" is said, and it must
   * survive as far as the merge. A state must not: the column stores absence,
   * and the whole state is what the type's rules are checked against. Writing
   * the transform into the state shape alone is what keeps `{ excerpt: null }`
   * from quietly becoming `{}` before anything can act on it — which it did,
   * and which made an excerpt impossible to remove.
   */
  const clearable = {
    excerpt: z.string().max(1000).nullish(),
    publishedAt: z.coerce.date().nullish(),
    ...(hierarchical ? { parentId: z.uuid().nullish() } : {}),
  }

  const cleared = <TSchema extends z.ZodType>(schema: TSchema) =>
    schema.transform((value) => value ?? undefined)

  const stateShape = {
    slug: slugSchema,
    title: z.string().min(1).max(300),
    /*
     * Null clears, absent leaves alone.
     *
     * A patch omits what it does not touch, so without a way to say "clear
     * this" an excerpt could be written and never removed: the admin sends no
     * key for an empty field, the merge keeps the stored value, and the author
     * watches their deletion have no effect. Null says it explicitly and
     * normalises to the absence the column stores.
     */
    excerpt: cleared(clearable.excerpt),
    status: z.enum(CONTENT_STATUSES).default('draft'),
    blocks: blocksSchema.default([]),
    /*
     * prefault rather than default. `.default({})` short-circuits validation
     * and hands the value straight back, so a type whose metadata has a
     * required field would quietly store `{}` and only fail much later, when
     * something read the field that was never there. `.prefault({})` runs the
     * fallback through the schema, so a metadata shape that genuinely needs
     * input says so, naming the field, on the request that omitted it.
     *
     * The cast is needed because TMeta is generic here and `{}` cannot be
     * proven to satisfy an unknown shape; prefault is exactly what checks it
     * at runtime.
     */
    meta: meta.prefault({} as z.input<TMeta>),
    /**
     * A schedule is a promise about a moment, so it needs one. Accepting
     * `scheduled` without a date is how a document ends up in a state that
     * nothing will ever move it out of.
     */
    publishedAt: cleared(clearable.publishedAt),
    ...(hierarchical && clearable.parentId ? { parentId: cleared(clearable.parentId) } : {}),
  }

  const scheduleHasDate = (value: { status?: ContentStatus; publishedAt?: Date | undefined }) =>
    value.status !== 'scheduled' || value.publishedAt !== undefined

  const stateSchema = z.object(stateShape).refine(scheduleHasDate, SCHEDULE_NEEDS_DATE)

  const createSchema = z
    .object({
      /**
       * Locale is required on create and refused on update. Every document is
       * one translation, and moving an existing one between languages would
       * silently change which unique (type, locale, slug) row it collides
       * with — a rename dressed up as an edit.
       */
      locale: z.string().refine(isLocale, { message: 'Unsupported locale' }),
      /** Supplied to attach this document to an existing translation group. */
      translationGroupId: z.uuid().optional(),
      ...stateShape,
    })
    .refine(scheduleHasDate, SCHEDULE_NEEDS_DATE)

  /**
   * Strict, so an unknown key is an error rather than something silently
   * dropped. A caller that sent a field the server ignored has been told its
   * write succeeded when part of it did not, which is worse than a rejection.
   *
   * `locale` is named rather than left to the unknown-key path, so the answer
   * is "a document cannot change language" instead of "unrecognized key": the
   * caller is not confused about the field, they are wrong about the
   * operation, and only one of those two messages says so.
   */
  const updateSchema = z.strictObject({
    ...z.object(stateShape).partial().shape,
    // After the partial, so a null reaches the merge instead of being
    // normalised away before anything can tell it apart from an omission.
    ...clearable,
    locale: z
      .never({ error: 'A document cannot change language; create the translation instead' })
      .optional(),
  })

  return {
    name: options.name,
    basePath,
    hierarchical,
    taxonomies: options.taxonomies ?? [],
    meta,
    access: { ...DEFAULT_ACCESS, ...options.access },
    stateSchema,
    createSchema,
    updateSchema,
  } satisfies AnyContentType
}

/**
 * Whether an actor may perform an operation on a document. It takes
 * capabilities rather than a role, which is what keeps roles from leaking out
 * of capabilities.ts, and it owns the ownership comparison so no caller
 * re-derives it. Omit `resource` for operations that have no row yet.
 */
export function canPerform(
  type: AnyContentType,
  operation: ContentOperation,
  actor: Actor,
  resource?: { readonly authorId: string | null },
): boolean {
  return allows(type.access[operation], actor, resource?.authorId)
}

/**
 * Whether an actor may read one document. The single read decision, so the two
 * routes that make it cannot answer differently.
 *
 * They did. Reading a document directly checked the status and the authorship;
 * reading its translations checked only the `read` capability, which every
 * role holds — so a subscriber who could open a published article received its
 * unpublished translation in full, blocks included. The rule was not wrong in
 * one place and right in the other, it was written twice.
 */
export function canReadDocument(
  type: AnyContentType,
  actor: Actor,
  resource: { readonly authorId: string | null; readonly status: ContentStatus },
): boolean {
  if (!canPerform(type, 'read', actor)) return false

  // Published is public to anyone who may read at all. Anything else is
  // visible only to somebody who could edit it.
  if ((PUBLIC_CONTENT_STATUSES as readonly ContentStatus[]).includes(resource.status)) return true

  return canPerform(type, 'update', actor, { authorId: resource.authorId })
}

export interface WriteIntent {
  /** The status the document will carry once the write lands. */
  readonly nextStatus: ContentStatus
  /** The status it carries now. Absent means this is a creation. */
  readonly currentStatus?: ContentStatus
}

/**
 * Every operation a write must be authorized for, not only the obvious one.
 *
 * `content:publish` is the cost of a document being in front of the public,
 * not the cost of the keystroke that put it there. So it is required whenever
 * a write touches a publishable state at either end:
 *
 * - **entering** one — createSchema and updateSchema both accept `published`,
 *   so a write checked against `create` or `update` alone lets a contributor
 *   reach the site by choosing a status;
 * - **staying** in one — editing live text is editing what the public reads,
 *   and a patch carrying no `status` at all is the ordinary way to do it;
 * - **leaving** one — unpublishing takes a page off the site, which is an
 *   editorial act however cheap the transition looks.
 *
 * The middle case is the one that reads as an omission until it bites: a
 * contributor writes a draft, an editor publishes it, and the contributor —
 * who still holds `content:update:own` over the row — keeps rewriting a
 * published page. This is the capability other systems name
 * `edit_published_posts`, expressed through one that already exists rather
 * than as a new one, because
 * the question it answers is the same question: may this actor decide what the
 * public sees.
 *
 * Statuses that are not publishable stay ungated between themselves: draft to
 * archived to trash costs update alone.
 */
export function operationsForWrite(intent: WriteIntent): readonly ContentOperation[] {
  const base: ContentOperation = intent.currentStatus === undefined ? 'create' : 'update'

  const touchesPublic =
    isPublishable(intent.nextStatus) ||
    (intent.currentStatus !== undefined && isPublishable(intent.currentStatus))

  return touchesPublic ? [base, 'publish'] : [base]
}

/**
 * The single authorization question for a write. Callers ask this rather than
 * assembling operationsForWrite and canPerform themselves, so that no route
 * can consult one and forget the other.
 */
export function canWrite(
  type: AnyContentType,
  intent: WriteIntent,
  actor: Actor,
  resource?: { readonly authorId: string | null },
): boolean {
  return operationsForWrite(intent).every((operation) =>
    canPerform(type, operation, actor, resource),
  )
}

/**
 * The same rule for removal. Deleting a published document takes it off the
 * site exactly as unpublishing does, and a policy that gated the second while
 * leaving the first open would be a rule anyone could route around by choosing
 * the more destructive verb.
 */
export function operationsForDelete(status: ContentStatus): readonly ContentOperation[] {
  return isPublishable(status) ? ['delete', 'publish'] : ['delete']
}

export function canDelete(
  type: AnyContentType,
  status: ContentStatus,
  actor: Actor,
  resource?: { readonly authorId: string | null },
): boolean {
  return operationsForDelete(status).every((operation) =>
    canPerform(type, operation, actor, resource),
  )
}

/**
 * Whether this actor may attach a translation to a group.
 *
 * "Being able to edit a member" is the **whole** write decision for that
 * member as it currently stands, not the raw `update` capability. The two came
 * apart the moment editing a live document started costing `content:publish`:
 * a contributor whose draft an editor published still holds
 * `content:update:own` over the row, so a rule phrased in capabilities alone
 * would let them keep extending a group whose only document they may no longer
 * touch. Adding a French version of a page you are not allowed to edit is the
 * same act as editing it, one step removed.
 *
 * `nextStatus` is the member's own status because nothing about it is
 * changing: the question is whether this actor could write that document at
 * all, right now.
 *
 * The alternative — a distinct "may translate" policy, looser than "may edit" —
 * is deliberately not taken. It would need a capability of its own
 * (an assigned-translator workflow is exactly that), and inventing one by
 * relaxing this check is how a group id becomes an access token again.
 */
export function canJoinTranslationGroup(
  type: AnyContentType,
  actor: Actor,
  members: readonly { readonly authorId: string | null; readonly status: ContentStatus }[],
): boolean {
  if (!canPerform(type, 'create', actor)) return false

  return members.some((member) =>
    canWrite(type, { currentStatus: member.status, nextStatus: member.status }, actor, member),
  )
}

/**
 * What this actor may do with this document, decided once on the server.
 *
 * The admin needs the same answers to grey out a control, and the only two
 * ways to give it them are to ship the policy to the client or to ship the
 * conclusion. This is the conclusion: the interface renders it and never
 * re-derives it, so a rule can never be enforced in one place and drawn
 * differently in the other. It is presentation data — every route still
 * decides for itself, against the locked row.
 */
export interface DocumentPermissions {
  /** Whether this document may be edited at all, leaving its status alone. */
  readonly update: boolean
  readonly delete: boolean
  /** The statuses this actor may move it to, current one included when it may stay. */
  readonly statuses: readonly ContentStatus[]
}

export function permissionsForDocument(
  type: AnyContentType,
  actor: Actor,
  resource: { readonly authorId: string | null; readonly status: ContentStatus },
): DocumentPermissions {
  const intent = (nextStatus: ContentStatus) => ({ currentStatus: resource.status, nextStatus })

  return {
    update: canWrite(type, intent(resource.status), actor, resource),
    delete: canDelete(type, resource.status, actor, resource),
    statuses: CONTENT_STATUSES.filter((status) => canWrite(type, intent(status), actor, resource)),
  }
}

/** The same, for a document that does not exist yet. */
export interface CreationPermissions {
  readonly create: boolean
  readonly statuses: readonly ContentStatus[]
}

export function permissionsForCreation(type: AnyContentType, actor: Actor): CreationPermissions {
  return {
    create: canPerform(type, 'create', actor),
    statuses: CONTENT_STATUSES.filter((status) => canWrite(type, { nextStatus: status }, actor)),
  }
}

export interface ContentTypeRegistry {
  get(name: string): AnyContentType | undefined
  /** Throws rather than returning undefined, for callers that already routed on it. */
  require(name: string): AnyContentType
  has(name: string): boolean
  names(): readonly string[]
  all(): readonly AnyContentType[]
}

/**
 * Built once and passed in, rather than a module-level mutable map. A global
 * registry makes every test that registers a type leak into the next one, and
 * makes it impossible to stand up two configurations side by side — which the
 * plugin sandbox in phase 5 will need to do.
 */
export function createContentTypeRegistry(types: readonly AnyContentType[]): ContentTypeRegistry {
  const byName = new Map<string, AnyContentType>()

  const byBasePath = new Map<string, string>()

  for (const type of types) {
    if (byName.has(type.name)) {
      throw new Error(`Content type "${type.name}" is registered twice`)
    }

    /*
     * Two types under one segment is a site where one of them is unreachable,
     * and the unreachable one is decided by registration order — which is a
     * plugin load order, so it would differ between installations. Refusing
     * here is the only place that can see both declarations at once.
     */
    const taken = byBasePath.get(type.basePath)
    if (taken !== undefined) {
      const where = type.basePath === '' ? 'the locale root' : `"/${type.basePath}"`
      throw new Error(`Content types "${taken}" and "${type.name}" both claim ${where}`)
    }

    byBasePath.set(type.basePath, type.name)
    byName.set(type.name, type)
  }

  return {
    get: (name) => byName.get(name),
    require: (name) => {
      const type = byName.get(name)
      if (!type) throw new Error(`Unknown content type "${name}"`)
      return type
    },
    has: (name) => byName.has(name),
    names: () => [...byName.keys()],
    all: () => [...byName.values()],
  }
}
