import { randomUUID } from 'node:crypto'
import { postType } from '@presslabz/core'
import {
  createContent,
  createDb,
  createMedia,
  createSession,
  createUser,
  type Database,
  deleteMedia,
} from '@presslabz/db'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  openBackends,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
  setMediaReferenceSyncState,
} from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { generateSessionToken, hashSessionToken } from '../auth/session.ts'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'

/**
 * What a client is told when a document names an asset that is not there, and
 * what an operator is told when the mirror has never been built.
 *
 * The repository suite proves the constraint refuses; this proves the refusal
 * becomes a status somebody can act on — 422 for a write that names a missing
 * asset, 409 for a deletion of one still in use — and that a server refuses to
 * start against an installation whose reconciliation has not run.
 */
const ready = hasIntegrationEnv()

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
let handle: ReturnType<typeof createDb>
let db: Database
let app: FastifyInstance
let namespace: string
let cookie: string
let cookieName: string

async function asset(): Promise<string> {
  const row = await createMedia(db, {
    storageKey: `media/${randomUUID()}.avif`,
    mimeType: 'image/avif',
    byteSize: 10,
    width: 4,
    height: 4,
    alt: {},
    meta: {},
    uploadedById: null,
  })
  return row.id
}

const imageBlock = (mediaId: string) => ({ id: randomUUID(), type: 'image', mediaId })

describe.skipIf(!ready)('a document that names an asset', () => {
  beforeAll(async () => {
    scratch = await createScratchDatabase('media-refs-api')
    handle = createDb(scratch.url, { maxConnections: 6 })
    db = handle.db

    const user = await createUser(db, {
      email: 'refs@presslabz.test',
      displayName: 'refs',
      role: 'administrator',
      passwordHash: null,
    })
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookie = token
    cookieName = (await import('../auth/session.ts')).SESSION_COOKIE

    namespace = testRateLimitNamespace('media-refs-api')
    const { buildApp } = await import('../app.ts')
    app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
    await app.ready()
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    if (namespace) await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
    await handle?.close()
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  const as = () => ({ [cookieName]: cookie })

  it('accepts a create that names one that exists', async () => {
    const picture = await asset()

    const response = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: as(),
      payload: {
        locale: 'en',
        slug: `ok-${randomUUID()}`,
        title: 'Illustrated',
        blocks: [imageBlock(picture)],
      },
    })

    expect(response.statusCode).toBe(201)
  })

  it('answers 422 for a create that names one that does not', async () => {
    const invented = randomUUID()

    const response = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: as(),
      payload: {
        locale: 'en',
        slug: `missing-${randomUUID()}`,
        title: 'Illustrated by nothing',
        blocks: [imageBlock(invented)],
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      error: 'unprocessable',
      reason: 'media-missing',
      references: [{ mediaId: invented, source: 'block' }],
    })
  })

  it('answers 422 for a featured image that does not exist', async () => {
    const invented = randomUUID()

    const response = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: as(),
      payload: {
        locale: 'en',
        slug: `featured-${randomUUID()}`,
        title: 'Featuring nothing',
        meta: { featuredMediaId: invented },
      },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({
      reason: 'media-missing',
      references: [{ mediaId: invented, source: 'meta', at: 'featuredMediaId' }],
    })
  })

  it('answers 422 for an update that names one that does not', async () => {
    const created = await createContent(db, {
      type: postType,
      locale: 'en',
      authorId: null,
      state: {
        slug: `edit-${randomUUID()}`,
        title: 'Plain',
        status: 'draft',
        blocks: [],
        meta: {},
      },
    })
    const invented = randomUUID()

    const response = await app.inject({
      method: 'PATCH',
      url: `/content/post/${created.id}`,
      cookies: as(),
      payload: { expectedVersion: created.version, blocks: [imageBlock(invented)] },
    })

    expect(response.statusCode).toBe(422)
    expect(response.json()).toMatchObject({ reason: 'media-missing' })
  })

  /*
   * The precedent this follows: a revision keeps the identifiers it was
   * written with, and restoring one whose asset has gone is refused where
   * somebody can act on it — exactly as a revision naming a deleted parent is.
   */
  it('answers 422 for a restore whose asset has since been deleted', async () => {
    const picture = await asset()
    const created = await createContent(db, {
      type: postType,
      locale: 'en',
      authorId: null,
      state: {
        slug: `restore-${randomUUID()}`,
        title: 'Illustrated once',
        status: 'draft',
        blocks: [imageBlock(picture)] as never,
        meta: {},
      },
    })

    // The document stops using it, so the asset can be removed at all.
    const cleared = await app.inject({
      method: 'PATCH',
      url: `/content/post/${created.id}`,
      cookies: as(),
      payload: { expectedVersion: created.version, blocks: [] },
    })
    expect(cleared.statusCode).toBe(200)
    await deleteMedia(db, picture)

    const revisions = await app.inject({
      method: 'GET',
      url: `/content/post/${created.id}/revisions`,
      cookies: as(),
    })
    const revision = revisions.json().revisions[0]

    const restored = await app.inject({
      method: 'POST',
      url: `/content/post/${created.id}/revisions/${revision.id}/restore`,
      cookies: as(),
      payload: { expectedVersion: cleared.json().content.version },
    })

    expect(restored.statusCode).toBe(422)
    expect(restored.json()).toMatchObject({
      reason: 'media-missing',
      references: [{ mediaId: picture, source: 'block' }],
    })
  })
})

