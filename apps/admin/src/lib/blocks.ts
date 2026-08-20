import { BLOCK_TYPES, type Block, type BlockType, type InlineContent } from '@presslabz/blocks'
import type { MessageKey } from '@presslabz/i18n'

/**
 * The block vocabulary as the editor needs it: what each type is called, what
 * the palette offers, and how an empty one is made.
 *
 * It lives beside the editor rather than inside it because of a project
 * convention: a module that exports a component exports nothing else. The
 * plugin's own rule is looser — some simple constants are tolerated, and a
 * module is invalidated when an incompatible export changes — but these four
 * are an object, an array and two functions, rebuilt on every evaluation and
 * so never matchable against their previous values. With them next to
 * `BlockEditor`, every edit printed `Could not Fast Refresh ("BLOCK_LABELS"
 * export is incompatible)` and reloaded the page, losing the draft being
 * typed, which is the one thing an editor must not do.
 */

export const BLOCK_LABELS: Record<BlockType, MessageKey> = {
  paragraph: 'block.paragraph',
  heading: 'block.heading',
  quote: 'block.quote',
  list: 'block.list',
  code: 'block.code',
  image: 'block.image',
  divider: 'block.divider',
}

/**
 * Types that cannot be created empty, because they need something from
 * outside the palette. An image must name a media id, so the palette opens the
 * picker and the block arrives already pointing at something.
 */
const NEEDS_INPUT: readonly BlockType[] = ['image']

/**
 * What the palette offers, derived from the vocabulary rather than listed
 * again.
 *
 * It used to be a hand-written array beside a comment claiming the editor
 * consumed the registry directly. Adding a block type to packages/blocks would
 * have left it out of the palette with nothing failing — the list was still
 * valid, just short. Now a new type appears here on its own, and one that
 * needs input has to be named above to stay out.
 */
export const CREATABLE_BLOCKS = BLOCK_TYPES.filter(
  (type) => !NEEDS_INPUT.includes(type),
) as readonly CreatableBlockType[]

export type CreatableBlockType = Exclude<BlockType, 'image'>

export function imageBlock(mediaId: string): Block {
  return { id: crypto.randomUUID(), type: 'image', mediaId }
}

/**
 * Plain text as inline content, for a field that had none.
 *
 * Editing existing content goes through `replaceInlineText` instead: this one
 * rebuilds the run from scratch, which is exactly what destroyed the marks on
 * imported documents.
 */
export const inlineText = (value: string): InlineContent =>
  value === '' ? [] : [{ type: 'text', text: value }]

/**
 * Sets an optional text field, or removes it when the field is emptied.
 *
 * Spreading `{}` over the block — which is what the editor did — leaves the
 * previous value in place, so a quote's attribution and a code block's
 * language could be written and never taken back.
 */
export function setOptionalText<TBlock extends Block>(
  block: TBlock,
  key: 'attribution' | 'language',
  value: string,
): TBlock {
  const next = { ...block } as Record<string, unknown>

  if (value === '') delete next[key]
  else next[key] = value

  return next as TBlock
}

export function emptyBlock(type: CreatableBlockType): Block {
  const id = crypto.randomUUID()

  switch (type) {
    case 'paragraph':
      return { id, type, content: [] }
    case 'heading':
      return { id, type, level: 2, content: [] }
    case 'quote':
      return { id, type, content: [] }
    case 'list':
      return { id, type, ordered: false, items: [[]] }
    case 'code':
      return { id, type, code: '' }
    case 'divider':
      return { id, type }
  }
}
