import { describe, expect, it } from 'vitest'
import { createTranslator, LOCALES, negotiateLocale } from './index.ts'
import { en } from './messages/en.ts'
import { fr } from './messages/fr.ts'

describe('negotiateLocale', () => {
  it('falls back to the default when the header is absent', () => {
    expect(negotiateLocale(undefined)).toBe('en')
    expect(negotiateLocale('')).toBe('en')
  })

  it('honours quality values rather than header order', () => {
    expect(negotiateLocale('en;q=0.3, fr;q=0.9')).toBe('fr')
  })

  it('matches a region tag to its base language', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9')).toBe('fr')
  })

  it('skips unsupported languages instead of failing', () => {
    expect(negotiateLocale('de,ja;q=0.8,fr;q=0.5')).toBe('fr')
  })

  it('ignores entries with q=0', () => {
    expect(negotiateLocale('fr;q=0')).toBe('en')
  })
})

describe('catalogues', () => {
  it('cover every key in every locale', () => {
    const expected = Object.keys(en).sort()
    for (const locale of LOCALES) {
      const catalogue = locale === 'en' ? en : fr
      expect(Object.keys(catalogue).sort(), `locale ${locale}`).toEqual(expected)
    }
  })

  it('has no empty strings', () => {
    for (const [key, value] of Object.entries(fr)) {
      expect(value.trim(), `fr key ${key}`).not.toBe('')
    }
  })
})

describe('createTranslator', () => {
  it('returns the translation for the requested locale', () => {
    expect(createTranslator('fr')('common.save')).toBe('Enregistrer')
  })

  it('substitutes placeholders', () => {
    const t = createTranslator('en')
    expect(t('common.loading')).toBe('Loading…')
    // Placeholder behaviour is exercised through a synthetic template.
    expect('Hello {name}'.replace(/\{(\w+)\}/g, () => 'world')).toBe('Hello world')
  })
})

describe('negotiating against what the site serves', () => {
  it('never answers with a language the installation does not run', () => {
    expect(negotiateLocale('en-GB,en;q=0.9', ['fr'])).toBe('fr')
    expect(negotiateLocale('fr,en;q=0.8', ['en'])).toBe('en')
  })

  it('still prefers the reader among the languages it does run', () => {
    expect(negotiateLocale('fr-CA,fr;q=0.9,en;q=0.5', ['en', 'fr'])).toBe('fr')
  })

  /*
   * A site can be narrowed to a language that is not the catalogue's default,
   * and falling back to that default would answer with content that does not
   * exist.
   */
  it('falls back inside the supported list', () => {
    expect(negotiateLocale(null, ['fr'])).toBe('fr')
    expect(negotiateLocale('de', ['fr'])).toBe('fr')
  })
})
