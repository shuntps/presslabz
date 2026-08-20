import {
  contentListTag,
  contentTag,
  createNullPageCache,
  createPageCache,
  mediaTag,
  type PageCache,
  translationGroupTag,
} from '@presslabz/cache'
import type { FastifyBaseLogger } from 'fastify'
import type { Valkey } from 'iovalkey'

/**
 * The other half of invalidation: the site collects tags while it renders,
 * and this purges them when a document changes.
 *
 * It lives in the API because the API is where a change is known. Astro's
 * `cache.invalidate()` runs inside the rendering process, which never hears
 * about a publish — that asymmetry is the reason the entries live in Valkey
 * rather than in the site's memory.
 *
 * A purge that fails must not fail the write. By the time it runs the document
 * is already saved, and answering 500 would tell the author their work was
 * lost when it was not; the ttl on every entry is the backstop, and the log
 * line is how an operator learns the backstop is what is holding the site
 * together.
 */

export interface ContentChange {
  readonly id: string
  readonly type: string
  readonly locale: string
  readonly translationGroupId: string
}

export interface Purger {
  content(change: ContentChange): Promise<void>
  media(mediaId: string): Promise<void>
}

export interface PurgerOptions {
  readonly cache: PageCache
  readonly logger: FastifyBaseLogger
}

export function createPurger(options: PurgerOptions): Purger {
  const { cache, logger } = options

  const purge = async (tags: readonly string[], what: string): Promise<void> => {
    try {
      const removed = await cache.purgeTags(tags)
      logger.debug({ tags, removed }, 'purged the page cache')
    } catch (error) {
      logger.error({ err: error, tags, what }, 'could not purge the page cache')
    }
  }

  return {
    async content(change) {
      /*
       * Three tags, because publishing changes three things. The document's
       * own page. Every listing of its type in its language — including the
       * pages of an archive that do not contain it, since it pushed one entry
       * off the end of each. And its translation group, because the other
       * languages announce this one in hreflang and offer it in the switcher.
       */
      await purge(
        [
          contentTag(change.id),
          contentListTag(change.type, change.locale),
          translationGroupTag(change.translationGroupId),
        ],
        `content ${change.id}`,
      )
    },

    async media(mediaId) {
      // Alt text is part of every page that displays the asset.
      await purge([mediaTag(mediaId)], `media ${mediaId}`)
    },
  }
}

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
