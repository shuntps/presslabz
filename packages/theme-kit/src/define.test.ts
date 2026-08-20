import type { Block } from '@presslabz/blocks'
import { describe, expect, it } from 'vitest'
import { blockComponentFor, defineTheme } from './define.ts'

/** Stands in for a compiled .astro component, which is a function. */
const component = () => undefined
const templates = {
  home: component,
  archive: component,
  document: component,
  notFound: component,
} as never

describe('defineTheme', () => {
  it('declares a theme with every template it needs', () => {
    const theme = defineTheme({ name: 'default', templates })

    expect(theme.name).toBe('default')
    expect(Object.keys(theme.templates).sort()).toEqual(['archive', 'document', 'home', 'notFound'])
  })

  /*
   * A missing template has no symptom until somebody reaches the one page that
   * needed it. Refusing at import turns "the 404 page is blank" into "the
   * server does not start".
   */
  it('refuses a theme that could not render every page', () => {
    for (const missing of ['home', 'archive', 'document', 'notFound'] as const) {
      const partial = { ...(templates as Record<string, unknown>) }
      delete partial[missing]

      expect(() => defineTheme({ name: 'default', templates: partial as never })).toThrow(
        new RegExp(`missing its ${missing} template`),
      )
    }
  })

  it('refuses a name that could not identify a package', () => {
    expect(() => defineTheme({ name: 'My Theme', templates })).toThrow(/must match/)
    expect(() => defineTheme({ name: '', templates })).toThrow(/must match/)
  })

  it('leaves block components optional, and empty by default', () => {
    expect(defineTheme({ name: 'default', templates }).blocks).toEqual({})
  })

  /*
   * Frozen because a theme is read on every request and shared by all of them.
   * A plugin mutating another theme's template map at runtime is exactly the
   * ambient authority this project exists to remove.
   */
  it('cannot be modified after it is declared', () => {
    const theme = defineTheme({ name: 'default', templates })

    expect(Object.isFrozen(theme)).toBe(true)
    expect(Object.isFrozen(theme.templates)).toBe(true)
    expect(Object.isFrozen(theme.blocks)).toBe(true)
  })
})

describe('blockComponentFor', () => {
  const paragraph: Block = {
    id: '00000000-0000-4000-8000-000000000000',
    type: 'paragraph',
    content: [{ type: 'text', text: 'Hello' }],
  }

  it('uses the theme component when the theme covers that type', () => {
    expect(blockComponentFor({ paragraph: component as never }, paragraph)).toBe(component)
  })

  /*
   * The fallback is what lets a theme be incomplete without a document coming
   * out blank — and what keeps the whitelist renderer the only thing deciding
   * what a block may emit.
   */
  it('answers nothing for a type the theme leaves out', () => {
    expect(blockComponentFor({ heading: component as never }, paragraph)).toBeNull()
    expect(blockComponentFor({}, paragraph)).toBeNull()
    expect(blockComponentFor(undefined, paragraph)).toBeNull()
  })
})
