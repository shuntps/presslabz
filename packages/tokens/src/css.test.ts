/**
 * @vitest-environment node
 *
 * It reads a file off disk; jsdom would give it an http import.meta.url and
 * nothing to read.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { colourSchemeProblems } from './testing.ts'

const css = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8')

describe('the token stylesheet', () => {
  /*
   * The palette every surface in the project resolves against. A colour that
   * exists in one scheme and not the other is invisible until somebody reads
   * in that scheme, which is exactly when it is too late.
   */
  it('defines every colour in both schemes and on :root', () => {
    expect(colourSchemeProblems(css)).toEqual([])
  })

  it('finds the failure it is meant to find', () => {
    // A colour that only exists in dark: light mode inherits whatever it can.
    const orphan = `
      :root { --pl-color-bg: #fff; }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) { --pl-color-invented: #123; }
      }
      :root[data-theme="dark"] { --pl-color-invented: #123; }
    `
    expect(colourSchemeProblems(orphan)).toEqual([
      {
        token: '--pl-color-invented',
        problem: 'defined only inside a scheme block, never on :root',
      },
    ])

    // A colour that follows the system but ignores an explicit choice.
    const oneDirection = `
      :root { --pl-color-bg: #fff; }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) { --pl-color-bg: #000; }
      }
    `
    expect(colourSchemeProblems(oneDirection)).toEqual([
      {
        token: '--pl-color-bg',
        problem: 'changes with the system but ignores an explicit choice',
      },
    ])
  })

  it('does not ask a dimension to be repeated', () => {
    const measure = `
      :root { --pl-measure: 68ch; --pl-color-bg: #fff; }
      @media (prefers-color-scheme: dark) {
        :root:not([data-theme="light"]) { --pl-color-bg: #000; }
      }
      :root[data-theme="dark"] { --pl-color-bg: #000; }
    `
    expect(colourSchemeProblems(measure)).toEqual([])
  })
})
