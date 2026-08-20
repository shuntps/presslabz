import { randomUUID } from 'node:crypto'
import type { Block, InlineContent } from '@presslabz/blocks'

/**
 * The little that both seeds need to write a document.
 *
 * Blocks are built the way the editor builds them — an id on every block, a
 * type on every inline node — rather than through a shorthand that would only
 * be correct here. A fixture the editor could not have produced is a fixture
 * that finds bugs nobody has.
 */

export function text(value: string): InlineContent {
  return [{ type: 'text', text: value }]
}

export function paragraph(value: string): Block {
  return { id: randomUUID(), type: 'paragraph', content: text(value) }
}

export function heading(value: string, level: 2 | 3 = 2): Block {
  return { id: randomUUID(), type: 'heading', level, content: text(value) }
}
