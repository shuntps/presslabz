import { type Actor, allows, type OperationAccess } from './access.ts'

/**
 * What an asset costs to touch.
 *
 * Uploading is a create: it needs no row and therefore has no owner to compare
 * against. Editing is the operation that gained an owner, because the metadata
 * of an asset belongs to whoever put it there — `media:upload` was standing in
 * for both, so every author could rewrite every other author's alt text.
 *
 * Deleting stays `:any` only. An author who could delete their own uploads
 * could remove an image out from under a document somebody else is publishing,
 * and nothing in the schema stops that yet; a `media:delete:own` that is safe
 * needs reference counting, which is a different piece of work.
 */
export const MEDIA_OPERATIONS = ['read', 'upload', 'update', 'delete'] as const
export type MediaOperation = (typeof MEDIA_OPERATIONS)[number]

export const MEDIA_ACCESS: Readonly<Record<MediaOperation, OperationAccess>> = {
  read: { any: 'media:read' },
  upload: { any: 'media:upload' },
  update: { any: 'media:update:any', own: 'media:update:own' },
  delete: { any: 'media:delete:any' },
}

/** An asset, reduced to what an authorization decision needs from it. */
export interface MediaResource {
  /** Null once the uploader's account is gone. */
  readonly uploadedById: string | null
}

export function canPerformOnMedia(
  operation: MediaOperation,
  actor: Actor,
  resource?: MediaResource,
): boolean {
  return allows(MEDIA_ACCESS[operation], actor, resource?.uploadedById)
}

/**
 * Whether this actor may edit this asset's metadata. The single decision, so
 * the route that enforces it and the interface that greys the field out cannot
 * answer differently — the interface asks the server rather than re-deriving.
 *
 * An asset with no uploader needs `media:update:any`: `uploadedById` is set to
 * null when the account goes, and treating "owned by nobody" as "owned by
 * whoever is asking" would hand every orphaned asset to every author.
 */
export function canEditMedia(actor: Actor, resource: MediaResource): boolean {
  return canPerformOnMedia('update', actor, resource)
}

/**
 * Where readers fetch an asset from.
 *
 * Two apps need this answer — the API when it reports an upload, the public
 * site when it renders a block — and they must agree, because a page holding
 * one host while the CDN is configured as another is a broken image that only
 * appears in production.
 *
 * `mediaBaseUrl` is the CDN in front of the bucket; without it the endpoint the
 * API writes to is also the one readers use, which is what a local store serves
 * locally.
 */
export function resolveMediaBase(config: {
  readonly mediaBaseUrl?: string | undefined
  readonly s3Endpoint: string
  readonly s3Bucket: string
}): string {
  const base = config.mediaBaseUrl ?? `${config.s3Endpoint}/${config.s3Bucket}`
  return base.endsWith('/') ? base.slice(0, -1) : base
}

export function mediaUrl(base: string, storageKey: string): string {
  return `${base}/${storageKey}`
}
