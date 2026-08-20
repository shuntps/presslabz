import {
  canEditMedia,
  canPerformOnMedia,
  capabilitiesFor,
  MEDIA_OPERATIONS,
  type MediaPage,
  mediaPageSchema,
  type Role,
} from '@presslabz/core'
import {
  createContent,
  createDb,
  createMedia,
  createSession,
  createUser,
  type Database,
  deleteContent,
  deleteMedia,
  findMediaById,
  forgetOrphan,
  listOrphans,
  type MediaRow,
  storageKeysOf,
} from '@presslabz/db'
import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { generateSessionToken, hashSessionToken } from '../auth/session.ts'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'

/*
 * Against the real MinIO, because what is being asserted is that bytes a
 * client sent do not survive the trip: the object in the bucket is one sharp
 * produced, under a key this server chose, with a content type it set. A fake
 * store would agree with any of that.
 *
 * The database is a scratch one the suite drops afterwards, and the whole API
 * is stood up against it. Ownership is what this file tests, so it needs
 * several accounts — and creating those in the development database left five
 * users and their sessions behind for good, under fixed addresses that two
 * concurrent runs would share. Every object it writes is deleted with the row
 * that named it: the bucket is the one thing a dropped database does not take
 * with it, and a suite that leaks renditions leaks them for the life of the
 * installation.
 */
const ready = hasIntegrationEnv()

/** A real PNG, so sharp has something it can genuinely decode. */
async function samplePng(width = 40, height = 30): Promise<Buffer> {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 40, b: 30 } },
  })
    .png()
    .toBuffer()
}

/** Serialized with the platform's own FormData rather than by hand. */
async function multipart(body: Buffer, filename: string, type: string) {
  const form = new FormData()
  // Blob wants an ArrayBuffer view, and Node's Buffer types no longer
  // satisfy BlobPart directly.
  form.append('file', new Blob([new Uint8Array(body)], { type }), filename)
  const request = new Request('http://localhost', { method: 'POST', body: form })

  return {
    payload: Buffer.from(await request.arrayBuffer()),
    contentType: request.headers.get('content-type') as string,
  }
}

