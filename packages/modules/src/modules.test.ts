import type { Blocks } from '@presslabz/blocks'
import { createNullPageCache, type PageCache } from '@presslabz/cache'
import {
  type ContentEvent,
  type CoreActions,
  type CoreFilters,
  createHooks,
  type Hooks,
} from '@presslabz/core'
import { describe, expect, it, vi } from 'vitest'
import { autoExcerpt, truncate } from './auto-excerpt.ts'
import { cacheInvalidation } from './cache-invalidation.ts'
import { installModules } from './module.ts'

const CONTENT: ContentEvent = {
  id: '0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c22',
  type: 'post',
  locale: 'en',
  translationGroupId: '11111111-1111-4111-8111-111111111111',
  slug: 'hello-world',
  title: 'Hello world',
  status: 'published',
  publishedAt: new Date('2026-08-20T12:00:00.000Z'),
  authorId: null,
}

function blocks(...paragraphs: string[]): Blocks {
  return paragraphs.map((text, index) => ({
    id: `00000000-0000-4000-8000-00000000000${index}`,
    type: 'paragraph',
    content: [{ type: 'text', text }],
  }))
}

function hooks(): Hooks<CoreActions, CoreFilters> {
  return createHooks<CoreActions, CoreFilters>()
}

function recordingCache(): { cache: PageCache; purged: string[][] } {
  const purged: string[][] = []
  const cache: PageCache = {
    ...createNullPageCache(),
    purgeTags: async (tags) => {
      purged.push([...tags])
      return tags.length
    },
  }
  return { cache, purged }
}

describe('cache invalidation', () => {
  /*
   * The module hears about writes exactly as a third-party plugin would. That
   * is the point of the phase: a feature that needed a private door would be a
   * hole in the API, and it is cheaper to find one here.
   */
  it('purges the document, its listings and its translation group', async () => {
    const { cache, purged } = recordingCache()
    const registry = hooks()
    installModules(registry, [cacheInvalidation(cache)])

    await registry.emit('content:updated', { ...CONTENT, previousStatus: 'draft' })

    expect(purged).toHaveLength(1)
    expect(purged[0]).toEqual([
      `content:${CONTENT.id}`,
      'list:post:en',
      `group:${CONTENT.translationGroupId}`,
    ])
  })

  /*
   * The scheduler announces a publication and nothing else. Listening only to
   * the broad events looked sufficient until it existed, and a post that had
   * gone live kept serving the page that said it had not.
   */
  it('hears a publication announced on its own', async () => {
    const { cache, purged } = recordingCache()
    const registry = hooks()
    installModules(registry, [cacheInvalidation(cache)])

    await registry.emit('content:published', { ...CONTENT, previousStatus: 'scheduled' })
    await registry.emit('content:unpublished', { ...CONTENT, previousStatus: 'published' })

    expect(purged).toHaveLength(2)
  })

  it('hears about a creation and a deletion as well as an edit', async () => {
    const { cache, purged } = recordingCache()
    const registry = hooks()
    installModules(registry, [cacheInvalidation(cache)])

    await registry.emit('content:created', CONTENT)
    await registry.emit('content:deleted', CONTENT)

    expect(purged).toHaveLength(2)
  })

  it('purges an asset when its description changes', async () => {
    const { cache, purged } = recordingCache()
    const registry = hooks()
    installModules(registry, [cacheInvalidation(cache)])

    await registry.emit('media:updated', {
      id: '22222222-2222-4222-8222-222222222222',
      mimeType: 'image/avif',
      uploadedById: null,
    })

    expect(purged[0]).toEqual(['media:22222222-2222-4222-8222-222222222222'])
  })

  /*
   * A cache that cannot be reached is an operational problem, not an editorial
   * one: the document is already saved, and the write must not be reported as
   * failed because a purge was.
   */
  it('does not fail the write when the cache is unreachable', async () => {
    const failing: PageCache = {
      ...createNullPageCache(),
      purgeTags: async () => {
        throw new Error('valkey is down')
      },
    }

    const failures: unknown[] = []
    const registry = createHooks<CoreActions, CoreFilters>({
      onFailure: (failure) => failures.push(failure),
    })
    installModules(registry, [cacheInvalidation(failing)])

    await expect(registry.emit('content:created', CONTENT)).resolves.toBeUndefined()
    expect(failures).toHaveLength(1)
  })

  it('stops purging once it is uninstalled', async () => {
    const { cache, purged } = recordingCache()
    const registry = hooks()
    const uninstall = installModules(registry, [cacheInvalidation(cache)])

    uninstall()
    await registry.emit('content:created', CONTENT)

    expect(purged).toHaveLength(0)
  })
})

describe('automatic excerpts', () => {
  it('summarises a document that has no summary', async () => {
    const registry = hooks()
    installModules(registry, [autoExcerpt()])

    const result = await registry.apply('content:excerpt', {
      excerpt: '',
      blocks: blocks('The first paragraph carries the summary.', 'The second does not.'),
      content: CONTENT,
    })

    expect(result.excerpt).toBe('The first paragraph carries the summary. The second does not.')
  })

  /*
   * An author's own summary is what appears in a search result and in a feed.
   * A module that replaced it would be editing their work.
   */
  it('never overwrites one the author wrote', async () => {
    const registry = hooks()
    installModules(registry, [autoExcerpt()])

    const result = await registry.apply('content:excerpt', {
      excerpt: 'Mine',
      blocks: blocks('Something else entirely.'),
      content: CONTENT,
    })

    expect(result.excerpt).toBe('Mine')
  })

  it('leaves a document with nothing to summarise alone', async () => {
    const registry = hooks()
    installModules(registry, [autoExcerpt()])

    const result = await registry.apply('content:excerpt', {
      excerpt: '',
      blocks: [],
      content: CONTENT,
    })

    expect(result.excerpt).toBe('')
  })

  it('cuts at a word, and says that it cut', async () => {
    const registry = hooks()
    installModules(registry, [autoExcerpt({ maxLength: 20 })])

    const result = await registry.apply('content:excerpt', {
      excerpt: '',
      blocks: blocks('Supercalifragilistic words follow this one'),
      content: CONTENT,
    })

    expect(result.excerpt.endsWith('…')).toBe(true)
    expect(result.excerpt.length).toBeLessThanOrEqual(21)
    expect(result.excerpt).not.toContain('  ')
  })
})

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('short', 20)).toBe('short')
  })

  it('cuts mid-word only when there is no word boundary to use', () => {
    expect(truncate('aaaaaaaaaaaaaaaaaaaaaa', 10)).toBe('aaaaaaaaaa…')
    expect(truncate('one two three four', 10)).toBe('one two…')
  })
})

describe('installing modules', () => {
  it('registers each of them and can remove them all', () => {
    const registry = hooks()
    const module = { name: 'test', register: vi.fn(() => vi.fn()) }

    const uninstall = installModules(registry, [module])
    expect(module.register).toHaveBeenCalledWith(registry)

    uninstall()
    expect(module.register.mock.results[0]?.value).toHaveBeenCalled()
  })
})
