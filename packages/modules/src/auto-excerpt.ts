import { blocksToPlainText } from '@presslabz/blocks'
import type { CoreHooks } from '@presslabz/core'
import type { Module } from './module.ts'

/** Long enough to say something, short enough to be a summary. */
const DEFAULT_LENGTH = 200

export interface AutoExcerptOptions {
  readonly maxLength?: number
}

/**
 * Gives a document a summary when its author did not write one.
 *
 * The second first-party module, and a filter rather than an action, which
 * makes it the other half of the proof: one feature that is told what
 * happened, one that changes what the system produces.
 *
 * It never overwrites an excerpt somebody wrote. An author's own summary is
 * the one that appears in a search result and in a feed, and a module that
 * quietly replaced it would be editing their work.
 */
export function autoExcerpt(options: AutoExcerptOptions = {}): Module {
  const maxLength = options.maxLength ?? DEFAULT_LENGTH

  return {
    name: 'auto-excerpt',

    register(hooks: CoreHooks) {
      return hooks.filter(
        'content:excerpt',
        (value) => {
          if (value.excerpt.trim() !== '') return value

          const text = blocksToPlainText(value.blocks).replace(/\s+/g, ' ').trim()
          if (text === '') return value

          return { ...value, excerpt: truncate(text, maxLength) }
        },
        { label: 'auto-excerpt' },
      )
    },
  }
}

/**
 * Cuts at a word boundary and marks the cut.
 *
 * Cutting mid-word reads as a rendering fault rather than a summary, and the
 * ellipsis is what tells a reader the sentence continues somewhere.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text

  const cut = text.slice(0, maxLength)
  const lastSpace = cut.lastIndexOf(' ')

  return `${(lastSpace > maxLength / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`
}
