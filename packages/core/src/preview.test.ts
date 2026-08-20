import { describe, expect, it } from 'vitest'
import { previewPath, signPreviewToken, verifyPreviewToken } from './preview.ts'

const SECRET = 'a'.repeat(48)
const OTHER = 'b'.repeat(48)
const ID = '0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c22'
const NOW = 1_800_000_000_000

const claims = { contentId: ID, expiresAt: NOW + 600_000 }

describe('preview tokens', () => {
  it('round-trips the document it names', () => {
    const token = signPreviewToken(claims, SECRET)
    expect(verifyPreviewToken(token, SECRET, NOW)).toEqual(claims)
  })

  it('refuses a token signed with another installation secret', () => {
    expect(verifyPreviewToken(signPreviewToken(claims, OTHER), SECRET, NOW)).toBeNull()
  })

  /*
   * The whole point of a short life: this is a bearer token in a URL, and URLs
   * end up in logs, in referrers and in screenshots.
   */
  it('refuses a token whose moment has passed', () => {
    const token = signPreviewToken(claims, SECRET)

    expect(verifyPreviewToken(token, SECRET, claims.expiresAt - 1)).not.toBeNull()
    expect(verifyPreviewToken(token, SECRET, claims.expiresAt)).toBeNull()
    expect(verifyPreviewToken(token, SECRET, claims.expiresAt + 1)).toBeNull()
  })

  it('refuses a payload edited to name another document', () => {
    const token = signPreviewToken(claims, SECRET)
    const [, signature] = token.split('.') as [string, string]
    const forged = Buffer.from(
      JSON.stringify({ contentId: 'another', expiresAt: claims.expiresAt }),
    ).toString('base64url')

    expect(verifyPreviewToken(`${forged}.${signature}`, SECRET, NOW)).toBeNull()
  })

  it('refuses anything that is not a token at all', () => {
    for (const value of ['', '.', 'nodot', 'a.b.c', 'a.', '.b']) {
      expect(verifyPreviewToken(value, SECRET, NOW)).toBeNull()
    }
  })

  /*
   * A secret short enough to guess is worse than no preview: it would hand
   * over every unpublished document on the installation.
   */
  it('refuses to sign with a secret that is too short', () => {
    expect(() => signPreviewToken(claims, 'short')).toThrow(/at least 32/)
  })

  it('names one place a token is redeemed', () => {
    expect(previewPath('fr', 'abc.def')).toBe('/fr/preview/abc.def')
  })
})
