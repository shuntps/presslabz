import { describe, expect, it } from 'vitest'
import { isLocaleList, parseLocaleList, resolveLocaleConfig } from './config.ts'

describe('locale configuration', () => {
  it('reads a comma separated list, trimmed and deduplicated', () => {
    expect(parseLocaleList('en, fr ,en')).toEqual(['en', 'fr'])
  })

  /*
   * Skipping the unknown entry would narrow a site to one language over a
   * typo, and the only symptom is content nobody can reach.
   */
  it('refuses an unknown tag rather than dropping it', () => {
    expect(() => parseLocaleList('en,de')).toThrow(/comma-separated subset/)
    expect(isLocaleList('en,de')).toBe(false)
    expect(isLocaleList('en,fr')).toBe(true)
  })

  it('refuses a list that names nothing', () => {
    expect(() => parseLocaleList('')).toThrow(/comma-separated subset/)
    expect(() => parseLocaleList(' , ')).toThrow(/comma-separated subset/)
  })

  it('falls back to every known locale when nothing is configured', () => {
    expect(resolveLocaleConfig({})).toEqual({ locales: ['en', 'fr'], defaultLocale: 'en' })
  })

  it('refuses a default the site does not serve', () => {
    expect(() => resolveLocaleConfig({ supported: 'en', default: 'fr' })).toThrow(
      /must be listed in SUPPORTED_LOCALES/,
    )
    expect(() => resolveLocaleConfig({ default: 'de' })).toThrow(/not a known locale/)
  })

  it('accepts a narrowed installation', () => {
    expect(resolveLocaleConfig({ supported: 'fr', default: 'fr' })).toEqual({
      locales: ['fr'],
      defaultLocale: 'fr',
    })
  })
})
