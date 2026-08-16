import { describe, expect, it } from 'vitest'
import { type Capability, capabilitiesFor } from './capabilities.ts'
import { BUILTIN_CONTENT_TYPES, pageType, postType } from './content-types.builtin.ts'
import {
  CONTENT_OPERATIONS,
  canPerform,
  canWrite,
  createContentTypeRegistry,
  defineContentType,
  operationsForWrite,
} from './content-types.ts'

const alice = 'a'
const bob = 'b'
const blockId = '00000000-0000-4000-8000-000000000001'

function document(overrides: Record<string, unknown> = {}) {
  return {
    locale: 'fr',
    slug: 'le-futur-du-cms',
    title: 'Le futur du CMS',
    meta: {},
    ...overrides,
  }
}

describe('defineContentType', () => {
  it('refuses a name that could not sit in a URL or the type column', () => {
    expect(() => defineContentType({ name: 'Post' })).toThrow()
    expect(() => defineContentType({ name: 'my post' })).toThrow()
    expect(() => defineContentType({ name: '2post' })).toThrow()
    expect(() => defineContentType({ name: '' })).toThrow()
  })

  it('accepts a whole document', () => {
    expect(postType.createSchema.safeParse(document()).success).toBe(true)
  })

  it('refuses a locale the installation does not serve', () => {
    expect(postType.createSchema.safeParse(document({ locale: 'de' })).success).toBe(false)
  })

  it('refuses a schedule with no date to keep', () => {
    // Otherwise the document sits in a state nothing will ever move it out of.
    expect(postType.createSchema.safeParse(document({ status: 'scheduled' })).success).toBe(false)
    const scheduled = document({ status: 'scheduled', publishedAt: '2026-09-01T09:00:00Z' })
    expect(postType.createSchema.safeParse(scheduled).success).toBe(true)
  })

  it('validates blocks through the block vocabulary rather than beside it', () => {
    const good = document({ blocks: [{ id: blockId, type: 'divider' }] })
    const bad = document({ blocks: [{ id: blockId, type: 'html', html: '<script>x</script>' }] })
    expect(postType.createSchema.safeParse(good).success).toBe(true)
    expect(postType.createSchema.safeParse(bad).success).toBe(false)
  })

  it('types meta instead of accepting whatever a caller sends', () => {
    const good = document({ meta: { seo: { description: 'A description' } } })
    const bad = document({ meta: { featuredMediaId: 'not-a-uuid' } })
    expect(postType.createSchema.safeParse(good).success).toBe(true)
    expect(postType.createSchema.safeParse(bad).success).toBe(false)
  })

  it('offers a parent only where nesting means something', () => {
    const withParent = { parentId: '00000000-0000-4000-8000-0000000000ff' }
    const page = pageType.createSchema.safeParse(document(withParent))
    const post = postType.createSchema.safeParse(document(withParent))
    expect(page.success).toBe(true)
    // A post has no parent, so the key is not part of its shape and is dropped.
    expect(post.success).toBe(true)
    expect(post.success && 'parentId' in post.data).toBe(false)
  })

  it('refuses a language move by name rather than dropping it', () => {
    // z.object() strips unknown keys, so this used to be accepted and then
    // silently ignored — the caller was told the write succeeded when the
    // part they cared about did not happen.
    const parsed = postType.updateSchema.safeParse({ title: 'Titre', locale: 'en' })
    expect(parsed.success).toBe(false)
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toMatch(/cannot change language/)
  })

  it('refuses any other key it does not know, instead of ignoring it', () => {
    const parsed = postType.updateSchema.safeParse({ title: 'Titre', authorId: 'someone-else' })
    expect(parsed.success).toBe(false)
    expect(parsed.success ? '' : parsed.error.issues[0]?.message).toMatch(/[Uu]nrecognized key/)
  })

  it('does not judge a patch as if it were a state', () => {
    // The patch alone cannot know whether a date already exists on the row,
    // so the cross-field rule does not belong here. stateSchema decides.
    expect(postType.updateSchema.safeParse({ status: 'scheduled' }).success).toBe(true)
  })

  it('lets an update carry one field alone', () => {
    expect(postType.updateSchema.safeParse({ title: 'Un titre' }).success).toBe(true)
  })

  /**
   * The assertion here is that this file compiles. Reading `.title` and
   * `.meta.seo` off the parsed value only typechecks if the declaration
   * handed back real types rather than `unknown` — which is the half of
   * "one call yields validation and types" that a stray z.ZodType annotation
   * silently deletes while every runtime test keeps passing.
   */
  it('hands the caller types, not just validation', () => {
    const parsed = postType.createSchema.parse(
      document({ meta: { seo: { title: 'SEO' } }, excerpt: 'An excerpt' }),
    )

    expect(parsed.title).toBe('Le futur du CMS')
    expect(parsed.status).toBe('draft')
    expect(parsed.blocks).toEqual([])
    expect(parsed.meta.seo?.title).toBe('SEO')
    expect(parsed.excerpt?.startsWith('An')).toBe(true)
  })
})

