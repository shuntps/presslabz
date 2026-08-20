import { blockSchema } from '@presslabz/blocks'
import { isLocale } from '@presslabz/i18n'
import { z } from 'zod'
import { CONTENT_STATUSES } from './content-types.ts'

/**
 * What the API promises to send, written once.
 *
 * The admin used to declare these shapes for itself and `apiFetch` cast the
 * body to them without looking — so a field the API renamed, a null where a
 * string was expected, or a response from a proxy that answered instead of the
 * API all reached React state unexamined and failed several components later,
 * as `undefined is not an object` about something that was never the fault.
 *
 * One definition, therefore, on the boundary both sides face: the API's tests
 * parse what its routes actually answer, the admin parses what it actually
 * receives, and neither can drift without the other's tests noticing. The
 * types the interface uses are inferred from here rather than retyped, because
 * a second declaration is only a copy that is edited on a different day.
 *
 * These describe **serialized** responses, so instants are ISO strings rather
 * than `Date`s: this is what crosses the wire, not what the repositories hold.
 */

/** Serialized by `JSON.stringify(new Date())`, and parsed back as a string. */
const instant = z.iso.datetime()

/**
 * An identifier, as far as a client is concerned: a string it received and
 * hands back. They are uuids today and the database says so; asserting that
 * here would not make the client any safer — it never parses one — and would
 * make the format part of a contract that has no reason to promise it.
 */
const id = z.string().min(1)

const locale = z.string().refine(isLocale, { error: 'Unsupported locale' })

const contentStatus = z.enum(CONTENT_STATUSES)

export const documentPermissionsSchema = z.object({
  update: z.boolean(),
  delete: z.boolean(),
  statuses: z.array(contentStatus),
})

export const creationPermissionsSchema = z.object({
  create: z.boolean(),
  statuses: z.array(contentStatus),
})

/**
 * `blocks` is validated with the real block vocabulary rather than as opaque
 * JSON. It is the one field the editor mounts directly into its state, so a
 * block type this build does not know about is better refused here than
 * rendered as a hole.
 *
 * The vocabulary, but not `blocksSchema`'s uniqueness rule: a document whose
 * blocks share an id is exactly what the editor repairs on load, and refusing
 * it at the boundary would make an importable document unopenable instead —
 * the one document that most needs opening. The rule still holds where it
 * decides something, which is on the way in to the database.
 */
export const contentSummarySchema = z.object({
  permissions: documentPermissionsSchema,
  id,
  type: z.string(),
  locale,
  translationGroupId: id,
  slug: z.string(),
  status: contentStatus,
  title: z.string(),
  excerpt: z.string().nullable(),
  blocks: z.array(blockSchema),
  meta: z.record(z.string(), z.unknown()),
  authorId: id.nullable(),
  parentId: id.nullable(),
  publishedAt: instant.nullable(),
  /** Sent so it can be sent back: an update states the version it was composed against. */
  version: z.number().int(),
  createdAt: instant,
  updatedAt: instant,
})

export type ContentSummary = z.infer<typeof contentSummarySchema>

/**
 * A document and its other languages, which is the unit this interface works
 * in. The pair is assembled by the server: pairing two independently paginated
 * listings in the browser cannot work, because the second page of one language
 * has no reason to hold the partners of the second page of the other.
 */
export const translationGroupSchema = z.object({
  translationGroupId: id,
  /** The document in the locale being listed. Always present. */
  primary: contentSummarySchema,
  /** Siblings in other languages, by locale. */
  siblings: z.record(locale, contentSummarySchema),
})

export type TranslationGroupSummary = z.infer<typeof translationGroupSchema>

/**
 * An opaque string. Its contents are the server's business — it is decoded
 * only by the code that issued it, and a client that takes it apart is relying
 * on something no version of this API promises.
 */
export const cursorSchema = z.string().min(1).max(512)

export const contentPageSchema = z.object({
  groups: z.array(translationGroupSchema),
  /**
   * The whole set, not this page: the heading says "5 total · 2 in draft"
   * about the type, and counting the rows in hand would make that number mean
   * "so far", which is a different and useless statement.
   */
  total: z.number().int().nonnegative(),
  drafts: z.number().int().nonnegative(),
  /** Absent when this page is the last one. */
  nextCursor: cursorSchema.nullable(),
})

export type ContentPage = z.infer<typeof contentPageSchema>

/**
 * What the installation serves, as `GET /config` answers it.
 *
 * The languages a site is configured for, which is not the same question as
 * the languages PressLabz has catalogues for: an installation may ship three
 * and serve one. Content is written in these; the interface is translated into
 * the catalogue, which is why the language switcher and the document's
 * language are two different lists.
 */
export const installationConfigSchema = z.object({
  locales: z.array(locale).min(1),
  defaultLocale: locale,
})

export type InstallationConfig = z.infer<typeof installationConfigSchema>

export const contentTypeSummarySchema = z.object({
  name: z.string(),
  hierarchical: z.boolean(),
  taxonomies: z.array(z.string()),
  permissions: creationPermissionsSchema,
})

export type ContentTypeSummary = z.infer<typeof contentTypeSummarySchema>

export const contentTypesSchema = z.object({ types: z.array(contentTypeSummarySchema) })

export const contentDocumentSchema = z.object({ content: contentSummarySchema })

/**
 * A document's whole group, as the editor asks for it. A flat list rather than
 * a map by language: the endpoint drops siblings this actor may not read, and
 * a map would invite the interface to treat a missing key as "no translation
 * exists" when it may mean "not yours to see".
 */
export const translationSetSchema = z.object({
  translations: z.array(contentSummarySchema),
  /** Whether this actor may start a translation *in this group*. */
  permissions: z.object({ create: z.boolean() }),
})

export type TranslationSet = z.infer<typeof translationSetSchema>

export const mediaRenditionSchema = z.object({
  name: z.string(),
  url: z.url(),
  contentType: z.string(),
  byteSize: z.number().int().nonnegative(),
})

export const mediaSummarySchema = z.object({
  permissions: z.object({ update: z.boolean() }),
  id,
  url: z.url(),
  mimeType: z.string(),
  byteSize: z.number().int().nonnegative(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  alt: z.record(z.string(), z.string()),
  createdAt: instant,
  renditions: z.array(mediaRenditionSchema),
})

export type MediaSummary = z.infer<typeof mediaSummarySchema>

export const mediaPageSchema = z.object({
  media: z.array(mediaSummarySchema),
  /** Whether this actor may add to the library at all. */
  permissions: z.object({ upload: z.boolean() }),
  nextCursor: cursorSchema.nullable(),
})

export type MediaPage = z.infer<typeof mediaPageSchema>

export const mediaDocumentSchema = z.object({ media: mediaSummarySchema })

/**
 * How many rows a page holds when the client does not say.
 *
 * Small enough that the first screen arrives quickly, large enough that most
 * installations never press "load more" at all. The maximum exists because
 * `limit` is a number a client chooses, and one that chooses ten thousand is
 * asking this process to hold ten thousand documents in memory.
 */
export const DEFAULT_PAGE_SIZE = 25
export const MAX_PAGE_SIZE = 100

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: cursorSchema.optional(),
})
