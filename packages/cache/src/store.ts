import { createHash } from 'node:crypto'
import type { Valkey } from 'iovalkey'
import { assertTag } from './tags.ts'

/**
 * The page cache, and the purge that empties it.
 *
 * Both halves live here because they share three things that must not be
 * restated apart: the key layout, the clock, and the rule that decides whether
 * a freshly rendered page is still worth keeping. The API purges tags without
 * knowing what a page key looks like; the site stores pages without knowing
 * when a purge happened.
 *
 * Everything that touches more than one key is a Lua script, for the same
 * reason the rate limiter's counter is: a sequence of round trips is a
 * sequence another connection can interleave with, and the interleaving that
 * matters here — a publish landing between a render and its store — produces
 * a stale page with no expiry short enough to matter.
 *
 * One Valkey, not a cluster. Purging fans out to keys the caller cannot name
 * in advance (a tag's members, and each member's own tag set), so those keys
 * are built inside the script rather than declared in KEYS. A cluster would
 * refuse that, and nothing else about this design would survive sharding
 * either — a tag set and its members have to live together.
 */

export interface CachedPage {
  readonly body: string
  readonly status: number
  /** Only what has to survive the cache. The rest is set per response. */
  readonly headers: Readonly<Record<string, string>>
}

interface StoredPage extends CachedPage {
  /** Valkey's clock, so an operator reading a key can date it. */
  readonly storedAt: number
}

export type PageLookup =
  | { readonly hit: true; readonly page: CachedPage; readonly at: number }
  /**
   * `at` is Valkey's clock at the moment of the miss, and it is what makes the
   * store decision below correct. Taking it from the rendering process instead
   * would compare two machines' clocks, and a site rendering on one host while
   * the API purges from another would drift into keeping pages it should have
   * dropped.
   */
  | { readonly hit: false; readonly at: number }

export interface StoreOptions {
  readonly tags: readonly string[]
  /** The `at` from the lookup that missed. */
  readonly renderedFrom: number
}

export interface PageCache {
  lookup(key: string): Promise<PageLookup>
  /** False when a purge landed while the page was rendering. */
  store(key: string, page: CachedPage, options: StoreOptions): Promise<boolean>
  /** How many cached pages the purge removed. */
  purgeTags(tags: readonly string[]): Promise<number>
  /** Everything under the namespace. For an operator, and for tests. */
  clear(): Promise<number>
}

export interface PageCacheOptions {
  readonly client: Valkey
  /**
   * Two installations sharing one Valkey must not share this, and nothing can
   * detect that they do — the same reasoning as the rate limiter's namespace.
   */
  readonly namespace?: string
  /**
   * The backstop, not the invalidation. Tags are what make a page disappear
   * when its content changes; this is what bounds the damage of a purge that
   * never arrived because Valkey was restarted mid-publish.
   */
  readonly ttlSeconds?: number
  /**
   * How long a purge is remembered for the check below. It only has to outlive
   * a render, and a render that takes longer than this was going to time out
   * anyway.
   */
  readonly purgeStampTtlSeconds?: number
}

const DEFAULT_NAMESPACE = 'presslabz:web:'
const DEFAULT_TTL_SECONDS = 60 * 60
const DEFAULT_PURGE_STAMP_TTL_SECONDS = 15 * 60

/**
 * Valkey's own clock, in milliseconds. Written once and pasted into each
 * script, because a script cannot call another one.
 */
const NOW_MS = `
  local clock = redis.call('TIME')
  local nowMs = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)
`

/** KEYS[1] page. Returns the clock, and the payload when there is one. */
const LOOKUP_LUA = `
  local payload = redis.call('GET', KEYS[1])
  ${NOW_MS}
  if not payload then return {tostring(nowMs)} end
  return {tostring(nowMs), payload}
`

/*
 * KEYS[1] page, KEYS[2] the page's own tag list, then one pair per tag:
 * the tag's member set and the tag's purge stamp.
 * ARGV[1] payload, ARGV[2] page ttl, ARGV[3] rendered-from, ARGV[4] set ttl.
 *
 * The stamp check is the whole point. Without it: a render reads a document,
 * an editor publishes and the purge finds nothing to delete because the page
 * is not stored yet, then the render stores what it read — and the page stays
 * wrong until its ttl expires. Comparing against the clock the lookup returned
 * closes that window from inside the transaction that would create it.
 */
const STORE_LUA = `
  local renderedFrom = tonumber(ARGV[3])
  for i = 4, #KEYS, 2 do
    local stamp = tonumber(redis.call('GET', KEYS[i]))
    -- Not-after rather than after. The clock has millisecond resolution and a
    -- publish can land inside the same millisecond as the lookup that missed;
    -- treating that tie as "the purge came first" costs one uncached render,
    -- and treating it the other way keeps a page that is already wrong for the
    -- whole ttl. The cheap mistake is the one to make.
    if stamp and stamp >= renderedFrom then return 0 end
  end

  -- A re-render can drop a tag it used to carry. Leaving the key in that
  -- tag's set would purge it for content it no longer reads, which is only
  -- wasteful, and would keep the set growing after the key expires, which is
  -- a leak nothing else cleans up.
  local previous = redis.call('SMEMBERS', KEYS[2])
  for _, tagKey in ipairs(previous) do
    redis.call('SREM', tagKey, KEYS[1])
  end
  redis.call('DEL', KEYS[2])

  redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
  for i = 3, #KEYS, 2 do
    redis.call('SADD', KEYS[i], KEYS[1])
    redis.call('EXPIRE', KEYS[i], ARGV[4])
    redis.call('SADD', KEYS[2], KEYS[i])
  end
  redis.call('EXPIRE', KEYS[2], ARGV[4])
  return 1
`

