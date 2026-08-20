import { describe, expect, it } from 'vitest'
import { LOCALE_COOKIE_NAME, readLocaleCookie } from './cookie.ts'

/**
 * The interface's language survives a reload because it is written down. What
 * matters here is the other half: that reading it back can never be the reason
 * the interface fails to start.
 */
describe('readLocaleCookie', () => {
  it('returns the language somebody chose', () => {
    expect(readLocaleCookie(`${LOCALE_COOKIE_NAME}=fr`)).toBe('fr')
    expect(readLocaleCookie(`a=1; ${LOCALE_COOKIE_NAME}=en; b=2`)).toBe('en')
  })

  it('returns null when nothing was chosen', () => {
    expect(readLocaleCookie(undefined)).toBeNull()
    expect(readLocaleCookie('')).toBeNull()
    expect(readLocaleCookie('session=abc')).toBeNull()
  })

  it('refuses a language this build has no catalogue for', () => {
    // Not an error: a site that dropped a language leaves these cookies in
    // browsers, and the answer is to fall back rather than to break.
    expect(readLocaleCookie(`${LOCALE_COOKIE_NAME}=de`)).toBeNull()
    expect(readLocaleCookie(`${LOCALE_COOKIE_NAME}=`)).toBeNull()
  })

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(readLocaleCookie(`not-${LOCALE_COOKIE_NAME}=fr`)).toBeNull()
  })

  it.for([['%E0%A4%A'], ['%'], ['f%r'], ['%%%']])(
    'answers null rather than throwing on %s',
    ([value]) => {
      expect(() => readLocaleCookie(`${LOCALE_COOKIE_NAME}=${value}`)).not.toThrow()
      expect(readLocaleCookie(`${LOCALE_COOKIE_NAME}=${value}`)).toBeNull()
    },
  )
})