/**
 * A server started against a schema whose mirror nobody built.
 *
 * The migration creates the table; something has to fill it. An installation
 * that ran only the first would enforce nothing and look exactly like one that
 * had, which is what the marker exists to make impossible.
 */
describe.skipIf(!ready)('an installation whose references were never reconciled', () => {
  let ownScratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let ownHandle: ReturnType<typeof createDb>
  const started: FastifyInstance[] = []

  beforeAll(async () => {
    ownScratch = await createScratchDatabase('media-refs-pending')
    ownHandle = createDb(ownScratch.url, { maxConnections: 2 })
  }, 60_000)

  afterAll(async () => {
    for (const instance of started.splice(0)) await instance.close()
    await ownHandle?.close()
    await ownScratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  it('refuses to start, says which command to run, and leaves nothing open', async () => {
    await setMediaReferenceSyncState(ownHandle.db, 'pending')

    /*
     * Counted before and after. A refusal that threw while holding the pool it
     * had just opened would leave a backend per attempt behind — and the
     * attempts happen at boot, in a loop, in front of an operator who is
     * restarting the process to see whether it takes this time.
     */
    const before = await openBackends(ownHandle.db)

    const { buildApp } = await import('../app.ts')
    const refused = buildApp({
      databaseUrl: ownScratch.url,
      rateLimitNamespace: testRateLimitNamespace('media-refs-pending'),
    })

    await expect(refused).rejects.toThrow(/db:upgrade|db:reconcile/)

    // The pool it opened is closed; nothing accumulates across attempts.
    const deadline = Date.now() + 5_000
    let after = await openBackends(ownHandle.db)
    while (after > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      after = await openBackends(ownHandle.db)
    }

    expect(after).toBeLessThanOrEqual(before)
  })

  /*
   * Three times, against the level measured beforehand. An absolute ceiling
   * would accept exactly one leaked connection per attempt and call it a pass;
   * what has to be true is that the count comes back to where it started.
   */
  it('leaves nothing open however many times it is refused', async () => {
    await setMediaReferenceSyncState(ownHandle.db, 'pending')
    const before = await openBackends(ownHandle.db)
    const { buildApp } = await import('../app.ts')

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        buildApp({
          databaseUrl: ownScratch.url,
          rateLimitNamespace: testRateLimitNamespace(`media-refs-pending-${attempt}`),
        }),
      ).rejects.toThrow(/db:reconcile/)
    }

    // Bounded, because a pool closes its sockets a moment after it is told to.
    const deadline = Date.now() + 5_000
    let after = await openBackends(ownHandle.db)
    while (after > before && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
      after = await openBackends(ownHandle.db)
    }

    expect(after).toBeLessThanOrEqual(before)
  })

  /* And a database that was empty when it was migrated needs nothing. */
  it('starts against one that was migrated empty', async () => {
    await setMediaReferenceSyncState(ownHandle.db, 'ready')

    const namespaceForRun = testRateLimitNamespace('media-refs-ready')
    const { buildApp } = await import('../app.ts')
    const instance = await buildApp({
      databaseUrl: ownScratch.url,
      rateLimitNamespace: namespaceForRun,
    })
    started.push(instance)

    expect(instance.hasRoute({ method: 'GET', url: '/health' })).toBe(true)
    await dropRateLimitKeys(process.env.VALKEY_URL as string, namespaceForRun)
  })
})
