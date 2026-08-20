import { contentTag, createPageCache, type PageCache } from '@presslabz/cache'
import { createContent, createDb, type Database, findContentById } from '@presslabz/db'
import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import type { Module } from '@presslabz/modules'
import type { FastifyInstance } from 'fastify'
import { Valkey } from 'iovalkey'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { testRateLimitNamespace } from '../testing.ts'

/**
 * The seam the unit tests cannot reach: that the API actually starts the
 * scheduler, that it publishes at boot rather than a minute later, and that
 * what it publishes goes through the same hook a manual publication does.
 *
 * That last part is the one worth a real application. Routing invalidation
 * through the hook API was supposed to mean a scheduled post and a
 * button-pressed one are indistinguishable to every handler; this is where
 * that stops being an intention.
 */
const ready = hasIntegrationEnv()

describe.skipIf(!ready)('a scheduled document on a running API', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let app: FastifyInstance
  let valkey: Valkey
  let cache: PageCache

  const announced: string[] = []
  let dueId: string
  let laterId: string

  beforeAll(async () => {
    scratch = await createScratchDatabase('scheduler')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db

    // Both rows exist before the API starts, so the pass it runs at boot is
    // the one under test.
    const due = await createContent(db, {
      type: 'post',
      locale: 'en',
      authorId: null,
      state: {
        slug: 'due-already',
        title: 'Due already',
        status: 'scheduled',
        blocks: [],
        meta: {},
        publishedAt: new Date(Date.now() - 60_000),
      },
    })
    dueId = due.id

    const later = await createContent(db, {
      type: 'post',
      locale: 'en',
      authorId: null,
      state: {
        slug: 'due-tomorrow',
        title: 'Due tomorrow',
        status: 'scheduled',
        blocks: [],
        meta: {},
        publishedAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      },
    })
    laterId = later.id

    const namespace = testRateLimitNamespace('scheduler')
    const cacheNamespace = `presslabz:test:sched:${namespace}`

    valkey = new Valkey(process.env.VALKEY_URL as string)
    valkey.on('error', () => {})
    cache = createPageCache({ client: valkey, namespace: cacheNamespace })

    /*
     * A page the site would have cached for the document that is about to go
     * live. If the scheduled publication announces itself the way a manual one
     * does, the cache-invalidation module drops this without knowing which of
     * the two it was.
     */
    const lookup = await cache.lookup('/en/blog/due-already')
    await cache.store(
      '/en/blog/due-already',
      { body: '<p>stale</p>', status: 200, headers: {} },
      { tags: [contentTag(dueId)], renderedFrom: lookup.at },
    )

    const recorder: Module = {
      name: 'recorder',
      register: (hooks) =>
        hooks.action('content:published', (payload) => {
          announced.push(payload.id)
        }),
    }

    const { buildApp } = await import('../app.ts')
    app = await buildApp({
      databaseUrl: scratch.url,
      rateLimitNamespace: namespace,
      pageCacheNamespace: cacheNamespace,
      modules: [recorder],
    })
    await app.ready()

    // The pass runs at boot, but it is asynchronous; give it a moment rather
    // than a fixed sleep that is either flaky or slow.
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if ((await findContentById(db, dueId))?.status === 'published') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, 60_000)

  afterAll(async () => {
    await app?.close()
    await cache?.clear()
    await valkey?.quit()
    await handle?.close()
    await scratch?.drop()
  })

  it('publishes what was already due, without waiting for an interval', async () => {
    expect((await findContentById(db, dueId))?.status).toBe('published')
  })

  it('leaves what is not due yet scheduled', async () => {
    expect((await findContentById(db, laterId))?.status).toBe('scheduled')
  })

  it('announces it as a publication, exactly as a manual one is announced', async () => {
    expect(announced).toContain(dueId)
  })

  /*
   * The consequence that matters to a reader: the page the site had cached for
   * that document is gone, so the next request renders the published version
   * rather than the withheld one.
   */
  it('empties the page the site had cached for it', async () => {
    expect((await cache.lookup('/en/blog/due-already')).hit).toBe(false)
  })
})
