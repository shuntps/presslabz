import { describe, expect, it } from 'vitest'
import { blocksSchema } from './blocks.ts'
import { inlineToText, replaceInlineText, withUniqueIds } from './editing.ts'
import type { InlineContent } from './inline.ts'

const plain = (text: string): InlineContent => [{ type: 'text', text }]

const bold = (text: string): InlineContent => [{ type: 'text', text, marks: [{ type: 'bold' }] }]

const linked = (text: string, href: string): InlineContent => [
  { type: 'text', text, marks: [{ type: 'link', href }] },
]

/**
 * The failure this closes: the editor rebuilt the whole run as one unmarked
 * node on every keystroke, so a document imported with links and emphasis lost
 * all of it the first time somebody fixed a typo — silently, with no way back
 * short of a revision.
 */
describe('editing text that carries marks', () => {
  it('leaves the content alone when nothing changed', () => {
    const content = bold('unchanged')
    expect(replaceInlineText(content, 'unchanged')).toBe(content)
  })

  it('keeps a link that the edit never touched', () => {
    const content: InlineContent = [
      { type: 'text', text: 'Read ' },
      { type: 'text', text: 'the guide', marks: [{ type: 'link', href: 'https://example.com' }] },
      { type: 'text', text: ' today.' },
    ]

    const edited = replaceInlineText(content, 'Read the guide tomorrow.')

    expect(inlineToText(edited)).toBe('Read the guide tomorrow.')
    expect(edited.find((node) => node.marks?.[0]?.type === 'link')).toMatchObject({
      text: 'the guide',
    })
  })

  it('keeps emphasis when a word before it is corrected', () => {
    const content: InlineContent = [
      { type: 'text', text: 'teh ' },
      { type: 'text', text: 'important', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' part' },
    ]

    const edited = replaceInlineText(content, 'the important part')

    expect(inlineToText(edited)).toBe('the important part')
    expect(edited.filter((node) => node.marks?.some((mark) => mark.type === 'bold'))).toHaveLength(
      1,
    )
  })

  /*
   * Fixing a word inside a bold sentence keeps it bold, which is what the
   * author means: they were writing in that run.
   */
  it('gives the replacement the marks of the run it happened in', () => {
    const edited = replaceInlineText(bold('hello world'), 'hello there')

    expect(inlineToText(edited)).toBe('hello there')
    expect(edited).toHaveLength(1)
    expect(edited[0]?.marks).toEqual([{ type: 'bold' }])
  })

  it('continues the run when text is typed at its end', () => {
    const edited = replaceInlineText(bold('hello'), 'hello there')

    expect(edited).toHaveLength(1)
    expect(edited[0]?.marks).toEqual([{ type: 'bold' }])
  })

  /*
   * A change spanning two differently marked runs cannot inherit both, so it
   * inherits neither rather than guessing. That is the one place a mark is
   * lost, and it is the place any editor loses it.
   */
  it('leaves a change that spans two runs unmarked', () => {
    const content: InlineContent = [
      { type: 'text', text: 'one', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'two', marks: [{ type: 'italic' }] },
    ]

    // Deleting across the boundary: 'netw' spans both runs, so what replaces
    // it belongs to neither.
    const edited = replaceInlineText(content, 'oXo')

    expect(inlineToText(edited)).toBe('oXo')
    expect(edited.some((node) => node.marks === undefined)).toBe(true)
  })

  it('handles a deletion that removes a marked run entirely', () => {
    const content: InlineContent = [
      { type: 'text', text: 'keep ' },
      { type: 'text', text: 'gone', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' keep' },
    ]

    const edited = replaceInlineText(content, 'keep  keep')

    expect(inlineToText(edited)).toBe('keep  keep')
    expect(edited.every((node) => node.marks === undefined)).toBe(true)
  })

  it('answers empty content for an emptied field, and plain text for a new one', () => {
    expect(replaceInlineText(bold('gone'), '')).toEqual([])
    expect(replaceInlineText([], 'fresh')).toEqual([{ type: 'text', text: 'fresh' }])
  })

  /*
   * Without merging, a paragraph edited fifty times is fifty nodes saying the
   * same thing: larger to store, slower to render, unreadable in a diff.
   */
  it('joins adjacent runs that carry the same marks', () => {
    const content: InlineContent = [
      { type: 'text', text: 'one ' },
      { type: 'text', text: 'two' },
    ]

    const edited = replaceInlineText(content, 'one three')

    expect(edited).toHaveLength(1)
    expect(inlineToText(edited)).toBe('one three')
  })

  it('survives repeated editing without multiplying nodes', () => {
    let content = linked('a link', 'https://example.com')

    for (let index = 0; index < 20; index += 1) {
      content = replaceInlineText(content, `${inlineToText(content)}!`)
    }

    expect(inlineToText(content)).toBe(`a link${'!'.repeat(20)}`)
    expect(content.length).toBeLessThanOrEqual(2)
    expect(content[0]?.marks?.[0]).toMatchObject({ type: 'link' })
  })
})

describe('block identity', () => {
  /** Real uuids: the schema checks the shape as well as the uniqueness. */
  const uuid = (n: number) => `0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c${String(n).padStart(2, '0')}`
  const block = (id: string) => ({ id, type: 'paragraph', content: plain('x') }) as const

  it('refuses a document where two blocks share an id', () => {
    const result = blocksSchema.safeParse([block(uuid(1)), block(uuid(1))])

    expect(result.success).toBe(false)
  })

  it('accepts one where they differ', () => {
    expect(blocksSchema.safeParse([block(uuid(1)), block(uuid(2))]).success).toBe(true)
  })

  /*
   * A document that already holds duplicates could otherwise never be saved
   * again. The first occurrence keeps its id, so anything pointing at it still
   * does.
   */
  it('repairs duplicates on the way in, keeping the first', () => {
    let counter = 0
    const nextId = () => {
      counter += 1
      return `new-${counter}`
    }

    const repaired = withUniqueIds([block('same'), block('same'), block('other')] as never, nextId)

    expect(repaired.map((one) => one.id)).toEqual(['same', 'new-1', 'other'])
  })

  it('does not hand out an id that is already in the document', () => {
    const ids = ['taken', 'free']
    let index = 0
    const repaired = withUniqueIds(
      [block('a'), block('a'), block('taken')] as never,
      () => ids[index++] as string,
    )

    expect(new Set(repaired.map((one) => one.id)).size).toBe(3)
  })

  it('leaves a document that is already distinct untouched', () => {
    const blocks = [block('one'), block('two')] as never
    expect(withUniqueIds(blocks)).toEqual(blocks)
  })
})
