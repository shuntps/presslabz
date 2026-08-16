import { DEFAULT_LOCALE, LOCALE_TAGS, type Locale } from './locales.ts'
import { en, type MessageKey, type Messages } from './messages/en.ts'
import { fr } from './messages/fr.ts'

export * from './locales.ts'
export type { MessageKey, Messages } from './messages/en.ts'

const CATALOGUES: Record<Locale, Messages> = { en, fr }

export type Translator = (key: MessageKey, values?: Record<string, string | number>) => string

/**
 * Substitution uses {name} placeholders. Missing values are left in place
 * rather than rendered as "undefined", so a mistake is visible in review
 * instead of shipping silently.
 */
export function createTranslator(locale: Locale = DEFAULT_LOCALE): Translator {
  const catalogue = CATALOGUES[locale] ?? CATALOGUES[DEFAULT_LOCALE]

  return (key, values) => {
    const template = catalogue[key] ?? en[key]
    if (!values) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) =>
      name in values ? String(values[name]) : match,
    )
  }
}

export function formatDate(date: Date, locale: Locale, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(LOCALE_TAGS[locale], options).format(date)
}

export function formatNumber(value: number, locale: Locale, options?: Intl.NumberFormatOptions) {
  return new Intl.NumberFormat(LOCALE_TAGS[locale], options).format(value)
}
