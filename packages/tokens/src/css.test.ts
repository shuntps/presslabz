/**
 * @vitest-environment node
 *
 * It reads a file off disk; jsdom would give it an http import.meta.url and
 * nothing to read.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  AA_NORMAL_TEXT,
  colourSchemeProblems,
  contrastRatio,
  stripComments,
  textContrastPairs,
} from './testing.ts'

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

describe('stripComments', () => {
  it('removes a comment and keeps what surrounds it', () => {
    expect(stripComments('a /* gone */ b')).toBe('a  b')
    expect(stripComments('/* first */x/* second */y')).toBe('xy')
  })

  it('keeps a stylesheet with no comments intact', () => {
    expect(stripComments(':root { --pl-color-bg: #fff; }')).toBe(':root { --pl-color-bg: #fff; }')
  })

  /*
   * An unterminated comment swallows the rest of the file, which is what a
   * browser does with it too — and, more to the point, is the input the
   * previous regular expression backtracked on.
   */
  it('treats an unterminated comment as running to the end', () => {
    expect(stripComments('a /* never closed')).toBe('a ')
  })

  it('stays linear on input built to make a regex backtrack', () => {
    const hostile = `${'/*a'.repeat(20_000)}x`
    const started = process.hrtime.bigint()
    stripComments(hostile)
    const millis = Number(process.hrtime.bigint() - started) / 1e6

    expect(millis).toBeLessThan(250)
  })
})

describe('contrast', () => {
  /*
   * Measured, in both schemes, over every text token against every surface
   * token — the pairs are enumerated rather than listed, so a palette that
   * gains a surface is checked against it without anybody remembering to.
   *
   * `--pl-color-text-faint` was 2.46:1 on the light subtle surface, and it was
   * not decoration: it coloured the state column, the slugs and the counts.
   * Somebody who could not tell "Draft" from "Published" did not have a
   * styling problem.
   */
  it('keeps every text colour above AA on every surface it can sit on', () => {
    const failing = textContrastPairs(css)
      .filter((pair) => pair.ratio < AA_NORMAL_TEXT)
      .map((pair) => `${pair.scheme}: ${pair.text} on ${pair.surface} = ${pair.ratio.toFixed(2)}`)

    expect(failing).toEqual([])
  })

  /*
   * Three weights of text, and the point of three is that they read as
   * different. Legible is the floor; distinguishable is the design.
   */
  it('keeps the three text weights apart', () => {
    const pairs = textContrastPairs(css)
    const on = (scheme: string, text: string) =>
      pairs.find(
        (pair) => pair.scheme === scheme && pair.text === text && pair.surface === '--pl-color-bg',
      )?.ratio ?? 0

    for (const scheme of ['light', 'dark']) {
      expect(on(scheme, '--pl-color-text')).toBeGreaterThan(on(scheme, '--pl-color-text-muted'))
      expect(on(scheme, '--pl-color-text-muted')).toBeGreaterThan(
        on(scheme, '--pl-color-text-faint'),
      )
    }
  })

  /** The arithmetic itself, against values whose answers are not in doubt. */
  it('computes the ratios WCAG defines', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // Symmetric: which colour is named first cannot change the answer.
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(contrastRatio('#ffffff', '#767676'), 5)
  })
})
