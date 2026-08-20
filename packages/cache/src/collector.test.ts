import { describe, expect, it } from 'vitest'
import { collectTags, currentTags, withTagCollection } from './collector.ts'
import { contentListTag, contentTag } from './tags.ts'

const FIRST = contentTag('11111111-1111-4111-8111-111111111111')
const SECOND = contentTag('22222222-2222-4222-8222-222222222222')

describe('tag collection', () => {
  it('reports what the render read, deduplicated and ordered', async () => {
    const collected = await withTagCollection(async () => {
      collectTags(SECOND, FIRST)
      collectTags(FIRST)
      return 'rendered'
    })

    expect(collected.value).toBe('rendered')
    expect(collected.tags).toEqual([FIRST, SECOND].sort())
  })

  it('does nothing outside a render rather than failing one', () => {
    expect(currentTags()).toBeNull()
    expect(() => collectTags(FIRST)).not.toThrow()
  })

  /*
   * Two pages rendering at once is the normal state of a server, and the
   * failure this guards against is silent: tags leaking between them means one
   * page is purged by the other's content and holds stale copy of its own.
   */
  it('keeps concurrent renders apart', async () => {
    const slow = withTagCollection(async () => {
      collectTags(FIRST)
      await new Promise((resolve) => setTimeout(resolve, 20))
      collectTags(contentListTag('post', 'en'))
      return 'slow'
    })

    const quick = withTagCollection(async () => {
      collectTags(SECOND)
      return 'quick'
    })

    const [slowResult, quickResult] = await Promise.all([slow, quick])

    expect(quickResult.tags).toEqual([SECOND])
    expect(slowResult.tags).toEqual([contentListTag('post', 'en'), FIRST].sort())
  })
})
