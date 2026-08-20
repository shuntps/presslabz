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
