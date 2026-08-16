import { readFileSync } from 'node:fs'
import { BREAKPOINTS } from '@presslabz/tokens/breakpoints'
import { describe, expect, it } from 'vitest'

/**
 * styles.css opens by stating two rules about itself. Both are the kind that
 * hold right up until someone in a hurry writes one literal, so they are
 * asserted here rather than left as a comment nobody re-reads.
 */
const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8')

const mediaPreludes = [...css.matchAll(/@media([^{]+)\{/g)].map((match) => match[1] as string)

describe('admin stylesheet', () => {
  it('states no colour of its own', () => {
    // Anything but a token would keep its value when the theme changes.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
    expect(withoutComments).not.toMatch(/\b(?:rgba?|hsla?|oklch|color-mix)\(/)
  })

  it('breaks only at declared breakpoints', () => {
    const declared = new Set<string>(Object.values(BREAKPOINTS))

    for (const prelude of mediaPreludes) {
      for (const [, width] of prelude.matchAll(/min-width:\s*([^)]+)\)/g)) {
        expect(declared, `undeclared breakpoint ${width}`).toContain((width as string).trim())
      }
    }
  })

  it('stays mobile-first', () => {
    for (const prelude of mediaPreludes) {
      expect(prelude).not.toContain('max-width')
    }
  })

  /**
   * A container query is deliberately exempt from the breakpoint registry.
   * Its threshold is the width at which one component's own box stops working,
   * which is a fact about that component and not about any device — sharing
   * those numbers across components would couple things that have no reason
   * to change together.
   */
  it('sizes components against their container, not the viewport', () => {
    expect(css).toContain('@container')
  })
})
