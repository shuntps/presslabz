import type { Block, BlockType, InlineContent } from '@presslabz/blocks'
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
 * What the palette offers. Image is here but handled apart from the rest: a
 * block that must name a media id cannot be created empty, so the palette
 * opens the picker and the block arrives already pointing at something.
 */
export const CREATABLE_BLOCKS = [
  'paragraph',
  'heading',
  'quote',
  'list',
  'code',
  'divider',
] as const satisfies readonly BlockType[]

export function imageBlock(mediaId: string): Block {
  return { id: crypto.randomUUID(), type: 'image', mediaId }
}

/**
 * Plain text as inline content. The vocabulary carries marks and the renderer
 * whitelists them, but nothing can produce one yet — that arrives with Tiptap.
 */
export const inlineText = (value: string): InlineContent =>
  value === '' ? [] : [{ type: 'text', text: value }]

export function emptyBlock(type: (typeof CREATABLE_BLOCKS)[number]): Block {
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
