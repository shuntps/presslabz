import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { BREAKPOINTS } from '@presslabz/tokens/breakpoints'
import { colourSchemeProblems } from '@presslabz/tokens/testing'
import { describe, expect, it } from 'vitest'

/**
 * The rules a theme has to keep, asserted rather than left as a comment.
 *
 * All three are the kind that hold right up until somebody in a hurry writes
 * one literal — and a theme is exactly where that happens, because it is the
 * file somebody opens to change how one heading looks. They are checked here
 * so that the first third-party theme has an example of what it is agreeing
 * to, not only a paragraph telling it.
 */
const ROOT = new URL('.', import.meta.url).pathname

function styleSources(directory: string): { file: string; css: string }[] {
  const found: { file: string; css: string }[] = []

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)

    if (entry.isDirectory()) {
      found.push(...styleSources(path))
      continue
    }

    if (entry.name.endsWith('.css')) {
      found.push({ file: path, css: readFileSync(path, 'utf8') })
      continue
    }

    if (entry.name.endsWith('.astro')) {
      const source = readFileSync(path, 'utf8')
      for (const [, css] of source.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
        found.push({ file: path, css: css as string })
      }
    }
  }

  return found
}

const sources = styleSources(ROOT)
const withoutComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')

describe('the default theme stylesheets', () => {
  it('has styles to check at all', () => {
    // Otherwise every assertion below passes by finding nothing.
    expect(sources.length).toBeGreaterThan(5)
  })

  it('states no colour of its own', () => {
    for (const { file, css } of sources) {
      // A literal would keep its value in the other colour scheme, which is
      // how a theme ends up dark except for the one thing somebody hardcoded.
      expect(withoutComments(css), file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/)
      expect(withoutComments(css), file).not.toMatch(/\b(?:rgba?|hsla?|oklch)\(/)
    }
  })

  it('breaks only at declared breakpoints', () => {
    const declared = new Set<string>(Object.values(BREAKPOINTS))

    for (const { file, css } of sources) {
      for (const [, prelude] of css.matchAll(/@media([^{]+)\{/g)) {
        for (const [, width] of (prelude as string).matchAll(/min-width:\s*([^)]+)\)/g)) {
          expect(declared, `undeclared breakpoint ${width} in ${file}`).toContain(
            (width as string).trim(),
          )
        }
      }
    }
  })

  it('stays mobile-first', () => {
    for (const { file, css } of sources) {
      for (const [, prelude] of css.matchAll(/@media([^{]+)\{/g)) {
        // Mixing the two directions produces rules that contradict each other
        // at the boundary. Every rule outside a query is correct at 320px.
        expect(prelude as string, file).not.toContain('max-width')
      }
    }
  })

  /*
   * Checked by the same function that checks the core palette, rather than by
   * a second reading of the same paragraph. A theme that overrides a colour in
   * one scheme only is the failure this catches, and it is invisible to
   * whoever was not reading in that scheme.
   */
  it('overrides colours in both directions or not at all', () => {
    const overrides = readFileSync(join(ROOT, 'tokens.css'), 'utf8')
    expect(colourSchemeProblems(overrides)).toEqual([])
  })
})