describe('canPerform', () => {
  const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
    capabilities: capabilitiesFor(role),
    id,
  })

  it('lets an author edit their own document but not another', () => {
    expect(canPerform(postType, 'update', actor('author'), { authorId: alice })).toBe(true)
    expect(canPerform(postType, 'update', actor('author'), { authorId: bob })).toBe(false)
  })

  it('lets an editor edit anyone', () => {
    expect(canPerform(postType, 'update', actor('editor'), { authorId: bob })).toBe(true)
    expect(canPerform(postType, 'delete', actor('editor'), { authorId: bob })).toBe(true)
  })

  it('refuses a subscriber outright', () => {
    expect(canPerform(postType, 'update', actor('subscriber'), { authorId: alice })).toBe(false)
    expect(canPerform(postType, 'create', actor('subscriber'))).toBe(false)
  })

  it('refuses an orphaned document to an "own only" role', () => {
    // authorId null means the author was deleted; nobody owns it any more.
    expect(canPerform(postType, 'delete', actor('author'), { authorId: null })).toBe(false)
    expect(canPerform(postType, 'delete', actor('editor'), { authorId: null })).toBe(true)
  })

  it('refuses an anonymous actor even when the owner is also null', () => {
    expect(canPerform(postType, 'update', actor('author', null), { authorId: null })).toBe(false)
  })

  it('keeps publishing separate from editing', () => {
    expect(canPerform(postType, 'publish', actor('contributor'))).toBe(false)
    expect(canPerform(postType, 'publish', actor('author'))).toBe(true)
  })

  it('honours a per-type override rather than the default', () => {
    const locked = defineContentType({
      name: 'setting-page',
      access: { update: { any: 'settings:manage' } },
    })
    expect(canPerform(locked, 'update', actor('editor'), { authorId: alice })).toBe(false)
    expect(canPerform(locked, 'update', actor('administrator'), { authorId: bob })).toBe(true)
  })

  it('answers for every declared operation', () => {
    for (const operation of CONTENT_OPERATIONS) {
      expect(
        typeof canPerform(postType, operation, actor('administrator'), { authorId: bob }),
        operation,
      ).toBe('boolean')
    }
  })
})

describe('stateSchema', () => {
  const state = (overrides: Record<string, unknown> = {}) => ({
    slug: 'le-futur-du-cms',
    title: 'Le futur du CMS',
    meta: {},
    ...overrides,
  })

  it('judges the merged state, which is the only thing that knows', () => {
    // A row already carrying a date, patched to scheduled: valid.
    const merged = {
      ...state({ publishedAt: new Date('2026-09-01T09:00:00Z') }),
      status: 'scheduled',
    }
    expect(postType.stateSchema.safeParse(merged).success).toBe(true)

    // The same patch onto a row with no date: not valid.
    const bare = { ...state(), status: 'scheduled' }
    expect(postType.stateSchema.safeParse(bare).success).toBe(false)
  })

  it('holds the same invariant createSchema does', () => {
    expect(postType.createSchema.safeParse(document({ status: 'scheduled' })).success).toBe(false)
    expect(postType.stateSchema.safeParse(state({ status: 'scheduled' })).success).toBe(false)
  })
})

