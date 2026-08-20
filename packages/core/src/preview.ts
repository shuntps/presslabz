import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * A capability to view one unpublished document, for a short while.
 *
 * Deliberately not the session cookie. The API's cookie is host-only and
 * `SameSite=Lax`, so a public site on another host cannot read it — and the
 * fix people reach for, widening it to `Domain=.example.com`, hands the
 * session to every subdomain that exists now or later. A signed token names
 * one document, expires in minutes, and works whether the two are one host or
 * four.
 *
 * It is a bearer token in a URL, which is the honest cost: URLs end up in
 * logs, in referrers, in a screenshot in a chat. That is why the lifetime is
 * short, why it names a single document rather than an actor, and why the page
 * it opens sends no referrer and refuses to be cached or indexed.
 *
 * Not re-exported from the package index on purpose. It imports node:crypto,
 * and the index is bundled into the admin's browser build; a subpath keeps it
 * out of a graph it has no business being in.
 */

export interface PreviewClaims {
  readonly contentId: string
  /** Milliseconds since the epoch, the same clock `Date.now()` reads. */
  readonly expiresAt: number
}

const encode = (value: Buffer | string): string => Buffer.from(value as never).toString('base64url')

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function signPreviewToken(claims: PreviewClaims, secret: string): string {
  if (secret.length < 32) throw new Error('The preview secret must be at least 32 characters')

  const payload = encode(JSON.stringify(claims))
  return `${payload}.${sign(payload, secret)}`
}

/**
 * Returns the claims, or null for anything that is not a live token this
 * installation issued.
 *
 * One null for every failure — bad shape, wrong signature, expired — because
 * the caller answers 404 either way and telling the holder *which* of those it
 * was is telling them how to get closer.
 */
export function verifyPreviewToken(
  token: string,
  secret: string,
  now: number = Date.now(),
): PreviewClaims | null {
  const parts = token.split('.')
  if (parts.length !== 2) return null

  const [payload, signature] = parts as [string, string]

  const expected = Buffer.from(sign(payload, secret))
  const received = Buffer.from(signature)

  /*
   * Length first, then a constant-time compare. timingSafeEqual throws on a
   * length mismatch rather than returning false, and comparing lengths is not
   * a leak: the signature length is fixed by the algorithm.
   */
  if (expected.length !== received.length) return null
  if (!timingSafeEqual(expected, received)) return null

  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PreviewClaims

    if (typeof claims?.contentId !== 'string' || typeof claims?.expiresAt !== 'number') return null
    if (claims.expiresAt <= now) return null

    return { contentId: claims.contentId, expiresAt: claims.expiresAt }
  } catch {
    return null
  }
}

/** Where a token is redeemed. One place, so the two apps cannot disagree. */
export function previewPath(locale: string, token: string): string {
  return `/${locale}/preview/${token}`
}
