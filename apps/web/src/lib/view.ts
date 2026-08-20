import type { ResolvedMedia } from '@presslabz/blocks'
import { type AnyContentType, type ContentTypeRegistry, contentEventOf } from '@presslabz/core'
import type { ContentRow } from '@presslabz/db'
import { createTranslator, type Locale } from '@presslabz/i18n'
import type {
  ArchiveEntry,
  ArchiveView,
  DocumentView,
  NavLink,
  PageHead,
  SiteContext,
  TranslationLink,
} from '@presslabz/theme-kit'
import { env, localeConfig } from '../env.ts'
import { hooks } from '../hooks.ts'
import { filterBlocks, filterExcerpt } from './filters.ts'
import { archivePageUrl, archivePath, documentPath, homePath } from './routes.ts'

/**
 * Everything a theme is handed, built here.
 *
 * The theme gets values, never the means to compute them: no locale prefixing
 * rule, no base path, no database. That is what makes the contract in
 * packages/theme-kit small enough to be worth having — and it is the reason a
 * `basePath` change moves every link on the site without a theme being
 * rebuilt or even reread.
 */

export function navFor(locale: Locale, registry: ContentTypeRegistry, path: string): NavLink[] {
  const t = createTranslator(locale)

  return registry
    .all()
    .filter((type) => type.basePath !== '')
    .map((type) => {
      const href = archivePath(locale, type)
      return {
        href,
        label: t(`content.type.${type.name}.plural` as never),
        current: path === href || path.startsWith(`${href}/`),
      }
    })
}

export interface SiteContextInput {
  readonly locale: Locale
  readonly path: string
  readonly registry: ContentTypeRegistry
  readonly head: PageHead
  readonly translations?: readonly TranslationLink[]
  readonly feedHref?: string | null
}

export function siteContext(input: SiteContextInput): SiteContext {
  return {
    locale: input.locale,
    locales: localeConfig.locales,
    siteName: env.SITE_NAME,
    path: input.path,
    homeHref: homePath(input.locale),
    nav: navFor(input.locale, input.registry, input.path),
    t: createTranslator(input.locale),
    /*
     * Which siblings a reader may be told about is an authorization question,
     * answered by the site: only what is published, and only what has a path
     * that resolves.
     */
    translations: input.translations ?? [],
    head: input.head,
    feedHref: input.feedHref ?? null,
  }
}

export async function entryOf(
  row: ContentRow,
  type: AnyContentType,
  locale: Locale,
): Promise<ArchiveEntry> {
  return {
    id: row.id,
    title: row.title,
    // Through the filter chain, so a document with no summary can be given one
    // by a module rather than by this function knowing how.
    excerpt: await filterExcerpt(hooks, row.excerpt, row.blocks, contentEventOf(row)),
    publishedAt: row.publishedAt,
    href: documentPath(locale, type, [row.slug]),
  }
}

export interface ArchiveViewInput {
  readonly locale: Locale
  readonly type: AnyContentType
  readonly rows: readonly ContentRow[]
  readonly page: number
  readonly pageCount: number
  readonly title: string
}

export async function archiveView(input: ArchiveViewInput): Promise<ArchiveView> {
  const { locale, type, page, pageCount } = input

  return {
    title: input.title,
    entries: await Promise.all(input.rows.map((row) => entryOf(row, type, locale))),
    page,
    pageCount,
    // Null at the ends rather than a link that answers 404: the theme renders
    // what it is given, and page zero does not exist.
    newerHref: page > 1 ? archivePageUrl(locale, type, page - 1) : null,
    olderHref: page < pageCount ? archivePageUrl(locale, type, page + 1) : null,
  }
}

export async function documentView(
  row: ContentRow,
  type: AnyContentType,
  slugs: readonly string[],
  media: ReadonlyMap<string, ResolvedMedia>,
): Promise<DocumentView> {
  const event = contentEventOf(row)

  return {
    id: row.id,
    type: type.name,
    title: row.title,
    excerpt: await filterExcerpt(hooks, row.excerpt, row.blocks, event),
    publishedAt: row.publishedAt,
    /*
     * The one filter that reaches the page, so what comes back is checked
     * against the block schema before it is rendered: an extension may decide
     * how a document reads, never what a block may be.
     */
    blocks: await filterBlocks(hooks, row.blocks, event, (error) => {
      console.error('[hooks] content:blocks produced something that is not a document', error)
    }),
    media,
    href: documentPath(row.locale as Locale, type, slugs),
  }
}
