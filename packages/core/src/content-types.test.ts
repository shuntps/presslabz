import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { type Capability, capabilitiesFor } from './capabilities.ts'
import { BUILTIN_CONTENT_TYPES, pageType, postType } from './content-types.builtin.ts'
import {
  CONTENT_OPERATIONS,
  CONTENT_STATUSES,
  type ContentStatus,
  canDelete,
  canJoinTranslationGroup,
  canPerform,
  canWrite,
  createContentTypeRegistry,
  defineContentType,
  operationsForDelete,
  operationsForWrite,
  permissionsForCreation,
  permissionsForDocument,
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

  it('lets meta be omitted when the type asks nothing of it', () => {
    const { meta: _dropped, ...withoutMeta } = document()
    const parsed = postType.createSchema.safeParse(withoutMeta)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.meta).toEqual({})
  })

  it('still demands meta the type actually requires, and names the field', () => {
    // `.default({})` would have short-circuited validation and stored an empty
    // object here, failing much later when something read the missing field.
    const strict = defineContentType({
      name: 'release',
      meta: z.object({ version: z.string() }),
    })

    const { meta: _dropped, ...withoutMeta } = document()
    const parsed = strict.createSchema.safeParse(withoutMeta)
    expect(parsed.success).toBe(false)
    expect(parsed.success ? '' : parsed.error.issues[0]?.path.join('.')).toContain('version')
    expect(strict.createSchema.safeParse(document({ meta: { version: '1.0' } })).success).toBe(true)
  })

  it('offers a parent only where nesting means something', () => {
    const withParent = { parentId: '00000000-0000-4000-8000-0000000000ff' }

    expect(pageType.createSchema.safeParse(document(withParent)).success).toBe(true)

    /*
     * A post has no parent, so the key is not part of its shape — and being
     * told so is the point. This used to be accepted and the key dropped,
     * which meant a caller who nested a post was told their write succeeded
     * and got a document with no parent. Create is strict now, like update.
     */
    const post = postType.createSchema.safeParse(document(withParent))
    expect(post.success).toBe(false)
    expect(post.success ? '' : JSON.stringify(post.error.issues)).toMatch(/parentId/)
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

  it('asks for publish to edit a document that is already live', () => {
    /*
     * The case that reads as an omission until it bites: a patch carrying no
     * status at all still rewrites what the public is reading, so it costs the
     * same capability that put it there.
     */
    expect(operationsForWrite({ currentStatus: 'published', nextStatus: 'published' })).toEqual([
      'update',
      'publish',
    ])
    expect(operationsForWrite({ currentStatus: 'scheduled', nextStatus: 'scheduled' })).toEqual([
      'update',
      'publish',
    ])
    expect(operationsForWrite({ currentStatus: 'scheduled', nextStatus: 'published' })).toEqual([
      'update',
      'publish',
    ])
  })

  it('asks for publish to take a document off the site', () => {
    // Unpublishing is an editorial act however cheap the transition looks.
    expect(operationsForWrite({ currentStatus: 'published', nextStatus: 'draft' })).toEqual([
      'update',
      'publish',
    ])
    expect(operationsForWrite({ currentStatus: 'published', nextStatus: 'archived' })).toEqual([
      'update',
      'publish',
    ])
    expect(operationsForWrite({ currentStatus: 'scheduled', nextStatus: 'draft' })).toEqual([
      'update',
      'publish',
    ])
  })

  it('leaves the statuses the public never sees to update alone', () => {
    expect(operationsForWrite({ currentStatus: 'archived', nextStatus: 'draft' })).toEqual([
      'update',
    ])
    expect(operationsForWrite({ currentStatus: 'draft', nextStatus: 'trash' })).toEqual(['update'])
    expect(operationsForWrite({ currentStatus: 'draft', nextStatus: 'draft' })).toEqual(['update'])
  })
})

