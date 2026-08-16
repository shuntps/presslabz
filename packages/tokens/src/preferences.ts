/**
 * Everything here is free of DOM types, so the API can import it to validate
 * a preference or read a Cookie header without pretending it has a document.
 * The DOM helpers live in ./dom.ts.
 */

export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** What actually gets painted, once 'system' has been resolved. */
export type ResolvedTheme = 'light' | 'dark'

export const THEME_COOKIE_NAME = 'presslabz-theme'
export const THEME_ATTRIBUTE = 'data-theme'
export const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function isThemePreference(value: unknown): value is ThemePreference {
  return typeof value === 'string' && (THEME_PREFERENCES as readonly string[]).includes(value)
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (preference === 'system') return prefersDark ? 'dark' : 'light'
  return preference
}

/**
 * Reads the preference from a Cookie header. For server use on routes that
 * are not shared-cached — never to render a theme into cacheable HTML, or the
 * first visitor's choice is what every later visitor gets served.
 *
 * Returns null when nothing was chosen, which is distinct from an explicit
 * 'system': the latter means the user opted into following the OS.
 */
export function readThemeCookie(cookieHeader: string | undefined | null): ThemePreference | null {
  if (!cookieHeader) return null

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== THEME_COOKIE_NAME) continue
    const value = decodeURIComponent(rest.join('='))
    return isThemePreference(value) ? value : null
  }

  return null
}

/**
 * Inline this in <head> before first paint. Without it the page renders in
 * light and then flips, which is the flash every themed site gets wrong.
 *
 * A cookie rather than localStorage, so the server can read the same value on
 * routes it renders per request. The HTML this script runs in stays theme
 * agnostic and therefore cacheable under a single key.
 *
 * Deliberately a static literal rather than a template built from the
 * constants above. Interpolating values into a string that is then executed
 * as JavaScript is a code-construction sink: harmless while the inputs are
 * hardcoded, an injection point the moment anyone makes the cookie name
 * configurable. The tests assert the literal cannot drift from the constants.
 */
export const THEME_INIT_SCRIPT =
  '(function(){try{' +
  'var m=document.cookie.match(/(?:^|;\\s*)presslabz-theme=([^;]*)/);' +
  'var t=m&&decodeURIComponent(m[1]);' +
  'if(t==="light"||t==="dark"){' +
  'document.documentElement.setAttribute("data-theme",t)}}catch(e){}})()'
