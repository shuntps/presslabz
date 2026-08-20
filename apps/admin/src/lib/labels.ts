import type { ContentStatus } from '@presslabz/core'
import type { MessageKey } from '@presslabz/i18n'

/**
 * What the interface calls a content type and a status.
 *
 * Both maps existed twice — the type labels in the rail and in the listing, the
 * status labels in the listing and in the editor — which is two chances to
 * translate the same word differently and one of them to be forgotten when a
 * status is added.
 *
 * Types are keyed loosely because a content type is declared in code and a
 * plugin will declare its own in phase 5; an unknown name renders as itself
 * rather than as a missing-key placeholder. Statuses are the closed set the
 * core defines, so the map is exhaustive and the compiler says so.
 */
export const TYPE_LABELS: Record<string, MessageKey> = {
  post: 'content.type.post.plural',
  page: 'content.type.page.plural',
}

export const STATUS_LABELS: Record<ContentStatus, MessageKey> = {
  draft: 'content.status.draft',
  scheduled: 'content.status.scheduled',
  published: 'content.status.published',
  archived: 'content.status.archived',
  trash: 'content.status.trash',
}