describe('operationsForDelete', () => {
  it('asks for publish to remove something the public can see', () => {
    // Otherwise the rule gating the gentle verb is escaped by choosing the
    // destructive one: deleting a live page takes it off the site too.
    expect(operationsForDelete('published')).toEqual(['delete', 'publish'])
    expect(operationsForDelete('scheduled')).toEqual(['delete', 'publish'])
  })

  it('asks for delete alone otherwise', () => {
    expect(operationsForDelete('draft')).toEqual(['delete'])
    expect(operationsForDelete('archived')).toEqual(['delete'])
    expect(operationsForDelete('trash')).toEqual(['delete'])
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

describe('editing what is already live', () => {
  const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
    capabilities: capabilitiesFor(role),
    id,
  })

  const own = { authorId: alice }

  it('stops a contributor rewriting their own document once it is published', () => {
    /*
     * The sequence this closes: a contributor writes a draft, an editor
     * publishes it, and the contributor still holds content:update:own over
     * the row — so without this they keep rewriting a live page, and the
     * request that does it carries no status field at all.
     */
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
        { currentStatus: 'published', nextStatus: 'published' },
        actor('contributor'),
        own,
      ),
    ).toBe(false)

    expect(
      canWrite(
        postType,
        { currentStatus: 'scheduled', nextStatus: 'scheduled' },
        actor('contributor'),
        own,
      ),
    ).toBe(false)
  })

  it('stops a contributor taking their own published document down again', () => {
    expect(
      canWrite(
        postType,
        { currentStatus: 'published', nextStatus: 'draft' },
        actor('contributor'),
        own,
      ),
    ).toBe(false)
  })

  it('lets an author manage their own published document, because they may publish', () => {
    for (const next of ['published', 'draft', 'archived'] as const) {
      expect(
        canWrite(postType, { currentStatus: 'published', nextStatus: next }, actor('author'), own),
      ).toBe(true)
    }
  })

  it('still refuses an author somebody else’s published document', () => {
    expect(
      canWrite(postType, { currentStatus: 'published', nextStatus: 'draft' }, actor('author'), {
        authorId: bob,
      }),
    ).toBe(false)
  })

  it('keeps the :any operations working for an editor', () => {
    expect(
      canWrite(postType, { currentStatus: 'published', nextStatus: 'draft' }, actor('editor'), {
        authorId: bob,
      }),
    ).toBe(true)
  })
})

describe('canDelete', () => {
  const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
    capabilities: capabilitiesFor(role),
    id,
  })

  const own = { authorId: alice }

  it('lets a contributor delete their own draft', () => {
    expect(canDelete(postType, 'draft', actor('contributor'), own)).toBe(true)
  })

  it('refuses a contributor their own published document', () => {
    expect(canDelete(postType, 'published', actor('contributor'), own)).toBe(false)
    expect(canDelete(postType, 'scheduled', actor('contributor'), own)).toBe(false)
  })

  it('lets an author delete their own published document', () => {
    expect(canDelete(postType, 'published', actor('author'), own)).toBe(true)
  })

  it('refuses an author somebody else’s, published or not', () => {
    expect(canDelete(postType, 'draft', actor('author'), { authorId: bob })).toBe(false)
    expect(canDelete(postType, 'published', actor('author'), { authorId: bob })).toBe(false)
  })

  it('needs both capabilities, not either one', () => {
    const deleterOnly = { capabilities: new Set<Capability>(['content:delete:any']), id: alice }
    expect(canDelete(postType, 'published', deleterOnly)).toBe(false)

    const both = {
      capabilities: new Set<Capability>(['content:delete:any', 'content:publish']),
      id: alice,
    }
    expect(canDelete(postType, 'published', both)).toBe(true)
  })
})

describe('canJoinTranslationGroup', () => {
  const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
    capabilities: capabilitiesFor(role),
    id,
  })

  const member = (status: ContentStatus, authorId: string | null = alice) => ({ authorId, status })

  it('lets somebody translate a document they may write', () => {
    expect(canJoinTranslationGroup(postType, actor('contributor'), [member('draft')])).toBe(true)
  })

  it('refuses somebody who may not write any member', () => {
    // A group id is not a secret and must never be what grants access.
    expect(canJoinTranslationGroup(postType, actor('contributor'), [member('draft', bob)])).toBe(
      false,
    )
  })

  it('refuses a contributor once their own document has been published', () => {
    /*
     * The gap this closes. Editing a live document costs content:publish, so a
     * contributor whose draft an editor published may no longer touch it — but
     * they still hold content:update:own, so a rule phrased in capabilities
     * alone let them keep extending the group. Adding a French version of a
     * page you may not edit is that same edit, one step removed.
     */
    expect(canJoinTranslationGroup(postType, actor('contributor'), [member('published')])).toBe(
      false,
    )
    expect(canJoinTranslationGroup(postType, actor('contributor'), [member('scheduled')])).toBe(
      false,
    )
  })

  it('lets an author translate their own published document, because they may publish', () => {
    expect(canJoinTranslationGroup(postType, actor('author'), [member('published')])).toBe(true)
  })

  it('needs only one member it may write, not all of them', () => {
    const group = [member('draft', bob), member('draft', alice)]
    expect(canJoinTranslationGroup(postType, actor('contributor'), group)).toBe(true)
  })

  it('refuses an empty group outright', () => {
    // Nobody holds write permission over nothing, so a group with no members
    // is one no path can attach to.
    expect(canJoinTranslationGroup(postType, actor('editor'), [])).toBe(false)
  })

  it('needs create permission as well as the write', () => {
    // A subscriber may read a published document and never add to its group.
    expect(canJoinTranslationGroup(postType, actor('subscriber'), [member('published')])).toBe(
      false,
    )
  })
})

