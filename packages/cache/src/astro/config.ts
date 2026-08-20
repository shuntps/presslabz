/**
 * Declares this package as Astro's cache provider.
 *
 * Astro 6 brought route caching with tag invalidation and 7 added a provider
 * interface, so none of that is reimplemented here — `Vary`, `swr`, ETags and
 * the route rules stay the framework's. What the framework cannot do is
 * invalidate across processes: `cache.invalidate()` runs inside the Astro
 * server, and the process that knows a document was published is the API. The
 * built-in memory provider dies with its process and is shared with nobody.
 *
 * So the storage is Valkey, reachable from both, and the purge the API
 * performs is the same operation this provider performs.
 */

export interface ValkeyCacheOptions {
  /** Where Valkey is. Serialized into the build's manifest. */
  readonly url: string
  /**
   * Two installations sharing one Valkey must not share this, and nothing can
   * detect that they do.
   */
  readonly namespace?: string | undefined
  /** The backstop for a purge that never arrived, not the invalidation. */
  readonly ttlSeconds?: number | undefined
  readonly purgeStampTtlSeconds?: number | undefined
}

export interface AstroCacheProviderConfig {
  readonly name: string
  readonly entrypoint: string
  readonly config: ValkeyCacheOptions
}

export function valkeyCache(options: ValkeyCacheOptions): AstroCacheProviderConfig {
  return {
    name: 'presslabz-valkey',
    entrypoint: '@presslabz/cache/astro/runtime',
    config: options,
  }
}
