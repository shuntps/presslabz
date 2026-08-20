import { createBuiltinRegistry } from '@presslabz/core'
import type { PublishedPathRow } from '@presslabz/db'
import { LOCALE_TAGS, type Locale } from '@presslabz/i18n'
import type { APIRoute } from 'astro'
import { loadEveryPublishedPath } from '../data/content.ts'
import { localeConfig } from '../env.ts'
import { archivePath, documentPath, homePath } from '../lib/routes.ts'
import { absolute, seoOf } from '../lib/seo.ts'
import { type SitemapEntry, sitemapXml } from '../lib/xml.ts'

/**
 * Every page a reader could land on, in one document.
 *
 * Three things it deliberately leaves out. A document marked `noindex`, since
 * that flag exists to keep a page out of results without unpublishing it and a
 * sitemap entry is the opposite of that. A document whose type is no longer
 * registered, because there is no URL to name. And a page whose path could not
 * be resolved: the query returns only what is reachable from a root, so a row
 * inside a `parentId` cycle is absent rather than published at a guess.
 */
export const GET: APIRoute = async () => {
  const registry = createBuiltinRegistry()
  const rows = await loadEveryPublishedPath()

  const listed = rows.filter((row) => registry.has(row.type) && seoOf(row.meta)?.noindex !== true)

  /*
   * Grouped before anything is written, because hreflang is reciprocal: an
   * entry has to name its siblings, including the ones further down the list.
   */
  const groups = new Map<string, PublishedPathRow[]>()
  for (const row of listed) {
    const group = groups.get(row.translationGroupId)
    if (group) group.push(row)
    else groups.set(row.translationGroupId, [row])
  }

  const hrefOf = (row: PublishedPathRow): string =>
    absolute(documentPath(row.locale as Locale, registry.require(row.type), row.path))

  const entries: SitemapEntry[] = []

  // The home page and each archive, per language: they have no row of their
  // own, and they are what a reader is most likely to arrive at.
  for (const locale of localeConfig.locales) {
    entries.push({ loc: absolute(homePath(locale)) })
    for (const type of registry.all()) {
      if (type.basePath !== '') entries.push({ loc: absolute(archivePath(locale, type)) })
    }
  }

  for (const row of listed) {
    const siblings = groups.get(row.translationGroupId) ?? []

    entries.push({
      loc: hrefOf(row),
      lastmod: row.updatedAt,
      // A single-language document is not a translation set; announcing one
      // alternate that points at the page itself tells a crawler nothing.
      alternates:
        siblings.length > 1
          ? siblings.map((sibling) => ({
              hreflang: LOCALE_TAGS[sibling.locale as Locale] ?? sibling.locale,
              href: hrefOf(sibling),
            }))
          : undefined,
    })
  }

  return new Response(sitemapXml(entries), {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  })
}