/*
 * One pair per tag: its member set and its purge stamp. ARGV[1] stamp ttl,
 * ARGV[2] the suffix the page's tag list is keyed by.
 *
 * A member is removed from every tag it belongs to, not just the one being
 * purged, so a page invalidated through `content:x` leaves nothing behind in
 * `list:post:en`. The stamp is written last and always, including when the tag
 * had no members at all — that case is precisely the render in flight.
 */
const PURGE_LUA = `
  ${NOW_MS}
  local removed = 0
  for i = 1, #KEYS, 2 do
    local members = redis.call('SMEMBERS', KEYS[i])
    for _, pageKey in ipairs(members) do
      local ownTags = pageKey .. ARGV[2]
      for _, tagKey in ipairs(redis.call('SMEMBERS', ownTags)) do
        redis.call('SREM', tagKey, pageKey)
      end
      redis.call('DEL', ownTags)
      removed = removed + redis.call('DEL', pageKey)
    end
    redis.call('DEL', KEYS[i])
    redis.call('SET', KEYS[i + 1], tostring(nowMs), 'EX', ARGV[1])
  end
  return removed
`

/**
 * Recognisable when it can be, hashed when it cannot.
 *
 * The readable form is worth keeping: during an incident the useful question
 * is "is /fr/blog/hello cached", and an operator can only ask it of a key they
 * can type. Anything longer or stranger than a URL path — and a request line
 * is attacker-controlled — becomes a digest instead of a key that could carry
 * a newline into a key listing.
 */
const READABLE_KEY = /^[A-Za-z0-9/_.:@-]{1,200}$/

export function pageKeyFor(key: string): string {
  if (READABLE_KEY.test(key)) return key
  return `sha256:${createHash('sha256').update(key).digest('hex')}`
}

export function createPageCache(options: PageCacheOptions): PageCache {
  const client = options.client
  const namespace = options.namespace ?? DEFAULT_NAMESPACE
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS
  const stampTtl = options.purgeStampTtlSeconds ?? DEFAULT_PURGE_STAMP_TTL_SECONDS
  /** Tag sets outlive the pages in them, so a purge still finds the members. */
  const setTtl = ttl + stampTtl

  const TAG_LIST_SUFFIX = ':tags'
  const pageKey = (key: string) => `${namespace}page:${pageKeyFor(key)}`
  const tagKey = (tag: string) => `${namespace}tag:${assertTag(tag)}`
  const stampKey = (tag: string) => `${namespace}purged:${assertTag(tag)}`

  async function run(lua: string, keys: string[], args: (string | number)[]): Promise<unknown> {
    return client.eval(lua, keys.length, ...keys, ...args)
  }

  return {
    async lookup(key) {
      const result = (await run(LOOKUP_LUA, [pageKey(key)], [])) as [string, string?]
      const at = Number(result[0])
      const payload = result[1]
      if (payload === undefined) return { hit: false, at }

      // A payload that no longer parses is a deployment that changed the shape
      // under a live cache. Treating it as a miss re-renders it correctly;
      // throwing would take the page down for the length of the ttl.
      try {
        const stored = JSON.parse(payload) as StoredPage
        return {
          hit: true,
          page: { body: stored.body, status: stored.status, headers: stored.headers },
          at,
        }
      } catch {
        return { hit: false, at }
      }
    },

    async store(key, page, storeOptions) {
      const tags = [...new Set(storeOptions.tags)].sort()
      const stored: StoredPage = { ...page, storedAt: storeOptions.renderedFrom }
      const keys = [pageKey(key), `${pageKey(key)}${TAG_LIST_SUFFIX}`]
      for (const tag of tags) keys.push(tagKey(tag), stampKey(tag))

      const written = (await run(STORE_LUA, keys, [
        JSON.stringify(stored),
        ttl,
        storeOptions.renderedFrom,
        setTtl,
      ])) as number

      return written === 1
    },

    async purgeTags(tags) {
      const unique = [...new Set(tags)].sort()
      if (unique.length === 0) return 0

      const keys: string[] = []
      for (const tag of unique) keys.push(tagKey(tag), stampKey(tag))

      return (await run(PURGE_LUA, keys, [stampTtl, TAG_LIST_SUFFIX])) as number
    },

    async clear() {
      let cursor = '0'
      let removed = 0
      do {
        const [next, batch] = await client.scan(cursor, 'MATCH', `${namespace}*`, 'COUNT', 500)
        cursor = next
        // UNLINK rather than DEL: a namespace worth of keys is reclaimed off
        // the command thread, and this is the one call that can be large.
        if (batch.length > 0) removed += await client.unlink(...batch)
      } while (cursor !== '0')

      return removed
    },
  }
}

/**
 * The same contract, caching nothing.
 *
 * Development runs on this: an editor reloading a page they just changed must
 * see the change, and a cache that is correct still holds the previous render
 * until something purges it. It also means the site has one code path rather
 * than a branch around every lookup.
 */
export function createNullPageCache(): PageCache {
  return {
    lookup: async () => ({ hit: false, at: Date.now() }),
    store: async () => false,
    purgeTags: async () => 0,
    clear: async () => 0,
  }
}
