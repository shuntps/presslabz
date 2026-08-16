export const THEME_PREFERENCES = ['light', 'dark', 'system'] as const
export type ThemePreference = (typeof THEME_PREFERENCES)[number]

/** What actually gets painted, once 'system' has been resolved. */
export type ResolvedTheme = 'light' | 'dark'

export const THEME_STORAGE_KEY = 'presslabz-theme'
export const THEME_ATTRIBUTE = 'data-theme'

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
 * Inline this in <head> before first paint. Without it the page renders in
 * light and then flips, which is the flash every themed site gets wrong.
 */
export const THEME_INIT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t==='light'||t==='dark'){document.documentElement.setAttribute(${JSON.stringify(
  THEME_ATTRIBUTE,
)},t)}}catch(e){}})()`
