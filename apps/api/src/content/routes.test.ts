import { contentTag, createPageCache, type PageCache } from '@presslabz/cache'
import { verifyPreviewToken } from '@presslabz/core/preview'
import { createDb, createSession, createUser, type Database, deleteContent } from '@presslabz/db'
import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import type { Module } from '@presslabz/modules'
import type { FastifyInstance } from 'fastify'
import { Valkey } from 'iovalkey'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateSessionToken, hashSessionToken } from '../auth/session.ts'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'

/*
 * These drive the real routes against a real database, because the thing being
 * asserted is the authorization path: which capability a status transition
 * costs, and whether the check happens against the row the write actually
 * lands on. A mocked repository would let every one of these pass while the
 * bug stayed.
 *
 * The database is a scratch one the suite drops afterwards. It used to be
 * whatever DATABASE_URL pointed at, under four fixed addresses reused across
 * runs — so two concurrent runs shared accounts, and every run left another
 * four sessions behind for good. Nothing about these tests wants a shared
 * database; they only ever wanted a migrated one.
 */
const ready = hasIntegrationEnv()

/**
 * Cleanup deletes exactly the ids this file created, through the repository.
 * Nothing here builds a query: drizzle stays inside packages/db, which is the
 * rule that keeps query building in one place — and the reason this file does
 * not simply delete by a slug prefix.
 */
const uniqueSlug = (name: string) => `rt-${name}-${Math.floor(Math.random() * 1e9)}`

