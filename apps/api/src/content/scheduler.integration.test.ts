import { contentTag, createPageCache, type PageCache } from '@presslabz/cache'
import { postType } from '@presslabz/core'
import {
  createContent,
  createDb,
  type Database,
  findContentById,
  listRevisions,
} from '@presslabz/db'
import {
  backendsWaitingOnLocks,
  createScratchDatabase,
  hasIntegrationEnv,
  holdContentRow,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
  settle,
} from '@presslabz/db/testing'
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
      type: postType,
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
      type: postType,
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
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  it('publishes what was already due, without waiting for an interval', async () => {
    expect((await findContentById(db, dueId))?.status).toBe('published')
  })

  it('leaves what is not due yet scheduled', async () => {
    expect((await findContentById(db, laterId))?.status).toBe('scheduled')
  })

  it('announces it as a publication, exactly as a manual one is announced', async () => {
    // Counted, not searched for: `toContain` is true of one announcement and
    // of five, and the number is the property.
    expect(announced.filter((id) => id === dueId)).toHaveLength(1)
    expect(announced).not.toContain(laterId)
  })

  /* A publication is a write, so it leaves the trace every write leaves. */
  it('versions the document once and records what it superseded', async () => {
    const row = await findContentById(db, dueId)

    expect(row?.version).toBe(2)

    const revisions = await listRevisions(db, dueId)
    expect(revisions).toHaveLength(1)
    expect(revisions[0]).toMatchObject({ status: 'scheduled', version: 1 })
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

/**
 * Two API instances, one document, one publication.
 *
 * The production shape: several processes on their own timers, each running a
 * pass at boot. The guarantee is not that one of them wins a race — it is that
 * the loser takes nothing, so every handler hears about the publication once.
 * A handler told twice sends two emails, posts twice to a feed, and burns a
 * webhook budget on an event that happened once.
 *
 * Built concurrently on purpose, so the two boot passes genuinely overlap.
 */
describe.skipIf(!ready)('two API instances sharing one database', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let apps: FastifyInstance[] = []
  let valkey: Valkey
  let cache: PageCache

  /** Every announcement either instance made, labelled by which one. */
  const heard: { instance: string; id: string }[] = []
  let dueId: string
  /** What was true while both instances were blocked on the held row. */
  let blockedState: string | null = null
  let blockedAnnouncements = -1
  let blockedBackends = 0

  beforeAll(async () => {
    scratch = await createScratchDatabase('scheduler-pair')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db

    const due = await createContent(db, {
      type: postType,
      locale: 'en',
      authorId: null,
      state: {
        slug: 'due-for-both',
        title: 'Due for both',
        status: 'scheduled',
        blocks: [],
        meta: {},
        publishedAt: new Date(Date.now() - 60_000),
      },
    })
    dueId = due.id

    const namespace = testRateLimitNamespace('scheduler-pair')
    const cacheNamespace = `presslabz:test:sched-pair:${namespace}`

    valkey = new Valkey(process.env.VALKEY_URL as string)
    valkey.on('error', () => {})
    cache = createPageCache({ client: valkey, namespace: cacheNamespace })

    const lookup = await cache.lookup('/en/blog/due-for-both')
    await cache.store(
      '/en/blog/due-for-both',
      { body: '<p>stale</p>', status: 200, headers: {} },
      { tags: [contentTag(dueId)], renderedFrom: lookup.at },
    )

    const recorder = (instance: string): Module => ({
      name: `recorder-${instance}`,
      register: (hooks) =>
        hooks.action('content:published', (payload) => {
          heard.push({ instance, id: payload.id })
        }),
    })

    /*
     * The row is taken and held before either instance exists, so both boot
     * passes are still waiting on it when they start. Building the two
     * concurrently and hoping they overlap proves nothing: the first can be
     * finished before the second begins, and the assertion below would pass
     * without anything ever having raced.
     *
     * The scheduler's boot pass is fire-and-forget, so `ready()` does not wait
     * on it — the applications come up while their passes are blocked.
     */
    const release = await holdContentRow(db, dueId)

    const { buildApp } = await import('../app.ts')
    apps = await Promise.all(
      ['one', 'two'].map((instance) =>
        buildApp({
          databaseUrl: scratch.url,
          rateLimitNamespace: `${namespace}:${instance}`,
          pageCacheNamespace: cacheNamespace,
          modules: [recorder(instance)],
        }),
      ),
    )
    await Promise.all(apps.map((app) => app.ready()))

    try {
      /*
       * Waited for rather than assumed. "It had time and did nothing" is also
       * true of a pass that never started, so what is observed here is the
       * database's own answer: how many backends are blocked on a lock.
       */
      const deadline = Date.now() + 5_000
      while (Date.now() < deadline) {
        blockedBackends = await backendsWaitingOnLocks(db)
        if (blockedBackends >= 2) break
        await settle()
      }

      blockedState = (await findContentById(db, dueId))?.status ?? null
      blockedAnnouncements = heard.length
    } finally {
      // Released whatever the observation above found: a failed assertion must
      // not leave two applications waiting on a lock nobody drops.
      await release()
    }

    /*
     * Waited for by condition rather than by clock. A fixed pause is a bet
     * that a hook and a cache round trip fit inside it, and on a loaded CI
     * runner that bet fails as a test failure about something else entirely.
     *
     * All three consequences of the publication are polled together — the row,
     * the announcement, the cache — so the assertions below run against a
     * settled state rather than a partly-arrived one. That the announcement is
     * *only* one is asserted there, not here; leaving early on the first is
     * safe because a second claim is already ruled out by the version and the
     * single revision.
     */
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      const row = await findContentById(db, dueId)
      const announcements = heard.filter((entry) => entry.id === dueId).length
      const stillCached = (await cache.lookup('/en/blog/due-for-both')).hit

      if (row?.status === 'published' && announcements === 1 && !stillCached) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, 60_000)

  afterAll(async () => {
    await Promise.all(apps.map((app) => app?.close()))
    await cache?.clear()
    await valkey?.quit()
    await handle?.close()
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /*
   * The overlap itself, asserted rather than hoped for. If either instance had
   * got past the lock, this is where it would show.
   */
  it('has both instances waiting, publishing nothing, while the row is held', () => {
    // Two backends blocked on a lock: one boot pass per application.
    expect(blockedBackends).toBeGreaterThanOrEqual(2)
    expect(blockedState).toBe('scheduled')
    expect(blockedAnnouncements).toBe(0)
  })

  it('publishes it once, whichever instance got there first', async () => {
    const row = await findContentById(db, dueId)

    expect(row?.status).toBe('published')
    // Claimed twice would be 3.
    expect(row?.version).toBe(2)
    expect(await listRevisions(db, dueId)).toHaveLength(1)
  })

  it('announces it exactly once across both instances', async () => {
    expect(heard.filter((entry) => entry.id === dueId)).toHaveLength(1)
  })

  /*
   * What this asserts is that the page is gone, which is what a reader
   * experiences. It does **not** count purges: a second purge of an
   * already-empty entry would look exactly like this, and there is no counter
   * here to tell them apart — putting one in would mean threading a recording
   * cache through production code for the benefit of a test.
   *
   * That the purge happened once is a deduction from two measured facts, not
   * an observation: this suite counts exactly one `content:published` across
   * both instances, and `packages/modules/src/modules.test.ts` counts the
   * invalidation module's purges per emission against a recording cache. One
   * emission, one purge per emission.
   */
  it('purges the cached page', async () => {
    expect((await cache.lookup('/en/blog/due-for-both')).hit).toBe(false)
  })
})
