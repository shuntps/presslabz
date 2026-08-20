import { Valkey } from 'iovalkey'
import { withTagCollection } from '../collector.ts'
import { createNullPageCache, createPageCache, type PageCache } from '../store.ts'
import { isTag } from '../tags.ts'
import type { ValkeyCacheOptions } from './config.ts'

/**
 * The provider Astro loads at runtime.
 *
 * It follows the same protocol as Astro's own memory provider — read
 * `CDN-Cache-Control` for the lifetime and `Cache-Tag` for the tags, both of
 * which the framework strips before the response leaves — with two
 * differences that are the point of writing one.
 *
 * The entries live in Valkey, so the API can purge them. And the tags are not
 * only the ones a route declared: the render runs inside a tag collection, so
 * every document, listing and asset the page actually read is recorded without
 * a theme or a route having to list anything. That is the fourth architecture
 * principle, and it is the half a route rule cannot express.
 */

interface RequestContext {
  readonly request: Request
  readonly url: URL
}

type Next = () => Promise<Response>

/** Headers that must not survive into a shared entry. */
const DROPPED = new Set(['set-cookie', 'cdn-cache-control', 'cache-tag', 'x-cache'])

function parseMaxAge(directives: string | null): number {
  if (!directives) return 0
  const match = /max-age=(\d+)/.exec(directives)
  return match ? Number(match[1]) : 0
}

function parseTags(header: string | null): string[] {
  if (!header) return []
  return header
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '' && isTag(tag))
}

/**
 * The key an entry is stored under.
 *
 * Query parameters are sorted, because `?a=1&b=2` and `?b=2&a=1` are one page,
 * and kept, because `?page=2` is not. Nothing else is normalised here: the
 * routes that accept a parameter refuse anything they did not expect, so the
 * key space is bounded by the routing rather than by a list of tracking
 * parameters kept up to date in two places.
 */
export function cacheKeyFor(url: URL): string {
  const params = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b))
  const search = params.map(([name, value]) => `${name}=${value}`).join('&')
  return search === '' ? url.pathname : `${url.pathname}?${search}`
}

function headersOf(response: Response): Record<string, string> {
  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (!DROPPED.has(name.toLowerCase())) headers[name] = value
  })
  return headers
}

export interface ValkeyCacheProvider {
  name: string
  onRequest(context: RequestContext, next: Next): Promise<Response>
  invalidate(options: { path?: string; tags?: string | string[] }): Promise<void>
}

export function createProvider(cache: PageCache): ValkeyCacheProvider {
  return {
    name: 'presslabz-valkey',

    async onRequest(context, next) {
      // A cached POST is a cached side effect. Only GET is ever stored.
      if (context.request.method !== 'GET') return next()

      const key = cacheKeyFor(context.url)
      const lookup = await cache.lookup(key)

      if (lookup.hit) {
        return new Response(lookup.page.body, {
          status: lookup.page.status,
          headers: { ...lookup.page.headers, 'x-cache': 'HIT' },
        })
      }

      const rendered = await withTagCollection(next)
      const response = rendered.value

      const maxAge = parseMaxAge(response.headers.get('CDN-Cache-Control'))
      const body = await response.text()
      const reply = () =>
        new Response(body, {
          status: response.status,
          headers: { ...headersOf(response), 'x-cache': 'MISS' },
        })

      /*
       * Four reasons not to keep a page, each of which has bitten somebody
       * else's cache: the route did not ask to be cached; the response is not
       * a document anyone should be handed twice — a redirect or a 404 has no
       * content tag, so nothing would ever purge it; the response carries a
       * cookie, which would be served to the next reader; or it varies, which
       * this store does not key on.
       */
      if (maxAge <= 0) return reply()
      if (response.status !== 200) return reply()
      if (response.headers.has('set-cookie')) return reply()
      if (response.headers.has('vary')) return reply()

      const tags = [...new Set([...rendered.tags, ...parseTags(response.headers.get('Cache-Tag'))])]

      // A page with no tags cannot be invalidated by anything; its ttl would
      // be its only exit, which is the state this design exists to avoid.
      if (tags.length === 0) return reply()

      await cache.store(
        key,
        { body, status: response.status, headers: headersOf(response) },
        { tags, renderedFrom: lookup.at },
      )

      return reply()
    },

    async invalidate(options) {
      const tags = options.tags === undefined ? [] : [options.tags].flat()
      if (tags.length > 0) await cache.purgeTags(tags.filter(isTag))
    },
  }
}

/**
 * The environment wins over the build.
 *
 * Astro serialises a provider's config into the manifest, so whatever
 * astro.config read at build time is frozen into the bundle. For a namespace
 * that is a trap: the API purges under the namespace *it* reads from the
 * environment, and a site built elsewhere would quietly hold its entries
 * somewhere else — a cache that never serves a stale page because it never
 * serves anything, or worse, one nothing can purge. Observed, not imagined.
 *
 * So the baked values are defaults and the environment overrides them, which
 * is also how the API reads the same three settings.
 */
const factory = (config: ValkeyCacheOptions | undefined): ValkeyCacheProvider => {
  /*
   * Off at runtime, not only at build. Every other setting here is read from
   * the environment for the reason above, and leaving this one behind meant
   * `PAGE_CACHE_ENABLED=false` silently kept caching on a server that was
   * built with it on — which is exactly the kind of half-applied switch an
   * operator debugs for an hour.
   */
  if (process.env.PAGE_CACHE_ENABLED === 'false') return createProvider(createNullPageCache())

  const url = process.env.VALKEY_URL ?? config?.url
  if (!url) throw new Error('The page cache needs a Valkey URL')

  const namespace = process.env.PAGE_CACHE_NAMESPACE ?? config?.namespace
  const ttl = process.env.PAGE_CACHE_TTL_SECONDS ?? config?.ttlSeconds
  const ttlSeconds = ttl === undefined ? undefined : Number(ttl)

  return createProvider(
    createPageCache({
      client: new Valkey(url),
      ...(namespace === undefined ? {} : { namespace }),
      ...(ttlSeconds === undefined || Number.isNaN(ttlSeconds) ? {} : { ttlSeconds }),
      ...(config?.purgeStampTtlSeconds === undefined
        ? {}
        : { purgeStampTtlSeconds: config.purgeStampTtlSeconds }),
    }),
  )
}

export default factory
