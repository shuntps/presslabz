import { describe, expect, it } from 'vitest'
import {
  isThemePreference,
  readThemeCookie,
  resolveTheme,
  THEME_ATTRIBUTE,
  THEME_COOKIE_NAME,
  THEME_INIT_SCRIPT,
} from './index.ts'

/**
 * THEME_INIT_SCRIPT is a static literal on purpose, so nothing enforces at
 * compile time that it still matches the constants. These tests do.
 */
describe('THEME_INIT_SCRIPT', () => {
  it('reads the same cookie name the rest of the module writes', () => {
    expect(THEME_INIT_SCRIPT).toContain(THEME_COOKIE_NAME)
  })

  it('sets the same attribute the stylesheet selects on', () => {
    expect(THEME_INIT_SCRIPT).toContain(`"${THEME_ATTRIBUTE}"`)
  })

  it('never writes "system" as an attribute value', () => {
    // 'system' means "no attribute". Writing it would freeze the page on
    // whatever the OS preferred at load time.
    expect(THEME_INIT_SCRIPT).not.toContain('"system"')
  })

  it('builds no code from interpolated values', () => {
    expect(THEME_INIT_SCRIPT).not.toContain('${')
  })

  it('applies only light or dark, and ignores anything else', () => {
    const run = (cookie: string) => {
      let written: string | null = null
      const scope = {
        document: {
          cookie,
          documentElement: {
            setAttribute: (key: string, value: string) => {
              written = `${key}=${value}`
            },
          },
        },
      }
      new Function('document', THEME_INIT_SCRIPT)(scope.document)
      return written
    }

    expect(run(`${THEME_COOKIE_NAME}=dark`)).toBe('data-theme=dark')
    expect(run(`other=1; ${THEME_COOKIE_NAME}=light`)).toBe('data-theme=light')
    expect(run(`${THEME_COOKIE_NAME}=system`)).toBeNull()
    expect(run('')).toBeNull()
    expect(run(`${THEME_COOKIE_NAME}=%3Cscript%3E`)).toBeNull()
  })
})

describe('readThemeCookie', () => {
  it('returns null when nothing was ever chosen', () => {
    expect(readThemeCookie(undefined)).toBeNull()
    expect(readThemeCookie('')).toBeNull()
    expect(readThemeCookie('session=abc')).toBeNull()
  })

  it('distinguishes an explicit "system" from no choice at all', () => {
    expect(readThemeCookie(`${THEME_COOKIE_NAME}=system`)).toBe('system')
    expect(readThemeCookie('session=abc')).toBeNull()
  })

  it('finds the cookie among others, in any position', () => {
    expect(readThemeCookie(`a=1; ${THEME_COOKIE_NAME}=dark; b=2`)).toBe('dark')
  })

  it('rejects a value that is not a known preference', () => {
    expect(readThemeCookie(`${THEME_COOKIE_NAME}=purple`)).toBeNull()
    expect(readThemeCookie(`${THEME_COOKIE_NAME}=`)).toBeNull()
  })

  it('does not match a cookie whose name merely ends with ours', () => {
    expect(readThemeCookie(`not-${THEME_COOKIE_NAME}=dark`)).toBeNull()
  })

  /*
   * A cookie value is a string anybody on the host can write, and
   * decodeURIComponent throws on a malformed escape. This is read while the
   * interface is initialising, so the throw did not give somebody the wrong
   * theme — it stopped the admin from rendering at all, after the pre-paint
   * script had already drawn the page.
   */
  it.for([
    ['a truncated escape', '%E0%A4%A'],
    ['a lone percent', '%'],
    ['a half-written pair', 'da%rk'],
    ['nothing but escapes', '%%%'],
  ])('answers null rather than throwing on %s', ([, value]) => {
    expect(() => readThemeCookie(`${THEME_COOKIE_NAME}=${value}`)).not.toThrow()
    expect(readThemeCookie(`${THEME_COOKIE_NAME}=${value}`)).toBeNull()
  })

  it('still reads a properly escaped value', () => {
    expect(readThemeCookie(`${THEME_COOKIE_NAME}=${encodeURIComponent('dark')}`)).toBe('dark')
  })
})

describe('resolveTheme', () => {
  it('passes an explicit choice through unchanged', () => {
    expect(resolveTheme('light', true)).toBe('light')
    expect(resolveTheme('dark', false)).toBe('dark')
  })

  it('follows the system preference only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
  })
})

describe('isThemePreference', () => {
  it('accepts the three supported states', () => {
    expect(isThemePreference('light')).toBe(true)
    expect(isThemePreference('dark')).toBe(true)
    expect(isThemePreference('system')).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isThemePreference('auto')).toBe(false)
    expect(isThemePreference(null)).toBe(false)
    expect(isThemePreference(undefined)).toBe(false)
  })
})