describe.skipIf(!ready)('media routes', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let namespace: string
  let app: FastifyInstance
  let handle: ReturnType<typeof createDb>
  let db: Database
  let cookieName: string
  /**
   * Imported in beforeAll rather than at the top of the file: storage.ts pulls
   * in env.ts, which throws at import time on an incomplete environment. A
   * top-level import turns "this suite is skipped locally" into "this file
   * failed to load".
   */
  let storage: typeof import('./storage.ts')
  const cookies: Record<string, string> = {}
  const ids: Record<string, string> = {}
  const created: string[] = []

  /**
   * The database starts empty, so these are simply created. Ownership is the
   * thing under test, so there has to be more than one person.
   */
  async function signIn(who: string, email: string, role = who) {
    const user = await createUser(db, { email, displayName: who, role, passwordHash: null })
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookies[who] = token
    ids[who] = user.id
    return user
  }

  const as = (who: string) => ({ [cookieName]: cookies[who] as string })

  beforeAll(async () => {
    scratch = await createScratchDatabase('media-routes')
    namespace = testRateLimitNamespace('media-routes')

    const [{ buildApp }, { SESSION_COOKIE }, storageModule] = await Promise.all([
      import('../app.ts'),
      import('../auth/session.ts'),
      import('./storage.ts'),
    ])
    cookieName = SESSION_COOKIE
    storage = storageModule

    app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
    await app.ready()

    handle = createDb(scratch.url, { maxConnections: 5 })
    db = handle.db

    await signIn('subscriber', 'mt-subscriber@presslabz.test')
    await signIn('administrator', 'mt-admin@presslabz.test')
    await signIn('author', 'mt-author@presslabz.test')
    await signIn('editor', 'mt-editor@presslabz.test')
    await signIn('contributor', 'mt-contributor@presslabz.test')
    // A second author, to ask the question ownership exists to answer.
    await signIn('other', 'mt-other@presslabz.test', 'author')
  }, 60_000)

  /**
   * The row and every object it named. Deleting the row alone is what left a
   * rendition in the bucket for every upload this suite has ever made, and the
   * scratch database cannot take those with it.
   */
  afterEach(async () => {
    for (const id of created.splice(0)) {
      const row = await deleteMedia(db, id)
      if (!row) continue
      // The same three steps the route takes, in the same order: the row, the
      // objects it named, then the record that says they were still owed.
      // Skipping the last one leaves this suite's own cleanup listed as a leak.
      await storage.deleteObjects(storageKeysOf(row))
      for (const key of storageKeysOf(row)) await forgetOrphan(db, key)
    }
  })

  /** Which objects the sweep still owes, out of a set this test knows about. */
  async function stillOwed(keys: readonly string[]): Promise<string[]> {
    const listed = new Set((await listOrphans(db, 500)).map((orphan) => orphan.storageKey))
    return keys.filter((key) => listed.has(key)).sort()
  }

  /** The object key behind a served URL: the row's id is not the key's. */
  const keyOf = (url: string) => `media/${url.split('/').pop() as string}`

  afterAll(async () => {
    await handle.close()
    await app.close()
    await scratch.drop()
    // The scratch database goes with a DROP; Valkey keys do not.
    await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
  })

  async function upload(body: Buffer, filename: string, type: string, role = 'administrator') {
    const { payload, contentType } = await multipart(body, filename, type)
    const response = await app.inject({
      method: 'POST',
      url: '/media',
      cookies: as(role),
      headers: { 'content-type': contentType },
      payload,
    })
    if (response.statusCode === 201) created.push(response.json().media.id)
    return response
  }

  /** A row with no object behind it: nothing here reads the bytes. */
  async function assetOwnedBy(uploadedById: string | null) {
    const row = await createMedia(db, {
      storageKey: `media/${crypto.randomUUID()}.avif`,
      mimeType: 'image/avif',
      byteSize: 512,
      width: 10,
      height: 10,
      alt: {},
      meta: {},
      uploadedById,
    })
    created.push(row.id)
    return row
  }

  /** `alt` is a patch by language: a string sets one, null removes one. */
  async function describeAs(role: string, id: string, alt: Record<string, string | null>) {
    return app.inject({
      method: 'PATCH',
      url: `/media/${id}`,
      cookies: as(role),
      payload: { alt },
    })
  }

  const library = async (role: string) => app.inject({ url: '/media', cookies: as(role) })

  /**
   * The library, parsed with the contract the admin parses it with, so a field
   * this route stops sending fails here rather than in the picker.
   */
  async function page(role: string, query: { limit?: number; cursor?: string } = {}) {
    const search = new URLSearchParams()
    if (query.limit !== undefined) search.set('limit', String(query.limit))
    if (query.cursor !== undefined) search.set('cursor', query.cursor)

    const response = await app.inject({ url: `/media?${search.toString()}`, cookies: as(role) })
    expect(response.statusCode, `library for ${role}`).toBe(200)
    return mediaPageSchema.parse(response.json())
  }

  it('re-encodes an upload into the formats it serves', async () => {
    const response = await upload(await samplePng(), 'photo.png', 'image/png')

    expect(response.statusCode).toBe(201)
    const media = response.json().media

    expect(media.mimeType).toBe('image/avif')
    expect(media.width).toBe(40)
    expect(media.height).toBe(30)
    expect(media.renditions.map((r: { name: string }) => r.name).sort()).toEqual(['avif', 'webp'])
  })

  it('names the object itself, whatever the client called the file', async () => {
    // A filename is a string the client chose. Letting it reach a key is how
    // "../../etc/passwd" and "shell.php.png" become interesting.
    const response = await upload(await samplePng(), '../../shell.php.png', 'image/png')

    expect(response.statusCode).toBe(201)
    const url: string = response.json().media.url
    expect(url).not.toContain('shell')
    expect(url).not.toContain('..')
    expect(url).toMatch(/\/media\/[0-9a-f-]{36}\.avif$/)
  })

  it('serves what it stored, publicly and as an image', async () => {
    const response = await upload(await samplePng(), 'photo.png', 'image/png')
    const url: string = response.json().media.url

    // Public on purpose: a signed URL expires and a page cached at the edge
    // would outlive the links inside it.
    const fetched = await fetch(url)
    expect(fetched.status).toBe(200)
    expect(fetched.headers.get('content-type')).toBe('image/avif')
    expect(fetched.headers.get('cache-control')).toContain('immutable')
  })

  it('refuses a document dressed as an image', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    )
    expect((await upload(svg, 'x.svg', 'image/svg+xml')).statusCode).toBe(415)
    // And the same bytes with a type the server does accept: sharp decides,
    // not the header.
    expect((await upload(svg, 'x.png', 'image/png')).statusCode).toBe(415)
  })

  it('refuses bytes that are not an image at all', async () => {
    const notAnImage = Buffer.from('MZ\u0090\u0000\u0003'.repeat(200))
    expect((await upload(notAnImage, 'x.png', 'image/png')).statusCode).toBe(415)
  })

  it('drops the EXIF orientation by applying it', async () => {
    // Stored sideways is the classic outcome of re-encoding without this: the
    // pixels and the tag that corrects them are separate, and only one
    // survives.
    const rotated = await sharp({
      create: { width: 60, height: 20, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    const response = await upload(rotated, 'rotated.jpg', 'image/jpeg')
    expect(response.statusCode).toBe(201)
    // Orientation 6 means "rotate 90°", so a 60×20 source is stored 20×60.
    expect(response.json().media.width).toBe(20)
    expect(response.json().media.height).toBe(60)
  })

  it('lists what has been uploaded', async () => {
    await upload(await samplePng(), 'photo.png', 'image/png')

    const response = await app.inject({ url: '/media', cookies: as('administrator') })
    expect(response.statusCode).toBe(200)
    expect(response.json().media.length).toBeGreaterThan(0)
  })

  it('asks for a capability before accepting anything', async () => {
    const { payload, contentType } = await multipart(await samplePng(), 'p.png', 'image/png')
    const response = await app.inject({
      method: 'POST',
      url: '/media',
      headers: { 'content-type': contentType },
      payload,
    })
    expect(response.statusCode).toBe(401)
  })

  it('takes every rendition with the row when an asset is deleted', async () => {
    /*
     * The row is one of two things an upload creates. Deleting it and leaving
     * the objects is how a bucket ends up holding hundreds of renditions no
     * row names — including, until this suite was isolated, one pair for every
     * upload it had ever made.
     */
    const uploaded = await upload(await samplePng(), 'photo.png', 'image/png')
    const media = uploaded.json().media
    const urls: string[] = media.renditions.map((r: { url: string }) => r.url)
    expect(urls).toHaveLength(2)

    for (const url of urls) expect((await fetch(url)).status).toBe(200)

    const removed = await app.inject({
      method: 'DELETE',
      url: `/media/${media.id}`,
      cookies: as('administrator'),
    })
    expect(removed.statusCode).toBe(204)

    for (const url of urls) expect((await fetch(url)).status).toBe(404)
  })

  describe('adding to the library is a permission the listing reports', () => {
    it('says yes to somebody who may upload', async () => {
      // Without this the picker showed its upload control to everyone, and a
      // contributor who chose a file was answered 403 and told the file was
      // not an image — a refusal about them, reported as a fault in the file.
      for (const who of ['administrator', 'author', 'editor']) {
        const response = await library(who)
        expect(response.statusCode).toBe(200)
        expect(response.json().permissions.upload).toBe(true)
      }
    })

    it('says no to somebody who may not', async () => {
      const response = await library('contributor')
      expect(response.statusCode).toBe(200)
      expect(response.json().permissions.upload).toBe(false)
    })

    it('and means it: the upload itself is still refused', async () => {
      const { payload, contentType } = await multipart(await samplePng(), 'p.png', 'image/png')
      const response = await app.inject({
        method: 'POST',
        url: '/media',
        cookies: as('contributor'),
        headers: { 'content-type': contentType },
        payload,
      })
      expect(response.statusCode).toBe(403)
    })
  })

  describe('what the declaration says is what the routes do', () => {
    /*
     * The guards used to name capabilities in string literals while the
     * permissions the interface is sent were computed from MEDIA_ACCESS. Two
     * expressions of one rule, agreeing right up until the declaration moved:
     * an `own` variant added to an operation, or a capability renamed, would
     * change what the listing reports and leave what the route accepts exactly
     * where it was.
     *
     * These tests do not assert what the answer is. They assert that the two
     * places that answer it agree — which holds for whatever MEDIA_ACCESS is
     * edited to say, and fails the moment one of them stops following it.
     */
    const ROLES = ['subscriber', 'contributor', 'author', 'editor', 'administrator'] as const

    const actorFor = (who: (typeof ROLES)[number]) => ({
      capabilities: capabilitiesFor(who as Role),
      id: ids[who] as string,
    })

    /**
     * What each operation answers when it is allowed.
     *
     * Named rather than inferred from "not 403", because "not refused" is not
     * "accepted": a 400 from a malformed request, a 401 from a session this
     * suite forgot to send, or a 500 from a broken handler would all read as
     * success and quietly turn a permission test into a test of nothing.
     */
    const ACCEPTED = { read: 200, upload: 201, update: 200, delete: 204 } as const
    const REFUSED = 403

    it('accepts exactly the operations the declaration allows, for every role', async () => {
      const attempt = {
        read: (who: string) => library(who),
        upload: async (who: string) =>
          upload(await samplePng(), 'permission.png', 'image/png', who),
        delete: async (who: string) => {
          const row = await assetOwnedBy(null)
          return app.inject({ method: 'DELETE', url: `/media/${row.id}`, cookies: as(who) })
        },
      }

      for (const who of ROLES) {
        for (const operation of MEDIA_OPERATIONS) {
          // `update` depends on the row, so a route guard cannot answer it; it
          // has its own comparison below.
          if (operation === 'update') continue

          const allowed = canPerformOnMedia(operation, actorFor(who))
          const response = await attempt[operation](who)

          expect(response.statusCode, `${who} / ${operation}`).toBe(
            allowed ? ACCEPTED[operation] : REFUSED,
          )
        }
      }
    })

    it('reports the upload permission it is about to enforce, for every role', async () => {
      // Serialized conclusion against accepted operation, compared to each
      // other rather than both to a third source: this cannot pass while the
      // interface is told one thing and the route does another.
      for (const who of ROLES) {
        const listing = await library(who)
        const mayRead = canPerformOnMedia('read', actorFor(who))
        expect(listing.statusCode, `${who} / read`).toBe(mayRead ? ACCEPTED.read : REFUSED)
        // Nothing is reported to somebody who may not read the library.
        if (!mayRead) continue

        const reported: boolean = listing.json().permissions.upload
        const attempted = await upload(await samplePng(), 'reported.png', 'image/png', who)

        expect(attempted.statusCode, `${who} / upload reported as ${reported}`).toBe(
          reported ? ACCEPTED.upload : REFUSED,
        )
      }
    })

    it('reports the describe permission it is about to enforce, row by row', async () => {
      const rows = [
        await assetOwnedBy(ids.author as string),
        await assetOwnedBy(ids.other as string),
        // Owned by nobody, which is what an uploader's deleted account leaves.
        await assetOwnedBy(null),
      ]

      for (const who of ROLES) {
        const listing = await library(who)
        const mayRead = canPerformOnMedia('read', actorFor(who))
        expect(listing.statusCode, `${who} / read`).toBe(mayRead ? ACCEPTED.read : REFUSED)
        if (!mayRead) continue

        const reported: Record<string, boolean> = Object.fromEntries(
          listing
            .json()
            .media.map((item: { id: string; permissions: { update: boolean } }) => [
              item.id,
              item.permissions.update,
            ]),
        )

        for (const row of rows) {
          const attempted = await describeAs(who, row.id, { en: 'A description' })

          expect(attempted.statusCode, `${who} / update ${row.id}`).toBe(
            reported[row.id] ? ACCEPTED.update : REFUSED,
          )
          // And the same answer the declaration gives, so neither side is
          // simply wrong in the same direction.
          expect(reported[row.id], `${who} / declared for ${row.id}`).toBe(
            canEditMedia(actorFor(who), row),
          )
        }
      }
    })
  })

  describe('describing an asset belongs to whoever uploaded it', () => {
    it('lets an author describe their own upload', async () => {
      const row = await assetOwnedBy(ids.author as string)

      const response = await describeAs('author', row.id, { fr: 'Un vélo rouge' })
      expect(response.statusCode).toBe(200)
      expect(response.json().media.alt).toEqual({ fr: 'Un vélo rouge' })
      expect((await findMediaById(db, row.id))?.alt).toEqual({ fr: 'Un vélo rouge' })
    })

    it('refuses another author, and writes nothing', async () => {
      /*
       * The hole this closes: the route asked for media:upload, which every
       * author holds, so anyone who could add an image could rewrite the
       * description of every asset in the library.
       */
      const row = await assetOwnedBy(ids.author as string)

      const response = await describeAs('other', row.id, { fr: 'Détourné' })
      expect(response.statusCode).toBe(403)
      expect(response.json().reason).toBe('media-forbidden')
      expect((await findMediaById(db, row.id))?.alt).toEqual({})
    })

    it('lets an editor describe anything', async () => {
      const row = await assetOwnedBy(ids.author as string)
      expect((await describeAs('editor', row.id, { en: 'A bicycle' })).statusCode).toBe(200)
    })

    it('refuses a contributor, who may not put anything in the library either', async () => {
      const row = await assetOwnedBy(ids.contributor as string)
      expect((await describeAs('contributor', row.id, { en: 'Mine' })).statusCode).toBe(403)
    })

    it('needs the global capability once the uploader’s account is gone', async () => {
      // uploadedById is set to null when the account goes. Treating "owned by
      // nobody" as "owned by whoever is asking" would hand every orphaned
      // asset to every author.
      const orphan = await assetOwnedBy(null)

      expect((await describeAs('author', orphan.id, { en: 'Claimed' })).statusCode).toBe(403)
      expect((await describeAs('editor', orphan.id, { en: 'Adopted' })).statusCode).toBe(200)
    })

    it('answers 404 for an asset that is not there, without saying more', async () => {
      const response = await describeAs('editor', crypto.randomUUID(), { en: 'Nowhere' })
      expect(response.statusCode).toBe(404)
    })

    it('answers 401 without a session', async () => {
      const row = await assetOwnedBy(ids.author as string)
      const response = await app.inject({
        method: 'PATCH',
        url: `/media/${row.id}`,
        payload: { alt: { en: 'Anonymous' } },
      })
      expect(response.statusCode).toBe(401)
    })

    it('tells the library which assets this actor may describe', async () => {
      // What the picker greys out. Server-decided, because whether
      // media:update:own is enough depends on who uploaded the row.
      const mine = await assetOwnedBy(ids.author as string)
      const theirs = await assetOwnedBy(ids.other as string)

      const listing = await app.inject({ url: '/media', cookies: as('author') })
      const rows: { id: string; permissions: { update: boolean } }[] = listing.json().media

      expect(rows.find((row) => row.id === mine.id)?.permissions.update).toBe(true)
      expect(rows.find((row) => row.id === theirs.id)?.permissions.update).toBe(false)

      const asEditor = await app.inject({ url: '/media', cookies: as('editor') })
      const editorRows: { id: string; permissions: { update: boolean } }[] = asEditor.json().media
      expect(editorRows.find((row) => row.id === theirs.id)?.permissions.update).toBe(true)
    })

    it('changes one language and leaves the others where they were', async () => {
      /*
       * Two people describing the same image in two languages. The second
       * request is prepared from a state that predates the first, which is the
       * ordinary case — an open dialogue is a stale snapshot. Sending the whole
       * map would make this second write delete the first.
       */
      const row = await assetOwnedBy(ids.author as string)

      expect((await describeAs('author', row.id, { en: 'A red bicycle' })).statusCode).toBe(200)
      const second = await describeAs('author', row.id, { fr: 'Un vélo rouge' })

      expect(second.statusCode).toBe(200)
      expect(second.json().media.alt).toEqual({ en: 'A red bicycle', fr: 'Un vélo rouge' })
    })

    it('removes a description when it is set to null', async () => {
      // An empty description is an absent one, not an empty string a screen
      // reader has to announce.
      const row = await assetOwnedBy(ids.author as string)
      await describeAs('author', row.id, { en: 'A red bicycle', fr: 'Un vélo rouge' })

      const cleared = await describeAs('author', row.id, { fr: null })
      expect(cleared.json().media.alt).toEqual({ en: 'A red bicycle' })
    })

    it('refuses a language this installation does not serve', async () => {
      const row = await assetOwnedBy(ids.author as string)
      expect((await describeAs('author', row.id, { de: 'Ein Fahrrad' })).statusCode).toBe(400)
    })

    it('says an upload belongs to the person who made it', async () => {
      const response = await upload(await samplePng(), 'photo.png', 'image/png', 'author')
      expect(response.statusCode).toBe(201)
      expect(response.json().media.permissions.update).toBe(true)

      const seenByOther = await app.inject({ url: '/media', cookies: as('other') })
      const row = seenByOther
        .json()
        .media.find((item: { id: string }) => item.id === response.json().media.id)
      expect(row.permissions.update).toBe(false)
    })
  })

  describe('what the pipeline will not take', () => {
    /*
     * Both of these were accepted before, in the way that is worse than a
     * refusal: an animation was stored as its first frame, so the upload
     * appeared to work and was not what the author sent, and a header claiming
     * nine hundred megapixels was refused by the decoder with "that file is
     * not an image", about a file that is.
     */

    /** Eighty-five bytes of real GIF89a: two frames, one pixel each. */
    const ANIMATED_GIF = Buffer.from(
      'R0lGODlhAQABAIAAAAAAAP///yH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAQABAAACAkQBACH5BAAKAAAALAAAAAABAAEAAAICRAEAOw==',
      'base64',
    )

    it('refuses an animation, and says that is what it was', async () => {
      const response = await upload(ANIMATED_GIF, 'loop.gif', 'image/gif')

      expect(response.statusCode).toBe(415)
      expect(response.json().reason).toBe('animated')
    })

    it('refuses a header that claims more pixels than the bytes will decode', async () => {
      // A byte count bounds the download and says nothing about what the bytes
      // decode to; this is a few hundred bytes claiming 30000×30000.
      const bomb = await samplePng(4, 4)
      bomb.writeUInt32BE(30_000, 16)
      bomb.writeUInt32BE(30_000, 20)

      const response = await upload(bomb, 'bomb.png', 'image/png')

      expect(response.statusCode).toBe(415)
      expect(response.json().reason).toBe('too-many-pixels')
    })

    it('leaves nothing behind when it refuses', async () => {
      const before = (await library('administrator')).json().media.length
      const owed = (await listOrphans(db, 500)).length

      await upload(ANIMATED_GIF, 'loop.gif', 'image/gif')

      expect((await library('administrator')).json().media.length).toBe(before)
      expect(owed).toBe((await listOrphans(db, 500)).length)
    })
  })

  describe('deleting an asset a document uses', () => {
    /**
     * A document that puts the asset in a block, which is where a picker puts
     * it. `meta.featuredMediaId` is the other half, and the reference query
     * answers for both.
     */
    async function documentUsing(media: string, where: 'blocks' | 'meta', title: string) {
      return createContent(db, {
        type: 'post',
        locale: 'en',
        authorId: null,
        state: {
          slug: `uses-${crypto.randomUUID()}`,
          title,
          status: 'published',
          blocks:
            where === 'blocks'
              ? [{ id: crypto.randomUUID(), type: 'image' as const, mediaId: media }]
              : [],
          meta: where === 'meta' ? { featuredMediaId: media } : {},
          publishedAt: new Date(),
        },
      })
    }

    /*
     * The failure this closes is not an error anybody saw: a published article
     * lost its illustration because somebody tidied the library, and the hole
     * appeared on the site.
     */
    it('refuses, and names the documents that would break', async () => {
      const uploaded = await upload(await samplePng(), 'used.png', 'image/png')
      const media = uploaded.json().media
      await documentUsing(media.id, 'blocks', 'An article with a picture')

      const response = await app.inject({
        method: 'DELETE',
        url: `/media/${media.id}`,
        cookies: as('administrator'),
      })

      expect(response.statusCode).toBe(409)
      expect(response.json().reason).toBe('media-in-use')
      // Named, because "in use" is not actionable and "in use by this" is.
      expect(response.json().references).toHaveLength(1)
      expect(response.json().references[0]).toMatchObject({
        title: 'An article with a picture',
        type: 'post',
        locale: 'en',
        where: ['blocks'],
      })
    })

    it('counts a featured image too', async () => {
      const uploaded = await upload(await samplePng(), 'featured.png', 'image/png')
      const media = uploaded.json().media
      await documentUsing(media.id, 'meta', 'An article with a cover')

      const response = await app.inject({
        method: 'DELETE',
        url: `/media/${media.id}`,
        cookies: as('administrator'),
      })

      expect(response.json().references[0]?.where).toEqual(['meta'])
    })

    it('keeps the row and the bytes exactly where they were', async () => {
      const uploaded = await upload(await samplePng(), 'kept.png', 'image/png')
      const media = uploaded.json().media
      await documentUsing(media.id, 'blocks', 'Still using it')

      await app.inject({
        method: 'DELETE',
        url: `/media/${media.id}`,
        cookies: as('administrator'),
      })

      expect(await findMediaById(db, media.id)).not.toBeNull()
      for (const rendition of media.renditions) {
        expect((await fetch(rendition.url)).status).toBe(200)
      }
      // A refusal is not a deletion, so nothing is owed to the sweep.
      expect(await stillOwed(media.renditions.map((r: { url: string }) => keyOf(r.url)))).toEqual(
        [],
      )
    })

    it('accepts once nothing uses it any more', async () => {
      const uploaded = await upload(await samplePng(), 'freed.png', 'image/png')
      const media = uploaded.json().media
      const document = await documentUsing(media.id, 'blocks', 'Temporarily using it')

      await deleteContent(db, document.id)

      const response = await app.inject({
        method: 'DELETE',
        url: `/media/${media.id}`,
        cookies: as('administrator'),
      })

      expect(response.statusCode).toBe(204)
    })
  })

  describe('what a delete owes the object store', () => {
    it('owes nothing once the store has answered', async () => {
      const uploaded = await upload(await samplePng(), 'clean.png', 'image/png')
      const media = uploaded.json().media

      const removed = await app.inject({
        method: 'DELETE',
        url: `/media/${media.id}`,
        cookies: as('administrator'),
      })

      expect(removed.statusCode).toBe(204)
      // The row named two objects; both are gone, so neither is still owed.
      const keys = media.renditions.map((r: { url: string }) => keyOf(r.url))
      expect(keys).toHaveLength(2)
      expect(await stillOwed(keys)).toEqual([])
      for (const rendition of media.renditions) {
        expect((await fetch(rendition.url)).status).toBe(404)
      }
    })

    /*
     * The store is a separate system and the transaction cannot include it, so
     * the record of what it still owns is written where it is atomic — with
     * the row's deletion. This asserts that half directly, because a store
     * that fails is not something this suite can arrange against a real MinIO.
     */
    it('lists every object when the store is not reachable', async () => {
      const uploaded = await upload(await samplePng(), 'stranded.png', 'image/png')
      const media = uploaded.json().media

      const row = await deleteMedia(db, media.id)
      expect(row).not.toBeNull()

      expect(await stillOwed(storageKeysOf(row as MediaRow))).toEqual(
        storageKeysOf(row as MediaRow).sort(),
      )

      // And this suite still owns the bytes.
      await storage.deleteObjects(storageKeysOf(row as MediaRow))
      for (const key of storageKeysOf(row as MediaRow)) await forgetOrphan(db, key)
    })
  })

  describe('the library arrives one page at a time', () => {
    /*
     * Before this, the picker asked for everything and the repository capped
     * it at sixty rows with no way to ask for the rest: the sixty-first upload
     * was in the bucket, in the database, and unreachable from the interface
     * that put it there.
     */
    it('walks the whole library without repeating or losing an asset', async () => {
      for (let index = 0; index < 5; index += 1) {
        expect((await upload(await samplePng(), `page-${index}.png`, 'image/png')).statusCode).toBe(
          201,
        )
      }

      const expected = (await page('administrator', { limit: 100 })).media.map((row) => row.id)
      expect(expected.length).toBeGreaterThanOrEqual(5)

      const seen: string[] = []
      let cursor: string | null = null
      let pages = 0

      do {
        const current: MediaPage = await page('administrator', {
          limit: 2,
          ...(cursor ? { cursor } : {}),
        })
        seen.push(...current.media.map((row) => row.id))
        cursor = current.nextCursor
        pages += 1
      } while (cursor && pages < 20)

      expect(seen).toEqual(expected)
      expect(new Set(seen).size).toBe(seen.length)
    })

    it('says there is nothing after the last page', async () => {
      await upload(await samplePng(), 'last.png', 'image/png')
      expect((await page('administrator', { limit: 100 })).nextCursor).toBeNull()
    })

    /*
     * An upload landing while the picker is open shifts every offset by one.
     * Against a fixed row, the page after it is the same page whatever
     * arrived in the meantime.
     */
    it('does not repeat an asset when one is uploaded between two pages', async () => {
      for (let index = 0; index < 4; index += 1) {
        await upload(await samplePng(), `between-${index}.png`, 'image/png')
      }

      const first = await page('administrator', { limit: 2 })
      await upload(await samplePng(), 'arrived-late.png', 'image/png')

      const second = await page('administrator', {
        limit: 2,
        cursor: first.nextCursor as string,
      })

      const firstIds = first.media.map((row) => row.id)
      expect(second.media.map((row) => row.id).filter((id) => firstIds.includes(id))).toEqual([])
    })

    it('refuses a cursor it did not issue', async () => {
      const response = await app.inject({
        url: '/media?cursor=not-a-cursor',
        cookies: as('administrator'),
      })

      expect(response.statusCode).toBe(400)
      expect(response.json().reason).toBe('bad-cursor')
    })
  })
})
