/**
 * The one rule a stylesheet in this project cannot be trusted to keep on its
 * own, checked mechanically.
 *
 * Dark mode is a core feature rather than a theme option, and it rests on a
 * shape that is easy to break one declaration at a time: the complete palette
 * on bare `:root`, and only what changes redefined under the media query and
 * again under `[data-theme]`. Two failures follow from getting it wrong, and
 * neither shows up in the scheme the author happened to be looking at.
 *
 * A colour defined *only* inside a scheme block does not exist in the other
 * one, so a page in that scheme falls back to whatever the property inherited
 * — usually black on black. And a colour redefined under the media query but
 * not under `[data-theme="dark"]` ignores an explicit choice: the reader who
 * asked for dark on a light system gets the light value back.
 *
 * Exported for tests, from the package that owns theming, so the core tokens
 * and every theme's overrides are held to one implementation of the rule
 * rather than to one paragraph of prose each.
 */

/**
 * Comments can hold anything, including a brace or a selector, so they go
 * before the scanner runs.
 *
 * Scanned rather than matched with `/\/\*[\s\S]*?\*\//g`. That expression
 * backtracks polynomially on input made of many unterminated comment openings,
 * and this function is exported — the fact that it is only ever handed this
 * project's own stylesheets today is not a property anything enforces
 * tomorrow. Two indexOf calls per comment are linear and need no argument.
 */
export function stripComments(css: string): string {
  let result = ''
  let index = 0

  while (index < css.length) {
    const start = css.indexOf('/*', index)
    if (start === -1) return result + css.slice(index)

    result += css.slice(index, start)

    const end = css.indexOf('*/', start + 2)
    // Unterminated: everything left is inside the comment.
    if (end === -1) return result

    index = end + 2
  }

  return result
}

interface Rule {
  readonly selector: string
  /** The media prelude this rule sits inside, or null at the top level. */
  readonly media: string | null
  readonly body: string
}

/** A small scanner rather than a regex: rules nest, and regexes do not. */
function rules(css: string, media: string | null = null): Rule[] {
  const found: Rule[] = []
  let index = 0

  while (index < css.length) {
    const open = css.indexOf('{', index)
    if (open === -1) break

    /*
     * Everything since the previous rule ended, minus whatever came before the
     * last statement terminator: an `@import` or a stray declaration sits in
     * this span too, and reading it as part of the selector is how `:root`
     * stops being recognised as `:root`.
     */
    const preceding = css.slice(index, open)
    const selector = preceding.slice(preceding.lastIndexOf(';') + 1).trim()
    let depth = 1
    let cursor = open + 1

    while (cursor < css.length && depth > 0) {
      if (css[cursor] === '{') depth += 1
      if (css[cursor] === '}') depth -= 1
      cursor += 1
    }

    const body = css.slice(open + 1, cursor - 1)

    if (selector.startsWith('@media')) {
      found.push(...rules(body, selector))
    } else if (!selector.startsWith('@')) {
      found.push({ selector, media, body })
    }

    index = cursor
  }

  return found
}

function declaredIn(rule: Rule | undefined): Set<string> {
  const declared = new Set<string>()
  if (!rule) return declared

  for (const [, token] of rule.body.matchAll(/(--pl-[a-z0-9-]+)\s*:/g)) {
    declared.add(token as string)
  }

  return declared
}

const COLOUR_TOKEN = /^--pl-(?:color|shadow)-/

export interface SchemeProblem {
  readonly token: string
  readonly problem: string
}

/**
 * Only colour tokens are paired. A measure or a max width is the same number
 * in both schemes, and demanding it be repeated would be a rule nobody
 * believes, which is how a check stops being read.
 */
