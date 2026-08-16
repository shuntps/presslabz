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

export function shouldRenew(expiresAt: Date, now: Date = new Date()): boolean {
  return expiresAt.getTime() - now.getTime() < RENEW_BELOW_MS
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
