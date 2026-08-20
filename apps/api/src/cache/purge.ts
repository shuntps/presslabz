import { createNullPageCache, createPageCache, type PageCache } from '@presslabz/cache'
import type { Valkey } from 'iovalkey'

/**
 * Where the API reaches the page cache the public site fills.
 *
 * What it does with it is not decided here any more: purging is a first-party
 * module registered on the hook API, in packages/modules. This file only
 * builds the handle, because building it needs configuration and a module
 * takes only what it is given.
 */

/**
 * The store this API purges, or a no-op when the installation has not said
 * where its cache is. An installation without a cache is not misconfigured; it
 * renders every request.
 */
export function createApiPageCache(options: {
  readonly client?: Valkey | undefined
  readonly namespace?: string | undefined
  readonly ttlSeconds?: number | undefined
}): PageCache {
  if (!options.client) return createNullPageCache()

  return createPageCache({
    client: options.client,
    ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
    ...(options.ttlSeconds === undefined ? {} : { ttlSeconds: options.ttlSeconds }),
  })
}
