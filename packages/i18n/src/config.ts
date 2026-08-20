import { DEFAULT_LOCALE, isLocale, LOCALES, type Locale } from './locales.ts'

/**
 * What one installation actually runs.
 *
 * The catalogue in locales.ts is what PressLabz *can* speak; this is what a
 * given site does. They are different questions — an installation may ship
 * three catalogues and serve one language — and both the API and the public
 * site have to answer the second one identically, or the site routes a
 * language the API refuses to write.
 */
export interface LocaleConfig {
  readonly locales: readonly Locale[]
  readonly defaultLocale: Locale
}

export const SUPPORTED_LOCALES_MESSAGE = `SUPPORTED_LOCALES must be a comma-separated subset of: ${LOCALES.join(', ')}`

/**
 * Refuses an unknown tag rather than skipping it. A typo in a deployment
 * variable would otherwise silently narrow a site to one language, and the
 * only symptom is content nobody can reach.
 */
export function parseLocaleList(value: string): Locale[] {
  const parts = value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')

  if (parts.length === 0 || !parts.every(isLocale)) throw new Error(SUPPORTED_LOCALES_MESSAGE)

  return [...new Set(parts)]
}

export function isLocaleList(value: string): boolean {
  try {
    parseLocaleList(value)
    return true
  } catch {
    return false
  }
}

/**
 * Resolves both variables together, because neither is valid on its own: a
 * default outside the supported list is a site whose home page is a language
 * it does not serve.
 */
export function resolveLocaleConfig(input: {
  readonly supported?: string | undefined
  readonly default?: string | undefined
}): LocaleConfig {
  const locales = parseLocaleList(input.supported ?? LOCALES.join(','))
  const defaultLocale = input.default ?? DEFAULT_LOCALE

  if (!isLocale(defaultLocale)) throw new Error(`DEFAULT_LOCALE is not a known locale`)
  if (!locales.includes(defaultLocale)) {
    throw new Error('DEFAULT_LOCALE must be listed in SUPPORTED_LOCALES')
  }

  return { locales, defaultLocale }
}
