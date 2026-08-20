import type { Block } from '@presslabz/blocks'
import type { AstroComponentFactory } from 'astro/runtime/server/index.js'
import type { BlockComponents, Theme, ThemeTemplates } from './types.ts'

const TEMPLATES = ['home', 'archive', 'document', 'notFound'] as const

/** Same shape as a content type name: it identifies a package, not a title. */
const THEME_NAME = /^[a-z][a-z0-9-]{0,31}$/

export interface ThemeOptions {
  readonly name: string
  readonly templates: ThemeTemplates
  readonly blocks?: BlockComponents
}

/**
 * Declares a theme, and refuses one that could not render a site.
 *
 * The checks are here rather than at the call site because a missing template
 * has no symptom until somebody navigates to the one page that needed it — a
 * 404 template nobody exercised in development is exactly the one that answers
 * a search engine at three in the morning. Failing at import turns that into a
 * server that will not start.
 */
export function defineTheme(options: ThemeOptions): Theme {
  if (!THEME_NAME.test(options.name)) {
    throw new Error(`Theme name "${options.name}" must match ${THEME_NAME}`)
  }

  for (const template of TEMPLATES) {
    if (typeof options.templates?.[template] !== 'function') {
      throw new Error(`Theme "${options.name}" is missing its ${template} template`)
    }
  }

  return Object.freeze({
    name: options.name,
    templates: Object.freeze({ ...options.templates }),
    blocks: Object.freeze({ ...options.blocks }),
  })
}

/**
 * Which component renders a block, or nothing when the theme does not cover
 * that type.
 *
 * Per block rather than per document, deliberately. A theme that styles quotes
 * and nothing else gets its quotes and the reference rendering for the rest;
 * the alternative — all of a theme's components or none of them — makes the
 * first useful theme a complete one, which is how theme ecosystems end up as
 * seven forks of the same starter.
 *
 * Extracted from Blocks.astro so this rule can be asserted at all: an .astro
 * file needs a renderer to test, and the decision it makes is the part worth
 * proving.
 */
export function blockComponentFor(
  components: BlockComponents | undefined,
  block: Block,
): AstroComponentFactory | null {
  return components?.[block.type] ?? null
}
