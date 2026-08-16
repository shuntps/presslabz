import { z } from 'zod'
import { inlineContentSchema } from './inline.ts'

/**
 * The block vocabulary. `contents.blocks` is an array of these and nothing
 * else — a document that cannot be expressed here cannot be stored, which is
 * the point. Adding a block type is a schema change plus a renderer, never a
 * string of HTML smuggled through an existing one.
 *
 * Every block carries an id. The editor needs a stable key across reorders,
 * a revision diff needs to say which block changed rather than which index,
 * and phase 4's cache tags will want to name one.
 */
const identified = {
  id: z.uuid(),
}

export const paragraphBlockSchema = z.object({
  ...identified,
  type: z.literal('paragraph'),
  content: inlineContentSchema,
})

export const headingBlockSchema = z.object({
  ...identified,
  type: z.literal('heading'),
  /**
   * h1 is the document title, which is a column rather than a block, so a
   * heading block starts at h2. Letting an author emit a second h1 breaks the
   * document outline for every screen reader that relies on it.
   */
  level: z.literal([2, 3, 4]),
  content: inlineContentSchema,
})

export const quoteBlockSchema = z.object({
  ...identified,
  type: z.literal('quote'),
  content: inlineContentSchema,
  attribution: z.string().max(200).optional(),
})

export const listBlockSchema = z.object({
  ...identified,
  type: z.literal('list'),
  ordered: z.boolean(),
  items: z.array(inlineContentSchema).min(1).max(500),
})

export const codeBlockSchema = z.object({
  ...identified,
  type: z.literal('code'),
  /** A hint for the highlighter. Never executed, never trusted as a class. */
  language: z.string().max(30).optional(),
  code: z.string(),
})

export const imageBlockSchema = z.object({
  ...identified,
  type: z.literal('image'),
  /**
   * A reference, not a URL. The media row owns the storage key and the
   * per-locale alt text, so moving a file or fixing its alt does not mean
   * rewriting every document that uses it.
   */
  mediaId: z.uuid(),
  /** Caption belongs to this use of the image, so it lives on the block. */
  caption: inlineContentSchema.optional(),
})

export const dividerBlockSchema = z.object({
  ...identified,
  type: z.literal('divider'),
})

export const blockSchema = z.discriminatedUnion('type', [
  paragraphBlockSchema,
  headingBlockSchema,
  quoteBlockSchema,
  listBlockSchema,
  codeBlockSchema,
  imageBlockSchema,
  dividerBlockSchema,
])

export type Block = z.infer<typeof blockSchema>
export type BlockType = Block['type']

export const blocksSchema = z.array(blockSchema)

export type Blocks = z.infer<typeof blocksSchema>

/**
 * The registry the editor's block palette reads, so adding a block type shows
 * up in the interface without a second list to keep in step.
 */
export const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'quote',
  'list',
  'code',
  'image',
  'divider',
] as const satisfies readonly BlockType[]

export function isBlockType(value: unknown): value is BlockType {
  return typeof value === 'string' && (BLOCK_TYPES as readonly string[]).includes(value)
}
