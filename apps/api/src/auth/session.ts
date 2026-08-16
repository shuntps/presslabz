import { createHash, randomBytes } from 'node:crypto'

export const SESSION_COOKIE = 'presslabz_session'

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Below this remaining lifetime, an active session is extended on use. */
const RENEW_BELOW_MS = 15 * 24 * 60 * 60 * 1000

/** 256 bits from the CSPRNG. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

/**
 * SHA-256, deliberately not Argon2. A session token is 256 bits of random
 * data, not a low-entropy secret a human chose, so there is nothing to slow
 * an attacker down about — brute force is already infeasible. Argon2 here
 * would only add latency to every authenticated request.
 */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionExpiry(from: Date = new Date()): Date {
  return new Date(from.getTime() + SESSION_TTL_MS)
}

/**
 * Whether an active session is close enough to expiry to be extended on use.
 *
 * An expired session is not renewable, and saying otherwise was a footgun
 * rather than a live bug: the only caller runs after findValidSession, which
 * already excludes expired rows. But a predicate that answers "yes, renew it"
 * about a session that is over is wrong on its own terms, and the next caller
 * would have no reason to suspect it.
 */
export function shouldRenew(expiresAt: Date, now: Date = new Date()): boolean {
  const remaining = expiresAt.getTime() - now.getTime()
  return remaining > 0 && remaining < RENEW_BELOW_MS
}

export function sessionCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: isProduction,
    path: '/',
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  } as const
}
