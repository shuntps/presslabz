import { type Blocks, blockSchema, mediaReferencesInBlocks } from '@presslabz/blocks'
import { describe, expect, it } from 'vitest'
import { BUILTIN_CONTENT_TYPES } from './content-types.builtin.ts'
import { mediaReferencesOf } from './content-types.ts'

/**
 * Every shape that can name an asset says whether it does.
 *
 * The exhaustiveness itself is the type checker's: a block type absent from
 * the extractor's record does not compile, and a content type without
 * `mediaIn` does not either. What is left for a test is that the declarations
 * exist for everything currently registered, and that the ones which do
 * declare a reference actually produce it — a record entry returning `[]` by
 * accident would compile perfectly.
 */

const MEDIA = '11111111-1111-4111-8111-111111111111'

describe('what a block declares about media', () => {
  const types = blockSchema.options.map((option) => option.shape.type.value as string)

  it('covers every block type in the vocabulary', () => {
    // If this ever needs editing, a block type was added: the record in
    // packages/blocks/src/media.ts will have refused to compile first.
    expect(types.sort()).toEqual(
      ['code', 'divider', 'heading', 'image', 'list', 'paragraph', 'quote'].sort(),
    )
  })

  it('finds the reference an image block carries', () => {
    const blocks = [{ id: 'b1', type: 'image', mediaId: MEDIA }] as unknown as Blocks

    expect(mediaReferencesInBlocks(blocks)).toEqual([{ mediaId: MEDIA, blockId: 'b1' }])
  })

  it('finds none in the blocks that carry none', () => {
    const blocks = [
      { id: 'b1', type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      { id: 'b2', type: 'divider' },
      { id: 'b3', type: 'code', language: 'ts', code: 'const a = 1' },
    ] as unknown as Blocks

    expect(mediaReferencesInBlocks(blocks)).toEqual([])
  })
})

describe('what a content type declares about media', () => {
  it.for(BUILTIN_CONTENT_TYPES.map((type) => [type.name, type] as const))(
    '%s declares an extractor that answers for an empty document',
    ([, type]) => {
      expect(typeof type.mediaIn).toBe('function')
      expect(mediaReferencesOf(type, { blocks: [], meta: {} })).toEqual([])
    },
  )

  it('finds a featured image through the declaration, not through a key name', () => {
    const post = BUILTIN_CONTENT_TYPES.find((type) => type.name === 'post')

    expect(
      mediaReferencesOf(post as (typeof BUILTIN_CONTENT_TYPES)[number], {
        blocks: [],
        meta: { featuredMediaId: MEDIA },
      }),
    ).toEqual([{ mediaId: MEDIA, source: 'meta', at: 'featuredMediaId' }])
  })

  /* Sorted, because the order references are written in is the order row
   * locks are taken in. */
  it('returns them in a stable order whatever order they were found in', () => {
    const post = BUILTIN_CONTENT_TYPES.find(
      (type) => type.name === 'post',
    ) as (typeof BUILTIN_CONTENT_TYPES)[number]
    const later = '99999999-9999-4999-8999-999999999999'

    const references = mediaReferencesOf(post, {
      blocks: [{ id: 'b1', type: 'image', mediaId: later }] as unknown as Blocks,
      meta: { featuredMediaId: MEDIA },
    })

    expect(references.map((reference) => reference.mediaId)).toEqual([MEDIA, later])
  })
})
