import type { Blocks } from '@presslabz/blocks'
import type { ContentStatus } from './content-types.ts'
import type { Hooks } from './hooks.ts'

/**
 * What the core announces, and what it lets be changed.
 *
 * These two maps are the extension API. Adding a key here is adding a promise
 * that has to survive the next refactor, which is why the payloads are the
 * smallest thing a handler could need rather than the row that happened to be
 * in hand: a handler given the whole row would come to depend on columns that
 * are nobody's business, and removing one would break plugins that had no
 * reason to care.
 *
 * Every payload is a plain, already-resolved value. Nothing here carries a
 * database handle, a request, or a function that reaches back into the core.
 */

export interface ContentEvent {
  readonly id: string
  readonly type: string
  readonly locale: string
  readonly translationGroupId: string
  readonly slug: string
  readonly title: string
  readonly status: ContentStatus
  readonly publishedAt: Date | null
  /** Null when the account that wrote it is gone. */
  readonly authorId: string | null
}

export interface ContentTransition extends ContentEvent {
  /** What the document was before this write. */
  readonly previousStatus: ContentStatus
}

export interface MediaEvent {
  readonly id: string
  readonly mimeType: string
  readonly uploadedById: string | null
}

/**
 * Announcements. A handler is told; it changes nothing and cannot fail the
 * write that caused it.
 *
 * `content:published` and `content:unpublished` exist beside
 * `content:updated` because "did this just become visible" is the question
 * almost every integration actually asks, and making each of them re-derive
 * it from a status pair is how they all get it slightly differently.
 */
export interface CoreActions extends Record<string, unknown> {
  'content:created': ContentEvent
  'content:updated': ContentTransition
  'content:published': ContentTransition
  'content:unpublished': ContentTransition
  'content:deleted': ContentEvent
  'media:uploaded': MediaEvent
  'media:updated': MediaEvent
  'media:deleted': MediaEvent
}

export interface BlocksFilter {
  readonly blocks: Blocks
  readonly content: ContentEvent
}

export interface ExcerptFilter {
  /** What the author wrote, which is empty far more often than not. */
  readonly excerpt: string
  /** The document itself, since deriving one means reading it. */
  readonly blocks: Blocks
  readonly content: ContentEvent
}

/**
 * Values a handler may change.
 *
 * A filter returns the same shape it was given — that is the contract, and it
 * is what keeps an extension from turning a document into something the
 * renderer has never seen. `content:blocks` is checked against the block
 * schema after the chain runs, because a filter is code and the whitelist is
 * the only thing standing between stored content and the page.
 */
export interface CoreFilters extends Record<string, unknown> {
  'content:blocks': BlocksFilter
  'content:excerpt': ExcerptFilter
}

export type CoreHooks = Hooks<CoreActions, CoreFilters>

/** The event a write announces, reduced to what an extension may see. */
export function contentEventOf(row: {
  id: string
  type: string
  locale: string
  translationGroupId: string
  slug: string
  title: string
  status: ContentStatus
  publishedAt: Date | null
  authorId: string | null
}): ContentEvent {
  return {
    id: row.id,
    type: row.type,
    locale: row.locale,
    translationGroupId: row.translationGroupId,
    slug: row.slug,
    title: row.title,
    status: row.status,
    publishedAt: row.publishedAt,
    authorId: row.authorId,
  }
}

/**
 * Which announcements a write makes.
 *
 * One write can be two events — an edit that also publishes is both — and
 * deciding that here rather than in each route is what keeps every caller
 * from inventing its own idea of what "published" means.
 */
export function transitionsFor(
  previousStatus: ContentStatus,
  event: ContentEvent,
): { readonly name: keyof CoreActions & string; readonly payload: ContentTransition }[] {
  const payload: ContentTransition = { ...event, previousStatus }
  const announcements: { name: keyof CoreActions & string; payload: ContentTransition }[] = [
    { name: 'content:updated', payload },
  ]

  const wasPublic = previousStatus === 'published'
  const isPublic = event.status === 'published'

  if (!wasPublic && isPublic) announcements.push({ name: 'content:published', payload })
  if (wasPublic && !isPublic) announcements.push({ name: 'content:unpublished', payload })

  return announcements
}
