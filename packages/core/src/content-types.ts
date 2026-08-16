import { blocksSchema } from '@presslabz/blocks'
import { isLocale } from '@presslabz/i18n'
import { z } from 'zod'
import type { Capability } from './capabilities.ts'
import { slugSchema } from './slug.ts'

/**
 * Content types are declared in code, not stored as rows.
 *
 * WordPress registers a post type at runtime and then has no idea what its
 * metadata looks like, which is why `get_post_meta()` returns unknown shapes
 * forever. Here one call fixes the metadata schema, the capabilities each
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
 * What an operation costs.
 *
 * `own` exists because authorship changes the answer: a contributor may edit
 * their own draft and not anyone else's. Expressing that as two capabilities
 * rather than as a role check is what keeps `roleHasCapability` out of route
 * handlers — see the capability model in packages/core/src/capabilities.ts.
 */
export interface OperationAccess {
  /** Allows the operation on any row. */
  readonly any: Capability
  /** Allows it only on rows the actor authored. Absent when authorship is irrelevant. */
  readonly own?: Capability
}

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
  /** Shape of `contents.meta`. Replaces wp_postmeta's unknowable key-value soup. */
  readonly meta?: TMeta
  /** Overrides the defaults above, one operation at a time. */
  readonly access?: Partial<Record<ContentOperation, OperationAccess>>
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

  const hierarchical = options.hierarchical ?? false
  const meta = (options.meta ?? metaDefault) as TMeta

  const stateShape = {
    slug: slugSchema,
    title: z.string().min(1).max(300),
    excerpt: z.string().max(1000).optional(),
    status: z.enum(CONTENT_STATUSES).default('draft'),
    blocks: blocksSchema.default([]),
    meta,
    /**
     * A schedule is a promise about a moment, so it needs one. Accepting
     * `scheduled` without a date is how a document ends up in a state that
     * nothing will ever move it out of.
     */
    publishedAt: z.coerce.date().optional(),
    ...(hierarchical ? { parentId: z.uuid().optional() } : {}),
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
    locale: z
      .never({ error: 'A document cannot change language; create the translation instead' })
      .optional(),
  })

  return {
    name: options.name,
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
  actor: { readonly capabilities: ReadonlySet<Capability>; readonly id: string | null },
  resource?: { readonly authorId: string | null },
): boolean {
  const access = type.access[operation]
  if (actor.capabilities.has(access.any)) return true
  if (!access.own || !actor.capabilities.has(access.own)) return false

  // A document whose author was deleted is owned by nobody, and an anonymous
  // actor owns nothing — neither may be matched by an "own only" capability.
  return actor.id !== null && resource?.authorId != null && actor.id === resource.authorId
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
 * The hole this closes: createSchema and updateSchema both accept `published`
 * and `scheduled`, so a write checked against `create` or `update` alone lets
 * a contributor put a document on the site by choosing a status. The schema
 * validated it and `content:publish` was never consulted. Reaching a
 * publishable state is a publishing decision whichever field carries it.
 *
 * Two adjacent cases are deliberately *not* covered, because closing them
 * needs a capability that does not exist rather than a reinterpretation of one
 * that does. Leaving a publishable state is ungated, so anyone who may edit a
 * document may also take it off the site. And editing a document that is
 * already live is ungated, so a contributor keeps editing their own post after
 * an editor published it. Both want the equivalent of WordPress's
 * `edit_published_posts`; neither should be smuggled in here.
 */
export function operationsForWrite(intent: WriteIntent): readonly ContentOperation[] {
  const base: ContentOperation = intent.currentStatus === undefined ? 'create' : 'update'
  const wasPublishable = intent.currentStatus !== undefined && isPublishable(intent.currentStatus)

  if (isPublishable(intent.nextStatus) && !wasPublishable) return [base, 'publish']
  return [base]
}

/**
 * The single authorization question for a write. Callers ask this rather than
 * assembling operationsForWrite and canPerform themselves, so that no route
 * can consult one and forget the other.
 */
export function canWrite(
  type: AnyContentType,
  intent: WriteIntent,
  actor: { readonly capabilities: ReadonlySet<Capability>; readonly id: string | null },
  resource?: { readonly authorId: string | null },
): boolean {
  return operationsForWrite(intent).every((operation) =>
    canPerform(type, operation, actor, resource),
  )
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

  for (const type of types) {
    if (byName.has(type.name)) {
      throw new Error(`Content type "${type.name}" is registered twice`)
    }
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
