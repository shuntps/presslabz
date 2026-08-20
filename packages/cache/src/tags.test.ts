import { describe, expect, it } from 'vitest'
import {
  assertTag,
  contentListTag,
  contentTag,
  isTag,
  mediaTag,
  translationGroupTag,
} from './tags.ts'

const ID = '0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c22'

describe('cache tags', () => {
  it('names each kind of invalidation distinctly', () => {
    expect(contentTag(ID)).toBe(`content:${ID}`)
    expect(contentListTag('post', 'fr')).toBe('list:post:fr')
    expect(translationGroupTag(ID)).toBe(`group:${ID}`)
    expect(mediaTag(ID)).toBe(`media:${ID}`)
  })

  it('refuses a value that would not survive being a key', () => {
    // A type name is a declared identifier, but nothing stops a plugin from
    // registering one with a space or a newline in it, and a tag carrying
    // either would split a key listing into two unreadable halves.
    expect(() => contentListTag('my post', 'en')).toThrow(/usable cache tag/)
    expect(() => contentListTag('post\n', 'en')).toThrow(/usable cache tag/)
    expect(() => assertTag('nonamespace')).toThrow(/usable cache tag/)
    expect(() => assertTag('')).toThrow(/usable cache tag/)
  })

  it('accepts the identifiers the domain actually produces', () => {
    expect(isTag(contentListTag('landing-page', 'pt-BR'))).toBe(true)
    expect(isTag(contentTag(ID))).toBe(true)
  })
})
