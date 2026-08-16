import {
  THEME_ATTRIBUTE,
  THEME_COOKIE_MAX_AGE,
  THEME_COOKIE_NAME,
  type ThemePreference,
} from './preferences.ts'

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
