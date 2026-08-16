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

/**
 * Applies a preference to the document. 'system' removes the attribute
 * entirely rather than writing a resolved value, so the page keeps following
 * the OS if the user changes it while the tab is open.
 */
export function applyTheme(preference: ThemePreference, root: HTMLElement): void {
  if (preference === 'system') {
    root.removeAttribute(THEME_ATTRIBUTE)
  } else {
    root.setAttribute(THEME_ATTRIBUTE, preference)
  }
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
 * Deliberately not httpOnly: the pre-paint script has to read it. This is a
 * display preference, never a credential, so script access costs nothing.
 */
export function writeThemeCookie(preference: ThemePreference, doc: Document): void {
  const secure = doc.location?.protocol === 'https:' ? '; Secure' : ''
  doc.cookie =
    `${THEME_COOKIE_NAME}=${encodeURIComponent(preference)}` +
    `; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
}

/** Persist and apply together, so a caller cannot do one and forget the other. */
export function setThemePreference(preference: ThemePreference, doc: Document): void {
  writeThemeCookie(preference, doc)
  applyTheme(preference, doc.documentElement)
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
