/**
 * Adding a locale is adding an entry here plus a message catalogue. No schema
 * change is involved: `locale` is a text column, not an enum, precisely so
 * that a new language never requires a migration.
 */
export const LOCALES = ['en', 'fr'] as const
export type Locale = (typeof LOCALES)[number]

export const DEFAULT_LOCALE: Locale = 'en'

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  fr: 'Français',
}

/** BCP 47 tags, for `lang` attributes and Intl formatting. */
export const LOCALE_TAGS: Record<Locale, string> = {
  en: 'en',
  fr: 'fr',
}

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value)
}

/**
 * Picks the best supported locale from an Accept-Language header, falling
 * back to the default. Quality values are honoured; unknown tags are skipped
 * rather than treated as errors.
 */
export function negotiateLocale(acceptLanguage: string | undefined | null): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE

  const ranked = acceptLanguage
    .split(',')
    .map((part) => {
      const [tag = '', ...params] = part.trim().split(';')
      const q = params.find((p) => p.trim().startsWith('q='))
      const quality = q ? Number.parseFloat(q.trim().slice(2)) : 1
      return { tag: tag.trim().toLowerCase(), quality: Number.isNaN(quality) ? 0 : quality }
    })
    .filter((entry) => entry.tag.length > 0 && entry.quality > 0)
    .sort((a, b) => b.quality - a.quality)

  for (const { tag } of ranked) {
    if (isLocale(tag)) return tag
    // 'fr-CA' should match 'fr'.
    const base = tag.split('-')[0]
    if (isLocale(base)) return base
  }

  return DEFAULT_LOCALE
}
