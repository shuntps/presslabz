import type { Blocks } from './blocks.ts'
import type { InlineContent, InlineNode } from './inline.ts'

/**
 * What editing does to content that already carries marks.
 *
 * The editor writes plain text — the rich editor is not here yet — and until
 * now it rebuilt the whole run as one unmarked node on every keystroke. A
 * document imported with links and emphasis lost all of it the first time
 * somebody fixed a typo, silently, with no way back short of a revision.
 *
 * So an edit is treated as what it is: a splice. The text either side of the
 * change is untouched and keeps its marks; only the part that actually
 * changed is rewritten. That is what any editor does, and it is enough to make
 * the plain-text editor safe on rich content long before there is a rich one.
 */

/** How much of the two strings is identical from the start. */
function commonPrefix(before: string, after: string): number {
  const limit = Math.min(before.length, after.length)
  let index = 0
  while (index < limit && before[index] === after[index]) index += 1
  return index
}

/** How much is identical from the end, without overlapping the prefix. */
function commonSuffix(before: string, after: string, prefix: number): number {
  const limit = Math.min(before.length, after.length) - prefix
  let index = 0
  while (index < limit && before[before.length - 1 - index] === after[after.length - 1 - index]) {
    index += 1
  }
  return index
}

/** The nodes covering a range of the plain text, split at its edges. */
function slice(content: InlineContent, from: number, to: number): InlineNode[] {
  const out: InlineNode[] = []
  let offset = 0

  for (const node of content) {
    const start = offset
    const end = offset + node.text.length
    offset = end

    const cutFrom = Math.max(from, start)
    const cutTo = Math.min(to, end)
    if (cutFrom >= cutTo) continue

    const text = node.text.slice(cutFrom - start, cutTo - start)
    out.push(node.marks ? { ...node, text, marks: node.marks } : { type: 'text', text })
  }

  return out
}

/** Which node covers an offset, for deciding what the new text inherits. */
function nodeAt(content: InlineContent, offset: number): InlineNode | undefined {
  let start = 0

  for (const node of content) {
    const end = start + node.text.length
    if (offset >= start && offset < end) return node
    start = end
  }

  return undefined
}

export function inlineToText(content: InlineContent): string {
  return content.map((node) => node.text).join('')
}

/**
 * The content after a plain-text edit, with every mark outside the change
 * kept.
 *
 * The replaced text inherits marks only when the whole change happened inside
 * one node — fixing a word in a bold sentence keeps it bold, which is what an
 * author means. A change that spans two differently marked runs cannot inherit
 * both, so it inherits neither rather than guessing which; that is the one
 * place a mark is lost, and it is the place where any editor loses it.
 */
export function replaceInlineText(content: InlineContent, next: string): InlineContent {
  const before = inlineToText(content)
  if (before === next) return content
  if (next === '') return []
  if (content.length === 0) return [{ type: 'text', text: next }]

  const prefix = commonPrefix(before, next)
  const suffix = commonSuffix(before, next, prefix)

  const removedFrom = prefix
  const removedTo = before.length - suffix
  const inserted = next.slice(prefix, next.length - suffix)

  const head = slice(content, 0, removedFrom)
  const tail = slice(content, removedTo, before.length)

  const middle: InlineNode[] = []
  if (inserted !== '') {
    /*
     * The node the change started in, when the change stayed inside it. An
     * insertion at a boundary — typing at the very end of a run — looks up the
     * character before it, since that is the run the author was writing in.
     */
    const anchor =
      removedFrom === removedTo
        ? nodeAt(content, Math.max(0, removedFrom - 1))
        : nodeAt(content, removedFrom)

    const spansOneNode =
      anchor !== undefined && nodeAt(content, Math.max(0, removedTo - 1)) === anchor

    middle.push(
      spansOneNode && anchor.marks
        ? { type: 'text', text: inserted, marks: anchor.marks }
        : { type: 'text', text: inserted },
    )
  }

  return merge([...head, ...middle, ...tail])
}

/**
 * Joins adjacent nodes that carry the same marks.
 *
 * Without it every edit leaves the run split at the point it was made, and a
 * paragraph edited fifty times is fifty nodes saying the same thing — larger
 * to store, slower to render, and impossible to read in a diff.
 */
function merge(nodes: readonly InlineNode[]): InlineContent {
  const out: InlineNode[] = []

  for (const node of nodes) {
    if (node.text === '') continue

    const last = out[out.length - 1]
    if (last && sameMarks(last, node)) {
      out[out.length - 1] = { ...last, text: last.text + node.text }
      continue
    }

    out.push(node)
  }

  return out
}

function sameMarks(left: InlineNode, right: InlineNode): boolean {
  const a = left.marks ?? []
  const b = right.marks ?? []
  if (a.length !== b.length) return false

  return a.every((mark, index) => JSON.stringify(mark) === JSON.stringify(b[index]))
}

/**
 * The same blocks, with every id distinct.
 *
 * A document can arrive with repeated ids — from an import, from a copy that
 * duplicated a block wholesale — and the editor addresses blocks by id: it
 * would replace or delete every copy at once. The schema refuses duplicates,
 * so a document holding them could otherwise never be saved again; repairing
 * on the way in is what makes it editable instead of stuck.
 *
 * The first occurrence keeps its id, which means links and comments that
 * pointed at it still do. Later ones are given new ones, deterministically in
 * document order.
 */
export function withUniqueIds(blocks: Blocks, newId: () => string = crypto.randomUUID): Blocks {
  const seen = new Set<string>()

  return blocks.map((block) => {
    if (!seen.has(block.id)) {
      seen.add(block.id)
      return block
    }

    let replacement = newId()
    while (seen.has(replacement)) replacement = newId()
    seen.add(replacement)

    return { ...block, id: replacement }
  })
}
