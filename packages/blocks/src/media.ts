import type { Block, Blocks } from './blocks.ts'

/**
 * Which assets a document's body names, and where.
 *
 * One definition. Three places already knew that an image block carries
 * `mediaId` — the renderer, the public site's resolver, and a containment
 * query written by hand against the JSONB — and a fourth was about to be added
 * for the relational mirror. Four expressions of one fact drift, and the way
 * they drift is that a new media-bearing block is taught to three of them.
 *
 * `blockId` travels with the reference so a refusal can say *which* block
 * names a missing asset. A message that says "one of your images is gone" is
 * advice to go looking.
 */
export interface BlockMediaReference {
  readonly mediaId: string
  readonly blockId: string
}

/**
 * Every block type states whether it names an asset, and the type checker
 * insists.
 *
 * A record keyed by the union rather than a `switch` with a default: adding a
 * block type to the vocabulary and forgetting this file is a compile error,
 * not a silent absence. No test can infer that a new uuid field is a media
 * reference rather than an ordinary identifier — only the person adding it
 * knows, and this is where they say so.
 */
const BLOCK_MEDIA: {
  [K in Block['type']]: (block: Extract<Block, { type: K }>) => readonly BlockMediaReference[]
} = {
  paragraph: () => [],
  heading: () => [],
  quote: () => [],
  list: () => [],
  code: () => [],
  divider: () => [],
  image: (block) => [{ mediaId: block.mediaId, blockId: block.id }],
}

export function mediaReferencesInBlocks(blocks: Blocks): readonly BlockMediaReference[] {
  const found: BlockMediaReference[] = []

  for (const block of blocks) {
    // The record is keyed by the discriminant, so this is the block's own
    // extractor; the cast is the one TypeScript cannot make for us across a
    // mapped type indexed by a union.
    const extract = BLOCK_MEDIA[block.type] as (value: Block) => readonly BlockMediaReference[]
    found.push(...extract(block))
  }

  return found
}

/** The ids alone, deduplicated — what a resolver needs and nothing more. */
export function mediaIdsInBlocks(blocks: Blocks): string[] {
  return [...new Set(mediaReferencesInBlocks(blocks).map((reference) => reference.mediaId))]
}
