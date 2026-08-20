/**
 * A textarea that grows with its content, so nothing gets its own little
 * scrollbar in the middle of the page.
 *
 * A ref callback rather than an effect: it runs on every render, and the height
 * has to be recomputed when the *value* changes for reasons other than typing —
 * a block moving, a document loading, an undo. Setting `auto` first is what
 * makes it shrink as well as grow; `scrollHeight` of an element already sized
 * to its content is its current height, not the height it wants.
 *
 * It lived twice, in the block editor and beside the document title, which is
 * two copies of a rule that is easy to get subtly wrong in one of them.
 */
export function growWithContent(node: HTMLTextAreaElement | null): void {
  if (!node) return

  node.style.height = 'auto'
  node.style.height = `${node.scrollHeight}px`
}
