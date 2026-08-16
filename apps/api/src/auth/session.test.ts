import { describe, expect, it } from 'vitest'
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_TTL_MS,
  sessionCookieOptions,
  sessionExpiry,
  shouldRenew,
} from './session.ts'

describe('generateSessionToken', () => {
  it('returns 256 bits encoded as url-safe base64', () => {
    const token = generateSessionToken()
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(Buffer.from(token, 'base64url')).toHaveLength(32)
  })

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateSessionToken))
    expect(tokens.size).toBe(500)
  })
})

describe('hashSessionToken', () => {
  it('is deterministic', () => {
    const token = generateSessionToken()
    expect(hashSessionToken(token)).toBe(hashSessionToken(token))
  })

  it('never returns the token itself', () => {
    // What lands in the database must not be usable as a cookie value.
    const token = generateSessionToken()
    expect(hashSessionToken(token)).not.toBe(token)
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/)
  })

  it('separates tokens that differ by one character', () => {
    expect(hashSessionToken('a')).not.toBe(hashSessionToken('b'))
  })
})

describe('renewal', () => {
  const now = new Date('2026-01-01T00:00:00Z')

  it('leaves a fresh session alone', () => {
    expect(shouldRenew(sessionExpiry(now), now)).toBe(false)
  })

  it('extends one that is more than half spent', () => {
    const nearlyExpired = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000)
    expect(shouldRenew(nearlyExpired, now)).toBe(true)
  })

  it('extends one that has already lapsed', () => {
    expect(shouldRenew(new Date(now.getTime() - 1), now)).toBe(true)
  })

  it('issues a 30 day expiry', () => {
    expect(sessionExpiry(now).getTime() - now.getTime()).toBe(SESSION_TTL_MS)
  })
})

describe('sessionCookieOptions', () => {
  it('is always httpOnly and lax, and secure in production', () => {
    // httpOnly is the difference between an XSS that defaces a page and one
    // that steals every editor's session.
    expect(sessionCookieOptions(true)).toMatchObject({
      httpOnly: true,
      sameSite: 'lax',
      secure: true,
      path: '/',
    })
    expect(sessionCookieOptions(false).secure).toBe(false)
    expect(sessionCookieOptions(false).httpOnly).toBe(true)
  })
})