describe('operationsForWrite', () => {
  it('asks for publish when a creation lands in a publishable state', () => {
    expect(operationsForWrite({ nextStatus: 'draft' })).toEqual(['create'])
    expect(operationsForWrite({ nextStatus: 'published' })).toEqual(['create', 'publish'])
    // Scheduling is publishing with a delay: nobody presses a button later.
    expect(operationsForWrite({ nextStatus: 'scheduled' })).toEqual(['create', 'publish'])
  })

  it('asks for publish when an update moves into a publishable state', () => {
    expect(operationsForWrite({ currentStatus: 'draft', nextStatus: 'published' })).toEqual([
      'update',
      'publish',
    ])
    expect(operationsForWrite({ currentStatus: 'draft', nextStatus: 'scheduled' })).toEqual([
      'update',
      'publish',
    ])
  })

  it('does not ask twice for a document that is already publishable', () => {
    expect(operationsForWrite({ currentStatus: 'published', nextStatus: 'published' })).toEqual([
      'update',
    ])
    expect(operationsForWrite({ currentStatus: 'scheduled', nextStatus: 'published' })).toEqual([
      'update',
    ])
  })

  it('leaves the ungated cases ungated, on purpose', () => {
    // Both want an edit_published_posts equivalent that does not exist yet.
    expect(operationsForWrite({ currentStatus: 'published', nextStatus: 'draft' })).toEqual([
      'update',
    ])
    expect(operationsForWrite({ currentStatus: 'archived', nextStatus: 'draft' })).toEqual([
      'update',
    ])
  })
})

describe('canWrite', () => {
  const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
    capabilities: capabilitiesFor(role),
    id,
  })

  it('stops a contributor publishing by choosing a status', () => {
    // The whole point: the schema accepts `published`, so if the route only
    // checked `create` this would have gone straight onto the site.
    expect(canWrite(postType, { nextStatus: 'draft' }, actor('contributor'))).toBe(true)
    expect(canWrite(postType, { nextStatus: 'published' }, actor('contributor'))).toBe(false)
    expect(canWrite(postType, { nextStatus: 'scheduled' }, actor('contributor'))).toBe(false)
  })

  it('stops a contributor publishing their own draft by editing it', () => {
    const own = { authorId: alice }
    expect(
      canWrite(
        postType,
        { currentStatus: 'draft', nextStatus: 'draft' },
        actor('contributor'),
        own,
      ),
    ).toBe(true)
    expect(
      canWrite(
        postType,
        { currentStatus: 'draft', nextStatus: 'published' },
        actor('contributor'),
        own,
      ),
    ).toBe(false)
  })

  it('lets an author publish their own and still not touch another', () => {
    expect(
      canWrite(postType, { currentStatus: 'draft', nextStatus: 'published' }, actor('author'), {
        authorId: alice,
      }),
    ).toBe(true)
    expect(
      canWrite(postType, { currentStatus: 'draft', nextStatus: 'published' }, actor('author'), {
        authorId: bob,
      }),
    ).toBe(false)
  })

  it('requires both operations, not either one', () => {
    // An editor may update anything but cannot publish without the capability.
    const publisherOnly = {
      capabilities: new Set<Capability>(['content:publish']),
      id: alice,
    }
    expect(canWrite(postType, { nextStatus: 'published' }, publisherOnly)).toBe(false)

    const creatorOnly = {
      capabilities: new Set<Capability>(['content:create']),
      id: alice,
    }
    expect(canWrite(postType, { nextStatus: 'published' }, creatorOnly)).toBe(false)

    const both = {
      capabilities: new Set<Capability>(['content:create', 'content:publish']),
      id: alice,
    }
    expect(canWrite(postType, { nextStatus: 'published' }, both)).toBe(true)
  })
})

describe('createContentTypeRegistry', () => {
  it('refuses two types with the same name', () => {
    expect(() => createContentTypeRegistry([postType, postType])).toThrow(/twice/)
  })

  it('throws on a name the caller claimed to have routed on', () => {
    const registry = createContentTypeRegistry(BUILTIN_CONTENT_TYPES)
    expect(registry.get('nope')).toBeUndefined()
    expect(() => registry.require('nope')).toThrow(/Unknown content type/)
    expect(registry.require('post')).toBe(postType)
  })

  it('is built per caller rather than shared, so registrations cannot leak', () => {
    const one = createContentTypeRegistry([postType])
    const two = createContentTypeRegistry([postType, pageType])
    expect(one.names()).toEqual(['post'])
    expect(two.names()).toEqual(['post', 'page'])
  })
})
