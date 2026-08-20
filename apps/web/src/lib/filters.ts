import { type Blocks, blocksSchema } from '@presslabz/blocks'
import type { ContentEvent, CoreHooks } from '@presslabz/core'

/**
 * Running a filter chain over a document, and refusing to render what comes
 * back if it is no longer a document.
 *
 * A filter is code, and `content:blocks` is the one filter that reaches the
 * page. The whitelist renderer is what makes stored content safe to render, so
 * anything a filter produces has to pass the same schema the editor's output
 * does — otherwise an extension becomes a way to put a block type the renderer
 * has never seen in front of a reader.
 *
 * When it fails, the original blocks are rendered. A broken extension costs
 * its own feature, never the document.
 */
export async function filterBlocks(
  hooks: CoreHooks,
  blocks: Blocks,
  content: ContentEvent,
  onFailure: (error: unknown) => void = () => {},
): Promise<Blocks> {
  const result = await hooks.apply(
    'content:blocks',
    { blocks, content },
    { locale: content.locale },
  )
  if (result.blocks === blocks) return blocks

  const parsed = blocksSchema.safeParse(result.blocks)
  if (parsed.success) return parsed.data

  onFailure(parsed.error)
  return blocks
}

export async function filterExcerpt(
  hooks: CoreHooks,
  excerpt: string | null,
  blocks: Blocks,
  content: ContentEvent,
): Promise<string | null> {
  const result = await hooks.apply(
    'content:excerpt',
    { excerpt: excerpt ?? '', blocks, content },
    { locale: content.locale },
  )

  return result.excerpt === '' ? null : result.excerpt
}
