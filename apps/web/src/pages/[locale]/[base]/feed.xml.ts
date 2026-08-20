import { renderBlocksToHtml } from '@presslabz/blocks'
import { createBuiltinRegistry } from '@presslabz/core'
import { createTranslator, isLocale, LOCALE_TAGS } from '@presslabz/i18n'
import type { APIRoute } from 'astro'
import { loadArchive, loadMediaForMany } from '../../../data/content.ts'
import { env, localeConfig } from '../../../env.ts'
import { archivePath, documentPath, homePath } from '../../../lib/routes.ts'
import { absolute } from '../../../lib/seo.ts'
import { type FeedEntry, feedXml } from '../../../lib/xml.ts'

/** Enough to fill a reader's window without turning a feed into an archive. */
const FEED_SIZE = 20

/**
 * One feed per content type per language, at the archive's own address.
 *
 * The entries carry rendered HTML from the reference renderer rather than the
 * theme's components: a feed reader applies its own styling and drops unknown
 * markup, so a theme's scoped classes would be noise at best. It is the same
 * whitelist either way, which is what matters — a feed cannot emit markup a
 * page could not.
 */
export const GET: APIRoute = async ({ params }) => {
  const locale = params.locale
  const base = params.base

  if (!isLocale(locale) || !localeConfig.locales.includes(locale) || !base) {
    return new Response(null, { status: 404 })
  }

  const registry = createBuiltinRegistry()
  const type = registry.all().find((candidate) => candidate.basePath === base)

  // A type at the locale root has no archive of its own, so it has no feed.
  if (!type || type.basePath === '') return new Response(null, { status: 404 })

  const archive = await loadArchive({ type, locale, page: 1, perPage: FEED_SIZE })
  const media = await loadMediaForMany(archive.rows, locale)
  const t = createTranslator(locale)

  const entries: FeedEntry[] = archive.rows.map((row) => ({
    id: row.id,
    title: row.title,
    href: absolute(documentPath(locale, type, [row.slug])),
    updated: row.updatedAt,
    published: row.publishedAt,
    summary: row.excerpt,
    contentHtml: renderBlocksToHtml(row.blocks, { resolveMedia: (id) => media.get(id) }),
  }))

  /*
   * The newest entry's date, not the moment of the request: a feed whose
   * `updated` changes on every fetch tells every reader it has news whenever
   * they poll it.
   */
  const updated = entries.reduce<Date>(
    (latest, entry) => (entry.updated > latest ? entry.updated : latest),
    new Date(0),
  )

  return new Response(
    feedXml({
      title: `${env.SITE_NAME} — ${t(`content.type.${type.name}.plural` as never)}`,
      siteHref: absolute(homePath(locale)),
      selfHref: absolute(`${archivePath(locale, type)}/feed.xml`),
      language: LOCALE_TAGS[locale],
      updated: entries.length > 0 ? updated : new Date(0),
      entries,
    }),
    {
      headers: {
        'content-type': 'application/atom+xml; charset=utf-8',
        'cache-control': 'public, max-age=600',
      },
    },
  )
}
