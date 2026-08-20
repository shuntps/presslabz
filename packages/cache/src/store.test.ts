import { hasIntegrationEnv } from '@presslabz/db/testing'
import { Valkey } from 'iovalkey'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createNullPageCache, createPageCache, type PageCache, pageKeyFor } from './store.ts'
import { contentListTag, contentTag } from './tags.ts'

/*
 * A real Valkey. Every claim below is a property of the scripts — that a purge
 * arriving mid-render is not lost, that a re-render leaves no membership
 * behind — and each one is about what happens between two commands. A fake
 * that ran them in order would prove none of it.
 */
const ready = hasIntegrationEnv()

const PAGE = { body: '<p>hello</p>', status: 200, headers: { 'content-type': 'text/html' } }
const CONTENT = contentTag('33333333-3333-4333-8333-333333333333')
const LIST = contentListTag('post', 'en')

describe.skipIf(!ready)('page cache', () => {
  let client: Valkey
  let cache: PageCache

  beforeAll(() => {
    client = new Valkey(process.env.VALKEY_URL as string)
    // Its own namespace per run, so two runs against one Valkey — a developer
    // and CI on the same box — cannot purge each other's fixtures.
    const namespace = `presslabz:test:${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}:`
    cache = createPageCache({ client, namespace, ttlSeconds: 60, purgeStampTtlSeconds: 60 })
  })

  afterEach(async () => {
    await cache.clear()
  })

  afterAll(async () => {
    await cache?.clear()
    await client?.quit()
  })

  it('serves back what it stored', async () => {
    const miss = await cache.lookup('/en/hello')
    expect(miss.hit).toBe(false)

    const written = await cache.store('/en/hello', PAGE, {
      tags: [CONTENT, LIST],
      renderedFrom: miss.at,
    })
    expect(written).toBe(true)

    const hit = await cache.lookup('/en/hello')
    expect(hit.hit).toBe(true)
    expect(hit.hit && hit.page).toEqual(PAGE)
  })

  it('dates a lookup by Valkey rather than by the caller', async () => {
    const before = await cache.lookup('/en/clock')
    const after = await cache.lookup('/en/clock')
    expect(after.at).toBeGreaterThanOrEqual(before.at)
    expect(before.at).toBeGreaterThan(1_700_000_000_000)
  })

  it('drops a page through any tag it carries', async () => {
    const miss = await cache.lookup('/en/hello')
    await cache.store('/en/hello', PAGE, { tags: [CONTENT, LIST], renderedFrom: miss.at })

    expect(await cache.purgeTags([LIST])).toBe(1)
    expect((await cache.lookup('/en/hello')).hit).toBe(false)
  })

  /*
   * The leak this closes: a page purged through one tag stays a member of
   * every other tag's set. The set then grows without bound, and the next
   * purge of those tags reports work it did not do.
   */
  it('leaves nothing behind in the tags it was not purged through', async () => {
    const miss = await cache.lookup('/en/hello')
    await cache.store('/en/hello', PAGE, { tags: [CONTENT, LIST], renderedFrom: miss.at })

    expect(await cache.purgeTags([CONTENT])).toBe(1)
    expect(await cache.purgeTags([LIST])).toBe(0)
  })

  /*
   * A re-render that reads less than the previous one did. Without the
   * cleanup, the page stays in the old tag's set and is purged by content it
   * no longer displays — wasteful — and the set outlives the key.
   */
  it('forgets a tag the page no longer reads', async () => {
    const first = await cache.lookup('/en/hello')
    await cache.store('/en/hello', PAGE, { tags: [CONTENT, LIST], renderedFrom: first.at })

    const second = await cache.lookup('/en/other')
    await cache.store('/en/hello', PAGE, { tags: [LIST], renderedFrom: second.at })

    expect(await cache.purgeTags([CONTENT])).toBe(0)
    expect((await cache.lookup('/en/hello')).hit).toBe(true)
  })

  /**
   * The race the design exists for: the purge finds nothing to delete because
   * the render that will store the stale page has not finished yet.
   */
  it('refuses to store a render the purge already overtook', async () => {
    const miss = await cache.lookup('/en/hello')

    expect(await cache.purgeTags([CONTENT])).toBe(0)

    const written = await cache.store('/en/hello', PAGE, {
      tags: [CONTENT],
      renderedFrom: miss.at,
    })

    expect(written).toBe(false)
    expect((await cache.lookup('/en/hello')).hit).toBe(false)
  })

  it('stores again once the render started after the purge', async () => {
    await cache.purgeTags([CONTENT])
    // Past the stamp rather than level with it: the comparison treats a tie as
    // the purge winning, so a lookup inside the same millisecond is refused by
    // design and would make this test flake rather than fail honestly.
    await new Promise((resolve) => setTimeout(resolve, 5))

    const miss = await cache.lookup('/en/hello')
    const written = await cache.store('/en/hello', PAGE, {
      tags: [CONTENT],
      renderedFrom: miss.at,
    })

    expect(written).toBe(true)
  })

  it('purges nothing when given nothing, without a round trip', async () => {
    expect(await cache.purgeTags([])).toBe(0)
  })

  it('round-trips a key too long or too strange to be readable', async () => {
    const key = `/en/${'x'.repeat(400)}`
    expect(pageKeyFor(key)).toMatch(/^sha256:[0-9a-f]{64}$/)

    const miss = await cache.lookup(key)
    await cache.store(key, PAGE, { tags: [LIST], renderedFrom: miss.at })

    expect((await cache.lookup(key)).hit).toBe(true)
  })

  it('empties its own namespace and nothing else', async () => {
    const other = createPageCache({ client, namespace: 'presslabz:test:neighbour:' })
    const mine = await cache.lookup('/en/hello')
    await cache.store('/en/hello', PAGE, { tags: [LIST], renderedFrom: mine.at })
    const theirs = await other.lookup('/en/hello')
    await other.store('/en/hello', PAGE, { tags: [LIST], renderedFrom: theirs.at })

    await cache.clear()

    expect((await cache.lookup('/en/hello')).hit).toBe(false)
    expect((await other.lookup('/en/hello')).hit).toBe(true)
    await other.clear()
  })
})

describe('null page cache', () => {
  it('answers the same contract while keeping nothing', async () => {
    const cache = createNullPageCache()
    const miss = await cache.lookup('/en/hello')

    expect(miss.hit).toBe(false)
    expect(await cache.store('/en/hello', PAGE, { tags: [LIST], renderedFrom: miss.at })).toBe(
      false,
    )
    expect((await cache.lookup('/en/hello')).hit).toBe(false)
    expect(await cache.purgeTags([LIST])).toBe(0)
  })
})