describe('permissions handed to the interface', () => {
  const actor = (role: Parameters<typeof capabilitiesFor>[0], id: string | null = alice) => ({
    capabilities: capabilitiesFor(role),
    id,
  })

  it('offers a contributor no publishable status to move their draft to', () => {
    // What the editor greys out. Derived from canWrite rather than restated,
    // so a control cannot be drawn open on a transition the route refuses.
    const permissions = permissionsForDocument(postType, actor('contributor'), {
      authorId: alice,
      status: 'draft',
    })

    expect(permissions.update).toBe(true)
    expect(permissions.delete).toBe(true)
    expect(permissions.statuses).toEqual(['draft', 'archived', 'trash'])
  })

  it('offers a contributor nothing at all on a document that went live', () => {
    const permissions = permissionsForDocument(postType, actor('contributor'), {
      authorId: alice,
      status: 'published',
    })

    expect(permissions.update).toBe(false)
    expect(permissions.delete).toBe(false)
    expect(permissions.statuses).toEqual([])
  })

  it('offers an author every status on their own published document', () => {
    const permissions = permissionsForDocument(postType, actor('author'), {
      authorId: alice,
      status: 'published',
    })

    expect(permissions.update).toBe(true)
    expect(permissions.delete).toBe(true)
    expect(permissions.statuses).toEqual([...CONTENT_STATUSES])
  })

  it('says a subscriber may not create, and offers them nothing', () => {
    const permissions = permissionsForCreation(postType, actor('subscriber'))
    expect(permissions.create).toBe(false)
    expect(permissions.statuses).toEqual([])
  })

  it('offers a contributor only the statuses a creation may land in', () => {
    const permissions = permissionsForCreation(postType, actor('contributor'))
    expect(permissions.create).toBe(true)
    expect(permissions.statuses).toEqual(['draft', 'archived', 'trash'])
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

describe('public base path', () => {
  it('defaults to the type name, which can never collide', () => {
    expect(defineContentType({ name: 'recipe' }).basePath).toBe('recipe')
  })

  it('takes the declared segment, including the locale root', () => {
    expect(defineContentType({ name: 'post', basePath: 'blog' }).basePath).toBe('blog')
    expect(defineContentType({ name: 'page', basePath: '' }).basePath).toBe('')
  })

  it('refuses a base path that is not a single path segment', () => {
    expect(() => defineContentType({ name: 'post', basePath: 'blog/posts' })).toThrow(/base path/)
    expect(() => defineContentType({ name: 'post', basePath: 'Blog' })).toThrow(/base path/)
  })

  /*
   * Which of the two would be unreachable depends on registration order, and
   * that is a plugin load order — so the same two plugins would shadow
   * different content on different installations.
   */
  it('refuses two types claiming one segment', () => {
    const first = defineContentType({ name: 'post', basePath: 'blog' })
    const second = defineContentType({ name: 'article', basePath: 'blog' })

    expect(() => createContentTypeRegistry([first, second])).toThrow(/both claim "\/blog"/)
  })

  it('refuses two types claiming the locale root', () => {
    const first = defineContentType({ name: 'page', basePath: '' })
    const second = defineContentType({ name: 'landing', basePath: '' })

    expect(() => createContentTypeRegistry([first, second])).toThrow(/both claim the locale root/)
  })
})
