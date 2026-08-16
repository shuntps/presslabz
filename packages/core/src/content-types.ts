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
  /** Validates a whole document on the way in. */
  readonly createSchema: z.ZodType
  /** The same, with every field optional. Locale is absent on purpose. */
  readonly updateSchema: z.ZodType
}

export function defineContentType<TMeta extends z.ZodType = typeof metaDefault>(
  options: ContentTypeOptions<TMeta>,
) {
  if (!CONTENT_TYPE_NAME_PATTERN.test(options.name)) {
    throw new Error(`Content type name "${options.name}" must match ${CONTENT_TYPE_NAME_PATTERN}`)
  }

  const hierarchical = options.hierarchical ?? false
  const meta = (options.meta ?? metaDefault) as TMeta

  const base = {
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

  const createSchema = z
    .object({
      /**
       * Locale is required on create and absent from update. Every document
       * is one translation, and moving an existing one between languages
       * would silently change which unique (type, locale, slug) row it
       * collides with — a rename dressed up as an edit.
       */
      locale: z.string().refine(isLocale, { message: 'Unsupported locale' }),
      /** Supplied to attach this document to an existing translation group. */
      translationGroupId: z.uuid().optional(),
      ...base,
    })
    .refine((value) => value.status !== 'scheduled' || value.publishedAt !== undefined, {
      message: 'A scheduled document needs a publication date',
      path: ['publishedAt'],
    })

  const updateSchema = z
    .object(base)
    .partial()
    .refine((value) => value.status !== 'scheduled' || value.publishedAt !== undefined, {
      message: 'A scheduled document needs a publication date',
      path: ['publishedAt'],
    })

  return {
    name: options.name,
    hierarchical,
    taxonomies: options.taxonomies ?? [],
    meta,
    access: { ...DEFAULT_ACCESS, ...options.access },
    createSchema,
    updateSchema,
  } satisfies AnyContentType
}

/**
 * Whether an actor may perform an operation on a document. The single
 * authorization question for content, so the REST route, the tRPC procedure
 * and anything a plugin calls all reach the same answer.
 *
 * It takes capabilities rather than a role, which is what keeps roles from
 * leaking out of capabilities.ts, and it owns the ownership comparison so no
 * caller re-derives it. Omit `resource` for operations that have no row yet.
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
