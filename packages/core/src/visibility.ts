import { type ContentStatus, PUBLIC_CONTENT_STATUSES } from './content-types.ts'

/**
 * What the public site is allowed to render.
 *
 * This is deliberately not `canReadDocument` with an anonymous actor. That
 * function answers for an actor — it compares authorship and capabilities,
 * and an anonymous one simply owns nothing. This one answers for the site:
 * there is no actor at all, and the only question is whether a row has become
 * public yet.
 *
 * The two differ on one row, and the difference is the reason this exists. A
 * document can carry `published` with a `publishedAt` in the future, because
 * nothing yet moves `scheduled` to `published` when its time comes and an
 * editor can set both by hand. Rendering it because its status says so would
 * publish it early through the front door.
 *
 * `scheduled` stays invisible whatever its date. Making a scheduled row appear
 * once its time has passed is the scheduler's job — it has to write the row,
 * fire the hooks and purge the cache — and answering it here would be that
 * feature implemented in the one place that cannot do any of those.
 */
export interface PublishedResource {
  readonly status: ContentStatus
  readonly publishedAt: Date | null
}

export function isPubliclyVisible(resource: PublishedResource, now: Date = new Date()): boolean {
  if (!(PUBLIC_CONTENT_STATUSES as readonly ContentStatus[]).includes(resource.status)) return false
  return resource.publishedAt === null || resource.publishedAt.getTime() <= now.getTime()
}