describe.skipIf(!ready)('content routes', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let namespace: string
  let cacheNamespace: string
  const announced: { name: string; id: string }[] = []
  let cacheClient: Valkey
  let pageCache: PageCache
  let app: FastifyInstance
  let handle: ReturnType<typeof createDb>
  let db: Database
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}
  const created: string[] = []
  let cookieName: string

  /** The database starts empty, so these are simply created. */
  async function signIn(role: string, email: string) {
    const user = await createUser(db, { email, displayName: role, role, passwordHash: null })
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookies[role] = token
    ids[role] = user.id
    return user
  }

  const as = (role: string) => ({ [cookieName]: cookies[role] as string })

  beforeAll(async () => {
    scratch = await createScratchDatabase('content-routes')
    namespace = testRateLimitNamespace('content-routes')

    /*
     * Set before app.ts is imported, because env.ts parses process.env once at
     * import: an installation with no preview secret answers 503 to every
     * preview request, which would make the authorization tests below assert
     * nothing.
     */
    process.env.PREVIEW_SECRET = 'x'.repeat(48)
    process.env.SITE_URL = 'http://127.0.0.1:4321'

    // env.ts throws at import time when the environment is incomplete, so the
    // app is imported only once the suite knows it can run.
    const [{ buildApp }, { SESSION_COOKIE }] = await Promise.all([
      import('../app.ts'),
      import('../auth/session.ts'),
    ])
    cookieName = SESSION_COOKIE

    cacheNamespace = `presslabz:test:api:${namespace}`
    cacheClient = new Valkey(process.env.VALKEY_URL as string)
    cacheClient.on('error', () => {})
    pageCache = createPageCache({ client: cacheClient, namespace: cacheNamespace })

    /*
     * A module that records what the core announced. It is registered the same
     * way any plugin will be, which is the point: if the events could only be
     * observed from inside the routes, the hook API would not be an API.
     */
    const recorder: Module = {
      name: 'recorder',
      register(hooks) {
        const off = (
          [
            'content:created',
            'content:updated',
            'content:published',
            'content:unpublished',
            'content:deleted',
          ] as const
        ).map((name) =>
          hooks.action(name, (payload) => {
            announced.push({ name, id: (payload as { id: string }).id })
          }),
        )
        return () => {
          for (const remove of off) remove()
        }
      },
    }

    app = await buildApp({
      databaseUrl: scratch.url,
      rateLimitNamespace: namespace,
      pageCacheNamespace: cacheNamespace,
      modules: [recorder],
    })
    await app.ready()

    handle = createDb(scratch.url, { maxConnections: 5 })
    db = handle.db

    await signIn('subscriber', 'rt-subscriber@presslabz.test')
    await signIn('contributor', 'rt-contributor@presslabz.test')
    await signIn('author', 'rt-author@presslabz.test')
    await signIn('editor', 'rt-editor@presslabz.test')
  }, 60_000)

  afterEach(async () => {
    for (const id of created.splice(0)) await deleteContent(db, id)
  })

  afterAll(async () => {
    await handle.close()
    await app.close()
    await scratch.drop()
    // The scratch database goes with a DROP; Valkey keys do not.
    await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
    await pageCache.clear()
    await cacheClient.quit()
  })

  async function post(role: string, body: Record<string, unknown>) {
    const response = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: as(role),
      payload: body,
    })
    if (response.statusCode === 201) created.push(response.json().content.id)
    return response
  }

  /**
   * Reads the document's current version and sends it back with the patch.
   *
   * That is what a client does: it edits what it was shown. A test that
   * hardcoded a version would stop exercising the precondition the moment the
   * document was written to twice, and the tests that are *about* staleness
   * say so by passing expectedVersion themselves.
   */
  async function patch(role: string, id: string, body: Record<string, unknown>) {
    const payload =
      'expectedVersion' in body ? body : { ...body, expectedVersion: await versionOf(role, id) }

    return app.inject({
      method: 'PATCH',
      url: `/content/post/${id}`,
      cookies: as(role),
      payload,
    })
  }

  async function versionOf(role: string, id: string): Promise<number> {
    const response = await app.inject({ url: `/content/post/${id}`, cookies: as(role) })
    return response.statusCode === 200 ? (response.json().content.version as number) : 1
  }

  async function remove(role: string, id: string) {
    return app.inject({ method: 'DELETE', url: `/content/post/${id}`, cookies: as(role) })
  }

  /** A contributor's draft that an editor then put on the site. */
  async function publishedByEditor(name: string) {
    const own = await post('contributor', draft(name))
    const id = own.json().content.id
    expect((await patch('editor', id, { status: 'published' })).statusCode).toBe(200)
    return id
  }

  const draft = (name: string) => ({ locale: 'fr', slug: uniqueSlug(name), title: 'Titre' })

  describe('publishing is a capability, not a field', () => {
    it('refuses a contributor who creates straight into published', async () => {
      // The hole this closes: createSchema accepts `published`, so a route
      // that checked only `create` would have put this on the site.
      const response = await post('contributor', { ...draft('pub'), status: 'published' })
      expect(response.statusCode).toBe(403)
    })

    it('refuses a contributor who schedules instead', async () => {
      const response = await post('contributor', {
        ...draft('sched'),
        status: 'scheduled',
        publishedAt: '2026-09-01T09:00:00Z',
      })
      expect(response.statusCode).toBe(403)
    })

    it('lets the same contributor create a draft', async () => {
      const response = await post('contributor', draft('ok'))
      expect(response.statusCode).toBe(201)
      expect(response.json().content.status).toBe('draft')
    })

    it('refuses a contributor who publishes their own draft by editing it', async () => {
      const created = await post('contributor', draft('own'))
      const id = created.json().content.id

      expect((await patch('contributor', id, { title: 'Nouveau titre' })).statusCode).toBe(200)
      expect((await patch('contributor', id, { status: 'published' })).statusCode).toBe(403)
    })

    it('lets an author publish their own, and stamps the moment', async () => {
      const created = await post('author', draft('author-own'))
      const id = created.json().content.id

      const response = await patch('author', id, { status: 'published' })
      expect(response.statusCode).toBe(200)
      expect(response.json().content.status).toBe('published')
      expect(response.json().content.publishedAt).not.toBeNull()
    })

    it('does not move the date of a document that was already published', async () => {
      // Stamping on every write would silently republish a page each time
      // someone fixed a typo in it.
      const created = await post('editor', {
        ...draft('restamp'),
        status: 'published',
        publishedAt: '2026-01-02T03:04:05Z',
      })
      const id = created.json().content.id
      const first = created.json().content.publishedAt

      const response = await patch('editor', id, { title: 'Titre corrigé' })
      expect(response.statusCode).toBe(200)
      expect(response.json().content.publishedAt).toBe(first)
    })

    it('refuses an author who edits someone else’s document', async () => {
      const created = await post('editor', draft('editors'))
      const id = created.json().content.id

      expect((await patch('author', id, { title: 'Détourné' })).statusCode).toBe(403)
    })
  })

  describe('what is already live costs publish to touch', () => {
    it('refuses a contributor who edits their own document after an editor published it', async () => {
      /*
       * The sequence: a contributor writes a draft, an editor puts it on the
       * site, and the contributor still holds content:update:own over the row.
       * The request that exploits it carries no status field at all — it is an
       * ordinary edit of a live page.
       */
      const id = await publishedByEditor('live-edit')

      const response = await patch('contributor', id, { title: 'Réécrit après coup' })
      expect(response.statusCode).toBe(403)

      const stored = await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })
      expect(stored.json().content.title).toBe('Titre')
    })

    it('refuses a contributor who takes their own published document down', async () => {
      const id = await publishedByEditor('live-unpublish')
      expect((await patch('contributor', id, { status: 'draft' })).statusCode).toBe(403)
      expect((await patch('contributor', id, { status: 'archived' })).statusCode).toBe(403)
    })

    it('lets an author edit and unpublish their own, because they may publish', async () => {
      const created = await post('author', draft('author-live'))
      const id = created.json().content.id
      expect((await patch('author', id, { status: 'published' })).statusCode).toBe(200)

      expect((await patch('author', id, { title: 'Corrigé en ligne' })).statusCode).toBe(200)

      const down = await patch('author', id, { status: 'draft' })
      expect(down.statusCode).toBe(200)
      expect(down.json().content.status).toBe('draft')
    })

    it('still refuses an author someone else’s published document', async () => {
      const created = await post('editor', {
        ...draft('editors-live'),
        status: 'published',
        publishedAt: '2026-01-01T00:00:00Z',
      })
      const id = created.json().content.id

      expect((await patch('author', id, { title: 'Détourné' })).statusCode).toBe(403)
    })

    it('leaves a scheduled document just as protected as a published one', async () => {
      // A schedule needs no further human act to go live, so editing one is
      // editing what the public will read.
      const own = await post('contributor', draft('sched-edit'))
      const id = own.json().content.id
      expect(
        (await patch('editor', id, { status: 'scheduled', publishedAt: '2027-01-01T00:00:00Z' }))
          .statusCode,
      ).toBe(200)

      expect((await patch('contributor', id, { title: 'Réécrit' })).statusCode).toBe(403)
    })

    it('leaves the statuses the public never sees to update alone', async () => {
      const created = await post('contributor', draft('archive'))
      const id = created.json().content.id

      expect((await patch('contributor', id, { status: 'archived' })).statusCode).toBe(200)
      expect((await patch('contributor', id, { status: 'draft' })).statusCode).toBe(200)
    })
  })

  describe('deleting is gated the same way', () => {
    it('lets a contributor delete their own draft', async () => {
      const created = await post('contributor', draft('del-draft'))
      expect((await remove('contributor', created.json().content.id)).statusCode).toBe(204)
    })

    it('refuses a contributor their own document once it is live', async () => {
      // Otherwise the rule gating unpublishing is escaped by choosing the more
      // destructive verb, which takes the page off the site just as surely.
      const id = await publishedByEditor('del-live')

      expect((await remove('contributor', id)).statusCode).toBe(403)
      expect(
        (await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })).statusCode,
      ).toBe(200)
    })

    it('lets an author delete their own published document', async () => {
      const created = await post('author', draft('del-author'))
      const id = created.json().content.id
      expect((await patch('author', id, { status: 'published' })).statusCode).toBe(200)

      expect((await remove('author', id)).statusCode).toBe(204)
    })

    it('refuses an author someone else’s draft', async () => {
      const created = await post('editor', draft('del-others'))
      expect((await remove('author', created.json().content.id)).statusCode).toBe(403)
    })

    it('lets an editor delete anything', async () => {
      const id = await publishedByEditor('del-editor')
      expect((await remove('editor', id)).statusCode).toBe(204)
    })
  })

  describe('the permissions the interface draws from', () => {
    it('offers a contributor no publishable status on their own draft', async () => {
      const created = await post('contributor', draft('perm-draft'))
      const permissions = created.json().content.permissions

      expect(permissions.update).toBe(true)
      expect(permissions.delete).toBe(true)
      expect(permissions.statuses).toEqual(['draft', 'archived', 'trash'])
    })

    it('offers a contributor nothing on a document that went live', async () => {
      const id = await publishedByEditor('perm-live')

      // Published, so they may read it; that is exactly why the answer has to
      // say they may not write it.
      const seen = await app.inject({ url: `/content/post/${id}`, cookies: as('contributor') })
      expect(seen.statusCode).toBe(200)
      expect(seen.json().content.permissions).toEqual({
        update: false,
        delete: false,
        statuses: [],
      })
    })

    it('offers an author every status on their own published document', async () => {
      const created = await post('author', draft('perm-author'))
      const id = created.json().content.id
      const published = await patch('author', id, { status: 'published' })

      expect(published.json().content.permissions.update).toBe(true)
      expect(published.json().content.permissions.statuses).toContain('draft')
      expect(published.json().content.permissions.statuses).toContain('published')
    })

    it('says on each type what a creation could land in', async () => {
      const forContributor = await app.inject({ url: '/content-types', cookies: as('contributor') })
      const allowed = forContributor.json().types.find((t: { name: string }) => t.name === 'post')
      expect(allowed.permissions.create).toBe(true)
      expect(allowed.permissions.statuses).toEqual(['draft', 'archived', 'trash'])

      const forSubscriber = await app.inject({ url: '/content-types', cookies: as('subscriber') })
      const denied = forSubscriber.json().types.find((t: { name: string }) => t.name === 'post')
      expect(denied.permissions.create).toBe(false)
      expect(denied.permissions.statuses).toEqual([])
    })
  })

  describe('a patch is judged against the stored row', () => {
    it('refuses a schedule when the row carries no date', async () => {
      const created = await post('editor', draft('nodate'))
      const id = created.json().content.id

      const response = await patch('editor', id, { status: 'scheduled' })
      expect(response.statusCode).toBe(400)
      expect(response.json().error).toBe('invalid_state')
    })

    it('accepts the same patch when the row already carries one', async () => {
      const created = await post('editor', {
        ...draft('withdate'),
        publishedAt: '2026-09-01T09:00:00Z',
      })
      const id = created.json().content.id

      const response = await patch('editor', id, { status: 'scheduled' })
      expect(response.statusCode).toBe(200)
      expect(response.json().content.status).toBe('scheduled')
    })
  })

  describe('a language move is refused, not ignored', () => {
    it('says what is actually wrong', async () => {
      const created = await post('editor', draft('lang'))
      const id = created.json().content.id

      const response = await patch('editor', id, { locale: 'en' })
      expect(response.statusCode).toBe(400)
      expect(JSON.stringify(response.json().issues)).toMatch(/cannot change language/)
    })

    it('refuses a field it does not know rather than dropping it', async () => {
      const created = await post('editor', draft('unknown'))
      const id = created.json().content.id

      const response = await patch('editor', id, { authorId: ids.contributor })
      expect(response.statusCode).toBe(400)
    })
  })

  describe('listings', () => {
    it('needs a locale and refuses one it does not serve', async () => {
      expect((await app.inject({ url: '/content/post', cookies: as('editor') })).statusCode).toBe(
        400,
      )
      expect(
        (await app.inject({ url: '/content/post?locale=de', cookies: as('editor') })).statusCode,
      ).toBe(400)
    })

    it('shows one language at a time', async () => {
      await post('editor', draft('fr-one'))
      const french = await app.inject({ url: '/content/post?locale=fr', cookies: as('editor') })
      const english = await app.inject({ url: '/content/post?locale=en', cookies: as('editor') })

      expect(french.json().contents.length).toBeGreaterThan(0)
      expect(english.json().contents.every((row: { locale: string }) => row.locale === 'en')).toBe(
        true,
      )
    })

    it('keeps another author’s draft out of a contributor’s list', async () => {
      // content:read belongs to every role, so without a visibility filter
      // this listing would hand out every unpublished document.
      const created = await post('editor', draft('hidden'))
      const hiddenId = created.json().content.id

      const list = await app.inject({ url: '/content/post?locale=fr', cookies: as('contributor') })
      const visible = list.json().contents.map((row: { id: string }) => row.id)
      expect(visible).not.toContain(hiddenId)

      const editorList = await app.inject({ url: '/content/post?locale=fr', cookies: as('editor') })
      expect(editorList.json().contents.map((row: { id: string }) => row.id)).toContain(hiddenId)
    })
  })

  describe('a translation is only as readable as it is on its own', () => {
    it('does not hand a subscriber a draft it could not open directly', async () => {
      // The disclosure this endpoint used to make: content:read belongs to
      // every role, so checking it once and returning the whole group gave
      // away every unpublished sibling, blocks included.
      const anchor = await post('editor', {
        ...draft('anchor'),
        status: 'published',
        publishedAt: '2026-01-01T00:00:00Z',
      })
      const anchorId = anchor.json().content.id
      const groupId = anchor.json().content.translationGroupId

      const hidden = await post('editor', {
        locale: 'en',
        slug: uniqueSlug('hidden'),
        title: 'Unpublished translation',
        translationGroupId: groupId,
      })
      const hiddenId = hidden.json().content.id

      const asEditor = await app.inject({
        url: `/content/post/${anchorId}/translations`,
        cookies: as('editor'),
      })
      expect(asEditor.json().translations.map((r: { id: string }) => r.id)).toContain(hiddenId)

      const asSubscriber = await app.inject({
        url: `/content/post/${anchorId}/translations`,
        cookies: as('subscriber'),
      })
      expect(asSubscriber.statusCode).toBe(200)
      const visible = asSubscriber.json().translations
      expect(visible.map((r: { id: string }) => r.id)).not.toContain(hiddenId)
      // Omitted, not reported: a count of what was withheld is the same leak.
      expect(JSON.stringify(asSubscriber.json())).not.toContain('Unpublished translation')
    })

    it('refuses the anchor a subscriber could not open directly', async () => {
      // Reaching a document sideways must not be easier than opening it.
      const created = await post('editor', draft('sideways'))
      const id = created.json().content.id

      expect(
        (await app.inject({ url: `/content/post/${id}`, cookies: as('subscriber') })).statusCode,
      ).toBe(403)
      expect(
        (await app.inject({ url: `/content/post/${id}/translations`, cookies: as('subscriber') }))
          .statusCode,
      ).toBe(403)
    })
  })

  describe('joining a group is authorized, not merely addressed', () => {
    it('refuses an actor who cannot edit any member', async () => {
      // A group id is not a secret and must never be what grants access.
      const editors = await post('editor', draft('editors-group'))
      const groupId = editors.json().content.translationGroupId

      const response = await post('contributor', {
        locale: 'en',
        slug: uniqueSlug('intruder'),
        title: 'Intruder',
        translationGroupId: groupId,
      })

      expect(response.statusCode).toBe(403)
      expect(response.json().reason).toBe('group-forbidden')
    })

    it('lets a contributor translate their own document', async () => {
      const own = await post('contributor', draft('own-group'))
      const groupId = own.json().content.translationGroupId

      const response = await post('contributor', {
        locale: 'en',
        slug: uniqueSlug('own-translation'),
        title: 'Own translation',
        translationGroupId: groupId,
      })

      expect(response.statusCode).toBe(201)
    })

    it('refuses a contributor once an editor has published their document', async () => {
      /*
       * The gap this closes: editing a live document costs content:publish, so
       * this contributor may no longer touch the only member of the group —
       * but they still hold content:update:own, so a rule phrased in
       * capabilities alone let them keep extending it. Adding a French version
       * of a page you may not edit is that same edit, one step removed.
       */
      const id = await publishedByEditor('translate-live')
      const groupId = (
        await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })
      ).json().content.translationGroupId

      const response = await post('contributor', {
        locale: 'en',
        slug: uniqueSlug('translate-live-en'),
        title: 'Second language',
        translationGroupId: groupId,
      })

      expect(response.statusCode).toBe(403)
      expect(response.json().reason).toBe('group-forbidden')
    })

    it('still lets an author translate their own published document', async () => {
      const created = await post('author', draft('translate-author'))
      const id = created.json().content.id
      expect((await patch('author', id, { status: 'published' })).statusCode).toBe(200)

      const response = await post('author', {
        locale: 'en',
        slug: uniqueSlug('translate-author-en'),
        title: 'Second language',
        translationGroupId: created.json().content.translationGroupId,
      })

      expect(response.statusCode).toBe(201)
    })

    it('tells the editor the same answer it enforces', async () => {
      // The link the admin offers and the request it would send have to agree,
      // or the author finds out on save.
      const live = await publishedByEditor('translate-permission')
      const asContributor = await app.inject({
        url: `/content/post/${live}/translations`,
        cookies: as('contributor'),
      })
      expect(asContributor.statusCode).toBe(200)
      expect(asContributor.json().permissions.create).toBe(false)

      const own = await post('contributor', draft('translate-own'))
      const onDraft = await app.inject({
        url: `/content/post/${own.json().content.id}/translations`,
        cookies: as('contributor'),
      })
      expect(onDraft.json().permissions.create).toBe(true)
    })

    it('answers 422 for a group that does not exist', async () => {
      // Well-formed instructions that cannot be carried out, rather than a
      // conflict with the state of anything that is there.
      const response = await post('editor', {
        locale: 'fr',
        slug: uniqueSlug('nowhere'),
        title: 'Nowhere',
        translationGroupId: '00000000-0000-4000-8000-0000000000ff',
      })

      expect(response.statusCode).toBe(422)
      expect(response.json().reason).toBe('group-not-found')
    })
  })

  describe('translation groups', () => {
    it('refuses a second document in a language the group already holds', async () => {
      const first = await post('editor', draft('group'))
      const groupId = first.json().content.translationGroupId

      const clash = await post('editor', {
        ...draft('group-clash'),
        translationGroupId: groupId,
      })

      expect(clash.statusCode).toBe(409)
      expect(clash.json().reason).toBe('translation-exists')
    })

    it('links a sibling in another language and reports the pair', async () => {
      const first = await post('editor', draft('pair-fr'))
      const groupId = first.json().content.translationGroupId

      const second = await post('editor', {
        locale: 'en',
        slug: uniqueSlug('pair-en'),
        title: 'Title',
        translationGroupId: groupId,
      })
      expect(second.statusCode).toBe(201)

      const pair = await app.inject({
        url: `/content/post/${first.json().content.id}/translations`,
        cookies: as('editor'),
      })
      expect(pair.json().translations.map((row: { locale: string }) => row.locale)).toEqual([
        'en',
        'fr',
      ])
    })
  })

  describe('routing', () => {
    it('answers 404 for a type nobody declared', async () => {
      const response = await app.inject({ url: '/content/widget?locale=fr', cookies: as('editor') })
      expect(response.statusCode).toBe(404)
      expect(response.json().error).toBe('unknown_content_type')
    })

    it('answers 401 without a session, rather than pretending nothing is there', async () => {
      expect((await app.inject({ url: '/content/post?locale=fr' })).statusCode).toBe(401)
    })

    it('lists the declared types so the admin builds navigation from truth', async () => {
      const response = await app.inject({ url: '/content-types', cookies: as('editor') })
      expect(response.json().types.map((t: { name: string }) => t.name)).toEqual(['post', 'page'])
    })
  })

  describe('publishing empties the page cache', () => {
    /**
     * The site collects tags while it renders and this process purges them.
     * The two halves never meet: `cache.invalidate()` runs inside the Astro
     * server, which is not this process and never hears about a write. What is
     * asserted here is the seam — that a write reaches the same Valkey entries
     * the site stored.
     */
    async function cacheAPage(key: string, tags: readonly string[]): Promise<void> {
      /*
       * Past the purge the creation just made. The store refuses an entry
       * whose render began at or before a purge of one of its tags — a tie
       * counts as the purge winning, by design — and creating a document
       * purges its own tag in the same millisecond this fixture would
       * otherwise be written.
       */
      await new Promise((resolve) => setTimeout(resolve, 5))

      const lookup = await pageCache.lookup(key)
      const stored = await pageCache.store(
        key,
        { body: '<p>cached</p>', status: 200, headers: {} },
        { tags: [...tags], renderedFrom: lookup.at },
      )
      expect(stored).toBe(true)
    }

    it('drops the document page when the document is edited', async () => {
      const created = await post('editor', {
        locale: 'en',
        slug: 'cached-doc',
        title: 'Cached document',
        status: 'draft',
      })
      const id = created.json().content.id as string

      await cacheAPage('/en/blog/cached-doc', [contentTag(id)])

      const patched = await patch('editor', id, { title: 'Renamed' })

      expect(patched.statusCode).toBe(200)
      expect((await pageCache.lookup('/en/blog/cached-doc')).hit).toBe(false)
    })

    it('drops it when the document is deleted', async () => {
      const created = await post('editor', {
        locale: 'en',
        slug: 'cached-gone',
        title: 'Cached and gone',
        status: 'draft',
      })
      const id = created.json().content.id as string

      await cacheAPage('/en/blog/cached-gone', [contentTag(id)])

      const deleted = await remove('editor', id)

      expect(deleted.statusCode).toBe(204)
      expect((await pageCache.lookup('/en/blog/cached-gone')).hit).toBe(false)
    })
  })

  describe('preview links', () => {
    /*
     * A preview link is a read, delegated to another process for a few
     * minutes. It is authorized by the same function that authorizes reading
     * the document, and it must never become a permission of its own.
     */
    it('is refused to somebody who may not read the document', async () => {
      const created = await post('contributor', draft('secret-draft'))
      const id = created.json().content.id as string

      const asOther = await app.inject({
        method: 'POST',
        url: `/content/post/${id}/preview`,
        cookies: as('subscriber'),
      })

      expect(asOther.statusCode).toBe(403)
    })

    it('answers 404 for a document that is not of this type', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/content/post/00000000-0000-4000-8000-000000000000/preview',
        cookies: as('editor'),
      })

      expect(response.statusCode).toBe(404)
    })

    it('hands an editor a link that names the document and expires', async () => {
      const created = await post('editor', draft('previewable'))
      const id = created.json().content.id as string

      const response = await app.inject({
        method: 'POST',
        url: `/content/post/${id}/preview`,
        cookies: as('editor'),
      })

      expect(response.statusCode).toBe(200)

      const { url, expiresAt } = response.json().preview
      const locale = created.json().content.locale as string

      // The link opens the document in its own language, whatever the actor's.
      expect(url).toContain(`/${locale}/preview/`)
      expect(url.startsWith('http://127.0.0.1:4321/')).toBe(true)
      expect(verifyPreviewToken(url.split('/preview/')[1] as string, 'x'.repeat(48))).toEqual({
        contentId: id,
        expiresAt: Date.parse(expiresAt),
      })
    })

    it('lets the author of a draft preview their own work', async () => {
      const created = await post('contributor', draft('mine-to-preview'))
      const id = created.json().content.id as string

      const response = await app.inject({
        method: 'POST',
        url: `/content/post/${id}/preview`,
        cookies: as('contributor'),
      })

      expect(response.statusCode).toBe(200)
    })
  })

  describe('what a write announces', () => {
    /*
     * Phase 4's claim, asserted: a first-party feature hears about writes
     * through the same API a third-party plugin will use, and the core
     * announces enough for it to act on.
     */
    it('announces a creation, an edit and a deletion', async () => {
      announced.length = 0

      const created = await post('editor', draft('announced-doc'))
      const id = created.json().content.id as string
      await patch('editor', id, { title: 'Renamed' })
      await remove('editor', id)

      expect(announced.filter((event) => event.id === id).map((event) => event.name)).toEqual([
        'content:created',
        'content:updated',
        'content:deleted',
      ])
    })

    /*
     * "Did this just become visible" is the question every integration asks,
     * and deriving it from a status pair in each of them is how they all get
     * it slightly differently.
     */
    it('says when a document became public, and when it stopped', async () => {
      announced.length = 0

      const created = await post('editor', draft('going-public'))
      const id = created.json().content.id as string

      await patch('editor', id, { status: 'published' })
      const afterPublish = announced.filter((event) => event.id === id).map((e) => e.name)

      await patch('editor', id, { status: 'draft' })
      const afterUnpublish = announced.filter((event) => event.id === id).map((e) => e.name)

      expect(afterPublish).toContain('content:published')
      expect(afterUnpublish).toContain('content:unpublished')
      // An edit that publishes is both events, not one instead of the other.
      expect(afterPublish.filter((name) => name === 'content:updated')).toHaveLength(1)
    })

    it('says nothing about a status that did not change', async () => {
      announced.length = 0

      const created = await post('editor', draft('quiet-edit'))
      const id = created.json().content.id as string
      await patch('editor', id, { title: 'Still a draft' })

      const names = announced.filter((event) => event.id === id).map((event) => event.name)

      expect(names).not.toContain('content:published')
      expect(names).not.toContain('content:unpublished')
    })
  })

  describe('two editors on one document', () => {
    /*
     * The acceptance criterion of the issue this closes: the lock serialized
     * the writes and neither of them was told anything, so the second author's
     * save silently replaced the first author's work.
     */
    it('refuses a save composed against a version that has moved', async () => {
      const created = await post('editor', draft('contested'))
      const id = created.json().content.id as string
      const opened = created.json().content.version as number

      // Both editors opened version 1. The first one saves.
      const first = await patch('editor', id, { title: 'First writer', expectedVersion: opened })
      expect(first.statusCode).toBe(200)

      // The second saves what they were looking at, which is now stale.
      const second = await patch('editor', id, { title: 'Second writer', expectedVersion: opened })

      expect(second.statusCode).toBe(409)
      expect(second.json().reason).toBe('stale-version')

      // And the first writer's work is still there.
      const stored = await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })
      expect(stored.json().content.title).toBe('First writer')
    })

    it('accepts the same save once the client has reloaded', async () => {
      const created = await post('editor', draft('reloaded'))
      const id = created.json().content.id as string

      await patch('editor', id, { title: 'One' })
      const reloaded = await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })

      const again = await patch('editor', id, {
        title: 'Two',
        expectedVersion: reloaded.json().content.version,
      })

      expect(again.statusCode).toBe(200)
      expect(again.json().content.title).toBe('Two')
    })

    it('counts up on every write, so the number means something', async () => {
      const created = await post('editor', draft('counting'))
      const id = created.json().content.id as string

      expect(created.json().content.version).toBe(1)
      expect((await patch('editor', id, { title: 'Second' })).json().content.version).toBe(2)
      expect((await patch('editor', id, { title: 'Third' })).json().content.version).toBe(3)
    })

    /*
     * Without a precondition a client is back to overwriting silently, so
     * forgetting it is a refusal rather than a default.
     */
    it('refuses a save that states no version at all', async () => {
      const created = await post('editor', draft('unversioned'))
      const id = created.json().content.id as string

      const response = await app.inject({
        method: 'PATCH',
        url: `/content/post/${id}`,
        cookies: as('editor'),
        payload: { title: 'No precondition' },
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().reason).toBe('expected_version_required')
    })
  })

  describe('clearing a field rather than leaving it', () => {
    /*
     * A patch omits what it does not touch, so before this there was no way to
     * remove an excerpt: the admin sent no key for an empty field, the merge
     * kept the stored value, and the author watched their deletion do nothing.
     */
    it('removes an excerpt when the field is explicitly emptied', async () => {
      const created = await post('editor', { ...draft('clearable'), excerpt: 'Written' })
      const id = created.json().content.id as string

      expect(created.json().content.excerpt).toBe('Written')

      const cleared = await patch('editor', id, { excerpt: null })

      expect(cleared.statusCode).toBe(200)
      expect(cleared.json().content.excerpt).toBeNull()
    })

    it('leaves it alone when the field is simply absent', async () => {
      const created = await post('editor', { ...draft('kept'), excerpt: 'Written' })
      const id = created.json().content.id as string

      const patched = await patch('editor', id, { title: 'Renamed' })

      expect(patched.json().content.excerpt).toBe('Written')
    })

    it('removes a publication date the same way', async () => {
      const created = await post('editor', {
        ...draft('dated'),
        publishedAt: '2026-09-01T09:00:00.000Z',
      })
      const id = created.json().content.id as string

      const cleared = await patch('editor', id, { publishedAt: null })

      expect(cleared.statusCode).toBe(200)
      expect(cleared.json().content.publishedAt).toBeNull()
    })
  })

  describe('history, and putting a document back', () => {
    async function historyOf(role: string, id: string) {
      const response = await app.inject({
        url: `/content/post/${id}/revisions`,
        cookies: as(role),
      })
      return response
    }

    /*
     * The acceptance criterion: a revision has to carry enough to restore
     * every editorial field. It used to hold the title, the blocks and the
     * metadata, which reads like "the document" until somebody tries.
     */
    it('restores every field the editor could have changed', async () => {
      const created = await post('editor', {
        ...draft('restorable'),
        excerpt: 'The first summary',
      })
      const id = created.json().content.id as string
      const original = created.json().content

      await patch('editor', id, {
        title: 'Renamed',
        slug: 'renamed-entirely',
        excerpt: 'A different summary',
        status: 'published',
        publishedAt: '2026-09-01T09:00:00.000Z',
      })

      const history = await historyOf('editor', id)
      expect(history.statusCode).toBe(200)

      const first = history.json().revisions.at(-1)
      expect(first.version).toBe(1)

      const current = await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })
      const restored = await app.inject({
        method: 'POST',
        url: `/content/post/${id}/revisions/${first.id}/restore`,
        cookies: as('editor'),
        payload: { expectedVersion: current.json().content.version },
      })

      expect(restored.statusCode).toBe(200)

      const document = restored.json().content
      expect(document.title).toBe(original.title)
      expect(document.slug).toBe(original.slug)
      expect(document.excerpt).toBe('The first summary')
      expect(document.status).toBe('draft')
      expect(document.publishedAt).toBeNull()
    })

    /*
     * A restore is an edit, so it leaves a revision of its own — restoring the
     * wrong one has to be undoable too.
     */
    it('records the version it replaced, so a restore can itself be undone', async () => {
      const created = await post('editor', draft('undoable'))
      const id = created.json().content.id as string

      await patch('editor', id, { title: 'Second' })
      const before = (await historyOf('editor', id)).json().revisions.length

      const current = await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })
      const first = (await historyOf('editor', id)).json().revisions.at(-1)

      await app.inject({
        method: 'POST',
        url: `/content/post/${id}/revisions/${first.id}/restore`,
        cookies: as('editor'),
        payload: { expectedVersion: current.json().content.version },
      })

      expect((await historyOf('editor', id)).json().revisions.length).toBe(before + 1)
    })

    /*
     * Reading history is reading earlier versions of the same text. Anything
     * looser would be a way to read a document through its past.
     */
    it('costs exactly what reading the document costs', async () => {
      const created = await post('contributor', draft('private-history'))
      const id = created.json().content.id as string

      expect((await historyOf('subscriber', id)).statusCode).toBe(403)
      expect((await historyOf('contributor', id)).statusCode).toBe(200)
    })

    it('refuses a revision id that belongs to another document', async () => {
      const mine = await post('editor', draft('mine-to-restore'))
      const other = await post('editor', draft('someone-elses'))
      const mineId = mine.json().content.id as string
      const otherId = other.json().content.id as string

      await patch('editor', otherId, { title: 'Changed' })
      const otherRevision = (await historyOf('editor', otherId)).json().revisions[0]

      const current = await app.inject({ url: `/content/post/${mineId}`, cookies: as('editor') })
      const response = await app.inject({
        method: 'POST',
        url: `/content/post/${mineId}/revisions/${otherRevision.id}/restore`,
        cookies: as('editor'),
        payload: { expectedVersion: current.json().content.version },
      })

      expect(response.statusCode).toBe(404)
    })

    /*
     * A restore that bypassed the write rules would be a way to publish — or
     * to take a document down — without the permission either costs.
     */
    it('is refused when the state it would restore is one the actor may not write', async () => {
      const created = await post('contributor', draft('contributor-history'))
      const id = created.json().content.id as string

      await patch('editor', id, { status: 'published' })
      const revisions = (await historyOf('editor', id)).json().revisions
      const draftRevision = revisions.at(-1)

      const current = await app.inject({ url: `/content/post/${id}`, cookies: as('editor') })
      const response = await app.inject({
        method: 'POST',
        url: `/content/post/${id}/revisions/${draftRevision.id}/restore`,
        cookies: as('contributor'),
        payload: { expectedVersion: current.json().content.version },
      })

      // Taking a published document back to a draft costs content:publish,
      // which a contributor does not have.
      expect(response.statusCode).toBe(403)
    })
  })
})
