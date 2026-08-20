import { isLocale, type Locale } from './locales.ts'

/**
 * The interface's language, remembered in the browser.
 *
 * The same shape as the theme's cookie, for the same reason: a preference the
 * page needs before the server can be asked. Without it every load started
 * from `navigator.languages`, and the language somebody had chosen arrived a
 * moment later with the session — a visible flip on every reload, and nothing
 * at all for a visitor who is not signed in.
 *
 * DOM-free, so the API can read it from a Cookie header. The writer lives in
 * ./dom.ts.
 */

export const LOCALE_COOKIE_NAME = 'presslabz-locale'
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/**
 * Null when nothing was chosen, and null when what was written is not a
 * language this build knows — including a value that is not decodable at all.
 * `decodeURIComponent` throws on a malformed escape, and a preference read
 * during start-up must not be able to stop it.
 */
export function readLocaleCookie(cookieHeader: string | undefined | null): Locale | null {
  if (!cookieHeader) return null

  for (const part of cookieHeader.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== LOCALE_COOKIE_NAME) continue

    try {
      const value = decodeURIComponent(rest.join('='))
      return isLocale(value) ? value : null
    } catch {
      return null
    }
  }

  return null
}
