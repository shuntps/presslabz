import type { Block, Blocks } from './blocks.ts'
import { type InlineContent, isSafeHref, type Mark } from './inline.ts'

/**
 * The whitelist renderer.
 *
 * It emits a fixed set of tags with a fixed set of attributes and escapes
 * everything else. There is no path from stored content to markup that is not
 * written out below, so a document is safe to render because of what this
 * function can produce rather than because of what was sanitized on the way in.
 *
 * Themes render blocks as their own components in phase 3; this stays the
 * reference implementation and the one used wherever a string of HTML is what
 * is actually wanted — previews, feeds, notification bodies.
 */

/** Resolved by the caller: this package never reaches for the database. */
export interface ResolvedMedia {
  src: string
  alt: string
  width?: number
  height?: number
}

export interface RenderOptions {
  /**
   * Returning undefined drops the image block. Rendering a broken reference
   * would be worse: a reader sees a missing-image icon and an author sees
   * nothing wrong in the editor, where the block still resolves.
   */
  resolveMedia?: (mediaId: string) => ResolvedMedia | undefined
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** One escape for text and attributes both, so neither can be got wrong. */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] as string)
}

/**
 * A highlighter hint, not a class the author controls. Anything outside this
 * shape is dropped rather than escaped, because there is no legitimate
 * language name it would exclude.
 */
const LANGUAGE_PATTERN = /^[a-z0-9][a-z0-9+#._-]{0,29}$/

function wrapMark(mark: Mark, html: string): string {
  switch (mark.type) {
    case 'bold':
      return `<strong>${html}</strong>`
    case 'italic':
      return `<em>${html}</em>`
    case 'strike':
      return `<s>${html}</s>`
    case 'code':
      return `<code>${html}</code>`
    case 'link': {
      /*
       * Checked again here even though the schema already refused an unsafe
       * href. Rows written before a schema change are the case that matters,
       * and a renderer that trusts its input is one migration away from being
       * the hole. Dropping the mark keeps the words and loses the link.
       */
      if (!isSafeHref(mark.href)) return html
      const target = mark.newTab ? ' target="_blank" rel="noopener noreferrer"' : ''
      return `<a href="${escapeHtml(mark.href)}"${target}>${html}</a>`
    }
  }
}

export function renderInline(content: InlineContent): string {
  return content
    .map((node) => {
      // Applied inside out, so the first mark in the array is the outermost
      // tag and the same content always produces the same markup.
      let html = escapeHtml(node.text)
      for (const mark of [...(node.marks ?? [])].reverse()) html = wrapMark(mark, html)
      return html
    })
    .join('')
}

function renderBlock(block: Block, options: RenderOptions): string {
  switch (block.type) {
    case 'paragraph':
      return `<p>${renderInline(block.content)}</p>`

    case 'heading':
      return `<h${block.level}>${renderInline(block.content)}</h${block.level}>`

    case 'quote': {
      const quote = `<blockquote><p>${renderInline(block.content)}</p></blockquote>`
      if (!block.attribution) return quote
      return `<figure>${quote}<figcaption>${escapeHtml(block.attribution)}</figcaption></figure>`
    }

    case 'list': {
      const tag = block.ordered ? 'ol' : 'ul'
      const items = block.items.map((item) => `<li>${renderInline(item)}</li>`).join('')
      return `<${tag}>${items}</${tag}>`
    }

    case 'code': {
      const language =
        block.language && LANGUAGE_PATTERN.test(block.language) ? block.language : undefined
      const attribute = language ? ` class="language-${language}"` : ''
      return `<pre><code${attribute}>${escapeHtml(block.code)}</code></pre>`
    }

    case 'image': {
      const media = options.resolveMedia?.(block.mediaId)
      if (!media) return ''
      const size =
        media.width && media.height ? ` width="${media.width}" height="${media.height}"` : ''
      // loading and decoding are not decoration: an image list without them
      // blocks first paint on content nobody has scrolled to yet.
      const img =
        `<img src="${escapeHtml(media.src)}" alt="${escapeHtml(media.alt)}"${size}` +
        ` loading="lazy" decoding="async" />`
      if (!block.caption) return `<figure>${img}</figure>`
      return `<figure>${img}<figcaption>${renderInline(block.caption)}</figcaption></figure>`
    }

    case 'divider':
      return '<hr />'
  }
}

export function renderBlocksToHtml(blocks: Blocks, options: RenderOptions = {}): string {
  return blocks.map((block) => renderBlock(block, options)).join('')
}

/**
 * Everything a human would read, with no markup.
 *
 * The automatic excerpt is generated from this, and the search index will read
 * it when there is one — the tsvector column exists, nothing queries it yet.
 * Either way it must not silently skip a block type: a paragraph missing from
 * an excerpt is a summary that misrepresents the document, and one missing
 * from an index is a document nobody can find.
 */
export function blocksToPlainText(blocks: Blocks): string {
  const parts: string[] = []

  for (const block of blocks) {
    switch (block.type) {
      case 'paragraph':
      case 'heading':
        parts.push(inlineToPlainText(block.content))
        break
      case 'quote':
        parts.push(inlineToPlainText(block.content))
        if (block.attribution) parts.push(block.attribution)
        break
      case 'list':
        for (const item of block.items) parts.push(inlineToPlainText(item))
        break
      case 'code':
        parts.push(block.code)
        break
      case 'image':
        if (block.caption) parts.push(inlineToPlainText(block.caption))
        break
      case 'divider':
        break
    }
  }

  return parts.filter((part) => part !== '').join('\n')
}

export function inlineToPlainText(content: InlineContent): string {
  return content.map((node) => node.text).join('')
}
