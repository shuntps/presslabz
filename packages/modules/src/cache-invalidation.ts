import {
  contentListTag,
  contentTag,
  mediaTag,
  type PageCache,
  translationGroupTag,
} from '@presslabz/cache'
import type { ContentEvent, CoreHooks, MediaEvent } from '@presslabz/core'
import type { Module } from './module.ts'

/**
 * Empties the page cache when content changes.
 *
 * This is the feature that proves the hook API is worth having. It used to sit
 * inside the API's write routes, called directly after each successful write;
 * it now hears about writes the same way a third-party plugin would, through
 * `content:created` and its siblings, with no privileged access to anything.
 * If invalidation could not be expressed this way, the API would be missing
 * something — and finding that out here is much cheaper than finding it out
 * after somebody else has built on it.
 *
 * It is registered on the API rather than on the site because the API is the
 * process that knows a write happened; see the page cache section of
 * docs/ARCHITECTURE.md for why the entries live somewhere both can reach.
 */
export function cacheInvalidation(cache: PageCache): Module {
  const purgeContent = async (event: ContentEvent): Promise<void> => {
    /*
     * Three tags, because a write changes three things. The document's own
     * page. Every listing of its type in its language — including the archive
     * pages that do not contain it, since it pushed one entry off the end of
     * each. And its translation group, because the other languages announce
     * this one in hreflang and offer it in the switcher.
     */
    await cache.purgeTags([
      contentTag(event.id),
      contentListTag(event.type, event.locale),
      translationGroupTag(event.translationGroupId),
    ])
  }

  const purgeMedia = async (event: MediaEvent): Promise<void> => {
    // Alt text is rendered into every page that shows the asset.
    await cache.purgeTags([mediaTag(event.id)])
  }

  return {
    name: 'cache-invalidation',

    register(hooks: CoreHooks) {
      /*
       * Early, so that a slower handler — a webhook, a search index — cannot
       * leave the site serving a stale page while it finishes. It is only a
       * head start: handlers run concurrently, and a purge that fails is
       * reported rather than retried, with the ttl as the backstop.
       */
      const options = { priority: 1, label: 'cache-invalidation' }

      /*
       * Every content event, including the two that a manual edit also emits
       * as `content:updated`. Listening only to the broad ones looked
       * sufficient until the scheduler arrived: it announces a publication and
       * nothing else, so the page stayed cached and a post that had gone live
       * kept serving the version that said it had not. Purging twice for one
       * manual publish costs a Valkey round trip on an empty tag set; missing
       * one costs a reader the wrong page.
       */
      const off = [
        hooks.action('content:created', purgeContent, options),
        hooks.action('content:updated', purgeContent, options),
        hooks.action('content:published', purgeContent, options),
        hooks.action('content:unpublished', purgeContent, options),
        hooks.action('content:deleted', purgeContent, options),
        hooks.action('media:uploaded', purgeMedia, options),
        hooks.action('media:updated', purgeMedia, options),
        hooks.action('media:deleted', purgeMedia, options),
      ]

      return () => {
        for (const remove of off) remove()
      }
    },
  }
}
