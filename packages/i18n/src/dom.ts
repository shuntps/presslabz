import { LOCALE_COOKIE_MAX_AGE, LOCALE_COOKIE_NAME } from './cookie.ts'
import { LOCALE_TAGS, type Locale } from './locales.ts'

/**
 * Writing the language down, and telling the document about it.
 *
 * Separate from cookie.ts because that file is read by the API, which has no
 * `Document`. Persisting and applying happen in one call so a caller cannot do
 * one and forget the other — the failure that shape prevents is a `lang`
 * attribute that disagrees with the interface, which decides how a screen
 * reader pronounces it.
 */

/** Not httpOnly: it is a display preference, never a credential. */
export function writeLocaleCookie(locale: Locale, doc: Document): void {
  const secure = doc.location?.protocol === 'https:' ? '; Secure' : ''
  doc.cookie =
    `${LOCALE_COOKIE_NAME}=${encodeURIComponent(locale)}` +
    `; Path=/; Max-Age=${LOCALE_COOKIE_MAX_AGE}; SameSite=Lax${secure}`
}

/** What a screen reader uses to decide how to pronounce the page. */
export function applyLocale(locale: Locale, doc: Document): void {
  doc.documentElement.lang = LOCALE_TAGS[locale]
}

export function setLocalePreference(locale: Locale, doc: Document): void {
  writeLocaleCookie(locale, doc)
  applyLocale(locale, doc)
}