export function colourSchemeProblems(source: string): SchemeProblem[] {
  const parsed = rules(stripComments(source))

  const base = parsed.find((rule) => rule.media === null && rule.selector === ':root')
  const media = parsed.find((rule) => rule.media?.includes('prefers-color-scheme: dark'))
  const explicit = parsed.find(
    (rule) => rule.media === null && rule.selector.includes('[data-theme="dark"]'),
  )

  const inBase = declaredIn(base)
  const inMedia = declaredIn(media)
  const inExplicit = declaredIn(explicit)

  const problems: SchemeProblem[] = []

  for (const token of new Set([...inMedia, ...inExplicit])) {
    if (!COLOUR_TOKEN.test(token)) continue
    if (!inBase.has(token)) {
      problems.push({ token, problem: 'defined only inside a scheme block, never on :root' })
    }
  }

  for (const token of inMedia) {
    if (!COLOUR_TOKEN.test(token)) continue
    if (!inExplicit.has(token)) {
      problems.push({ token, problem: 'changes with the system but ignores an explicit choice' })
    }
  }

  for (const token of inExplicit) {
    if (!COLOUR_TOKEN.test(token)) continue
    if (!inMedia.has(token)) {
      problems.push({ token, problem: 'answers an explicit choice but not the system preference' })
    }
  }

  return problems
}

/**
 * Contrast, measured rather than eyeballed.
 *
 * `--pl-color-text-faint` was 2.46:1 on the light subtle surface and 3.12:1 on
 * the dark raised one, against a 4.5:1 minimum — and it was not decoration: it
 * coloured the state column, the slugs, the counts and the column headings.
 * Somebody who could not tell "Draft" from "Published" did not have a styling
 * problem.
 *
 * Nothing about a hex value announces its contrast, and the ratio is a
 * function of *pairs*, so a palette edit that looks harmless in one scheme can
 * break three pairs in the other. The arithmetic is short enough to own; the
 * alternative is a browser and a plugin, neither of which runs in a unit test.
 */

/** One text token against one surface token, both resolved to hex. */
export interface ContrastPair {
  readonly scheme: 'light' | 'dark'
  readonly text: string
  readonly surface: string
  readonly ratio: number
}

/** WCAG 2.2 AA, for text below 18.66px bold or 24px regular. */
export const AA_NORMAL_TEXT = 4.5

const HEX = /^#[0-9a-f]{6}$/i

function channel(value: number): number {
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

/** Relative luminance, as WCAG defines it. */
export function luminance(hex: string): number {
  if (!HEX.test(hex)) throw new Error(`Not a six-digit hex colour: ${hex}`)

  const [red, green, blue] = [1, 3, 5].map((at) =>
    channel(Number.parseInt(hex.slice(at, at + 2), 16) / 255),
  )

  return 0.2126 * (red as number) + 0.7152 * (green as number) + 0.0722 * (blue as number)
}

export function contrastRatio(one: string, other: string): number {
  const [brighter, darker] = [luminance(one), luminance(other)].sort((a, b) => b - a)
  return ((brighter as number) + 0.05) / ((darker as number) + 0.05)
}

/** The hex values a rule declares, ignoring tokens defined as var() aliases. */
function hexValues(rule: Rule | undefined): Map<string, string> {
  const values = new Map<string, string>()
  if (!rule) return values

  for (const [, token, value] of rule.body.matchAll(/(--pl-[a-z0-9-]+)\s*:\s*([^;]+);/g)) {
    const trimmed = (value as string).trim()
    if (HEX.test(trimmed)) values.set(token as string, trimmed)
  }

  return values
}

/**
 * Every text token against every surface token, in both schemes.
 *
 * The pairs are enumerated rather than listed, because a palette that gains a
 * surface should not also need somebody to remember to add three rows to a
 * test. `borders` are excluded: a hairline is not text, and holding it to a
 * text ratio is the kind of rule that gets a check switched off.
 */
export function textContrastPairs(source: string): ContrastPair[] {
  const parsed = rules(stripComments(source))

  const base = hexValues(parsed.find((rule) => rule.media === null && rule.selector === ':root'))
  const explicit = hexValues(
    parsed.find((rule) => rule.media === null && rule.selector.includes('[data-theme="dark"]')),
  )

  // Dark declares only what changes, so it starts from the light palette.
  const dark = new Map([...base, ...explicit])

  const pairs: ContrastPair[] = []

  for (const [scheme, palette] of [
    ['light', base],
    ['dark', dark],
  ] as const) {
    for (const [text, textValue] of palette) {
      if (!/^--pl-color-text(-|$)/.test(text)) continue

      for (const [surface, surfaceValue] of palette) {
        if (!/^--pl-color-bg(-|$)/.test(surface)) continue

        pairs.push({
          scheme,
          text,
          surface,
          ratio: contrastRatio(textValue, surfaceValue),
        })
      }
    }
  }

  return pairs
}
