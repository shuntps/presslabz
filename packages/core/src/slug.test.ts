import { describe, expect, it } from 'vitest'
import { isSlug, slugify } from './slug.ts'

describe('slugify', () => {
  it('folds the diacritics the launch locales are full of', () => {
    // "rle" instead of "role" is the bug this exists to prevent.
    expect(slugify('Rôle')).toBe('role')
    expect(slugify('Capacités')).toBe('capacites')
    expect(slugify('Où êtes-vous ?')).toBe('ou-etes-vous')
  })

  it('turns a real title into something that can sit in a URL', () => {
    expect(slugify('Le futur du CMS n’est pas un thème')).toBe('le-futur-du-cms-n-est-pas-un-theme')
  })

  it('leaves no hyphen at either end', () => {
    expect(slugify('  Hello  world  ')).toBe('hello-world')
    expect(slugify('!!! Hello !!!')).toBe('hello')
  })

  it('does not leave a trailing hyphen when it truncates', () => {
    const slug = slugify(`${'a'.repeat(119)} tail`)
    expect(slug.length).toBeLessThanOrEqual(120)
    expect(slug.endsWith('-')).toBe(false)
    expect(isSlug(slug)).toBe(true)
  })

  it('returns nothing it cannot transliterate, rather than guessing', () => {
    // The caller has to handle this — a title is not always a slug.
    expect(slugify('日本語')).toBe('')
  })

  it('always produces something the schema accepts, or nothing at all', () => {
    const titles = ['Hello World', 'Éditeur de blocs', 'a/b?c=d#e', '   ', '2026 — année 1']
    for (const title of titles) {
      const slug = slugify(title)
      expect(slug === '' || isSlug(slug), `${title} -> ${slug}`).toBe(true)
    }
  })
})

describe('isSlug', () => {
  it('accepts what a URL can carry unescaped', () => {
    expect(isSlug('le-futur-du-cms')).toBe(true)
    expect(isSlug('post2')).toBe(true)
  })

  it('rejects anything that would need escaping or could be mistaken for a path', () => {
    expect(isSlug('Le-Futur')).toBe(false)
    expect(isSlug('le futur')).toBe(false)
    expect(isSlug('le--futur')).toBe(false)
    expect(isSlug('-futur')).toBe(false)
    expect(isSlug('futur-')).toBe(false)
    expect(isSlug('a/b')).toBe(false)
    expect(isSlug('a%2Fb')).toBe(false)
    expect(isSlug('')).toBe(false)
  })
})
