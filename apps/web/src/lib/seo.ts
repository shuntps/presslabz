import type { AnyContentType } from '@presslabz/core'
import type { Locale } from '@presslabz/i18n'
import type { PageHead, TranslationLink } from '@presslabz/theme-kit'
import type { Sibling } from '../data/content.ts'
import { env, localeConfig } from '../env.ts'
import { documentPath } from './routes.ts'

/**
 * The absolute form of a path, built on the address readers actually use.
 *
 * Absolute because `hreflang` and `canonical` are claims about a site, not
 * about a request: a relative one would name a different page depending on
 * which host answered, which is exactly what a CDN in front of the origin
 * makes possible.
 */
export function absolute(path: string): string {
  return new URL(path, env.SITE_URL).toString()
}

interface SeoMeta {
  readonly seo?: {
    readonly title?: string
    readonly description?: string
    readonly noindex?: boolean
  }
}

export function seoOf(meta: Record<string, unknown>): SeoMeta['seo'] {
  const seo = (meta as SeoMeta).seo
  return seo && typeof seo === 'object' ? seo : undefined
}

export interface DocumentHeadInput {
  readonly locale: Locale
  readonly type: AnyContentType
  readonly path: readonly string[]
  readonly meta: Record<string, unknown>
  readonly siblings: readonly Sibling[]
}

/**
 * What a document tells a machine about itself.
 *
 * Every language names all of them, itself included, because hreflang is
 * reciprocal or it is ignored. A sibling with no resolvable path is left out
 * rather than guessed at.
 */
export function documentHead(input: DocumentHeadInput): PageHead {
  const alternates = input.siblings
    .filter((sibling) => sibling.path !== null)
    .map((sibling) => ({
      locale: sibling.row.locale as Locale,
      href: absolute(
        documentPath(sibling.row.locale as Locale, input.type, sibling.path as readonly string[]),
      ),
    }))

  const canonical = absolute(documentPath(input.locale, input.type, input.path))
  const fallback = alternates.find((alternate) => alternate.locale === localeConfig.defaultLocale)

  return {
    canonical,
    // A single language is not a translation set; announcing one alternate
    // that points at the page itself tells a crawler nothing it did not have.
    alternates: alternates.length > 1 ? alternates : [],
    defaultHref: alternates.length > 1 ? (fallback?.href ?? null) : null,
    noindex: seoOf(input.meta)?.noindex === true,
  }
}

/** A page that is not one document: the home page, an archive, a 404. */
export function listingHead(path: string, options: { readonly noindex?: boolean } = {}): PageHead {
  return {
    canonical: absolute(path),
    alternates: [],
    defaultHref: null,
    noindex: options.noindex === true,
  }
}

/** What a 404 says: nothing. It must never be presented as a real page. */
export const MISSING_HEAD: PageHead = {
  canonical: null,
  alternates: [],
  defaultHref: null,
  noindex: true,
}

export function translationLinks(
  siblings: readonly Sibling[],
  type: AnyContentType,
  current: Locale,
): TranslationLink[] {
  return siblings
    .filter((sibling) => sibling.path !== null && sibling.row.locale !== current)
    .map((sibling) => ({
      locale: sibling.row.locale as Locale,
      href: documentPath(sibling.row.locale as Locale, type, sibling.path as readonly string[]),
      title: sibling.row.title,
    }))
}
