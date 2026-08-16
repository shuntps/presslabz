import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { above, BREAKPOINTS, type Breakpoint } from './breakpoints.ts'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

/** The preludes of every `@media` rule, `@container` excluded. */
const mediaPreludes = [...css.matchAll(/@media([^{]+)\{/g)].map((match) => match[1] as string)

/**
 * The declarations of the rule whose selector is exactly `selector`. Anchored
 * to the start of a line so a mention inside a comment cannot match, and
 * brace-free so it stops at the rule rather than running into the next one.
 */
function blockFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`^[ \\t]*${escaped}\\s*\\{([^{}]*)\\}`, 'm'))
  if (!match) throw new Error(`no rule found for "${selector}"`)
  return match[1] as string
}

function customPropertiesIn(source: string): Set<string> {
  return new Set([...source.matchAll(/^\s*(--pl-[\w-]+)\s*:/gm)].map((match) => match[1] as string))
}

describe('BREAKPOINTS', () => {
  it('is ordered, so a mobile-first cascade reads top to bottom', () => {
    const widths = Object.values(BREAKPOINTS).map((value) => Number.parseFloat(value))
    expect(widths).toEqual([...widths].sort((a, b) => a - b))
  })

  it('is expressed in rem, so a raised browser font size moves the layout too', () => {
    for (const value of Object.values(BREAKPOINTS)) {
      expect(value).toMatch(/^\d+(\.\d+)?rem$/)
    }
  })

  it('builds a condition matchMedia accepts', () => {
    expect(above('md')).toBe(`(min-width: ${BREAKPOINTS.md})`)
  })
})

describe('tokens.css breakpoints', () => {
  it('uses no width that is not a declared breakpoint', () => {
    const declared = new Set<string>(Object.values(BREAKPOINTS))
    const used = mediaPreludes.flatMap((prelude) => [
      ...prelude.matchAll(/min-width:\s*([^)]+)\)/g),
    ])

    for (const [, width] of used) {
      expect(declared, `undeclared breakpoint ${width}`).toContain((width as string).trim())
    }
  })

  it('has no max-width query', () => {
    // Mobile-first is the whole convention. A max-width query means two rules
    // arguing over the same pixel, and the loser is usually the small screen.
    for (const prelude of mediaPreludes) {
      expect(prelude).not.toContain('max-width')
    }
  })
})

describe('tokens.css defaults', () => {
  /**
   * The file's own rule: nothing may exist only inside a media query, or the
   * state that query does not match loses the value entirely. It is written
   * for colours and applies just as much to the pointer, contrast and motion
   * blocks — this asserts it for all of them at once.
   */
  it('defines every token on bare :root before any media block adjusts it', () => {
    const root = customPropertiesIn(blockFor(':root'))

    for (const property of customPropertiesIn(css)) {
      expect(root, `${property} has no default on :root`).toContain(property)
    }
  })

  /**
   * Dark is reachable two ways — the OS preference and an explicit toggle —
   * and they are written out separately because CSS gives no way to share
   * them. Nothing but this stops the two from drifting apart, and the drift
   * is invisible until someone toggles the theme on a dark machine.
   */
  it('gives the dark toggle and the dark OS preference the same tokens', () => {
    const byPreference = customPropertiesIn(blockFor(':root:not([data-theme="light"])'))
    const byToggle = customPropertiesIn(blockFor(':root[data-theme="dark"]'))

    expect([...byToggle].sort()).toEqual([...byPreference].sort())
  })

  /**
   * A bare :root weighs (0,1,0) and loses to both dark rules, which weigh
   * (0,2,0). An adaptive block written that way works in light and silently
   * stops working in dark. :root:root is the same element at (0,2,0).
   */
  it('writes adaptive blocks at a specificity the theme rules cannot outrank', () => {
    const adaptive = css.matchAll(
      /@media \((?:pointer|prefers-contrast|prefers-reduced-motion|forced-colors)[^)]*\)\s*\{\s*([^{]+)\{/g,
    )

    const selectors = [...adaptive].map(([, selector]) =>
      (selector as string).replace(/\s+/g, ' ').trim(),
    )

    expect(selectors.length).toBeGreaterThan(0)
    for (const selector of selectors) {
      expect(selector).toBe(':root:root')
    }
  })
})

describe('above', () => {
  it('accepts every declared breakpoint', () => {
    for (const name of Object.keys(BREAKPOINTS) as Breakpoint[]) {
      expect(above(name)).toContain(BREAKPOINTS[name])
    }
  })
})
