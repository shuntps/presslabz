import {
  createDb,
  createSession,
  createUser,
  type Database,
  deleteContent,
  findUserByEmail,
} from '@presslabz/db'
import { hasIntegrationEnv } from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateSessionToken, hashSessionToken } from '../auth/session.ts'

/*
 * These drive the real routes against the real database, because the thing
 * being asserted is the authorization path: which capability a status
 * transition costs, and whether the check happens against the row the write
 * actually lands on. A mocked repository would let every one of these pass
 * while the bug stayed.
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
  let app: FastifyInstance
  let handle: ReturnType<typeof createDb>
  let db: Database
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}
  const created: string[] = []
  let cookieName: string

  /**
   * Fixed addresses, reused across runs. Creating a fresh user each time
   * would either collide on the unique email or accumulate rows that no
   * repository function exists to remove yet.
   */
  async function signIn(role: string, email: string) {
    const user =
      (await findUserByEmail(db, email)) ??
      (await createUser(db, { email, displayName: role, role, passwordHash: null }))
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookies[role] = token
    ids[role] = user.id
    return user
  }

  const as = (role: string) => ({ [cookieName]: cookies[role] as string })

  beforeAll(async () => {
    // env.ts throws at import time when the environment is incomplete, so the
    // app is imported only once the suite knows it can run.
    const [{ buildApp }, { SESSION_COOKIE }] = await Promise.all([
      import('../app.ts'),
      import('../auth/session.ts'),
    ])
    cookieName = SESSION_COOKIE

    app = await buildApp()
    await app.ready()

    handle = createDb(process.env.DATABASE_URL as string, { maxConnections: 5 })
    db = handle.db

    await signIn('subscriber', 'rt-subscriber@presslabz.test')
    await signIn('contributor', 'rt-contributor@presslabz.test')
    await signIn('author', 'rt-author@presslabz.test')
    await signIn('editor', 'rt-editor@presslabz.test')
  })

  afterEach(async () => {
    for (const id of created.splice(0)) await deleteContent(db, id)
  })

  afterAll(async () => {
    await handle.close()
    await app.close()
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

  async function patch(role: string, id: string, body: Record<string, unknown>) {
    return app.inject({
      method: 'PATCH',
      url: `/content/post/${id}`,
      cookies: as(role),
      payload: body,
    })
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
})
