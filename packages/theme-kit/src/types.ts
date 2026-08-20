import type { Block, Blocks, BlockType, ResolvedMedia } from '@presslabz/blocks'
import type { Locale, Translator } from '@presslabz/i18n'
import type { AstroComponentFactory } from 'astro/runtime/server/index.js'

/**
 * What a theme is handed, and what it is asked for.
 *
 * A theme never reaches for the database, and nothing here gives it a way to:
 * every template receives a plain, typed value that the site resolved before
 * it was called. That is not politeness, it is the prerequisite for the
 * permission manifest — a theme whose data needs can be listed is one whose
 * authority can be bounded, and one that could open a connection is not.
 */

/**
 * What the document says about itself to a machine.
 *
 * Built by the site and rendered by ThemeHead, so a theme cannot omit it and
 * cannot get it wrong. Which siblings may be advertised is an authorization
 * question, and a canonical URL is a claim only the routing can make.
 */
export interface PageHead {
  /** Absolute, or null on a page that must not name a canonical URL. */
  readonly canonical: string | null
  /** Absolute alternates, one per language the document exists in. */
  readonly alternates: readonly { readonly locale: Locale; readonly href: string }[]
  /** The default locale's alternate, for readers no language matched. */
  readonly defaultHref: string | null
  /** From meta.seo.noindex: keeps a page out of results without unpublishing. */
  readonly noindex: boolean
}

export interface TranslationLink {
  readonly locale: Locale
  readonly href: string
  readonly title: string
  /**
   * False when this language has no version of what is on the page, and the
   * link goes to that language's home page instead.
   *
   * Both cases are offered, because a switcher that disappears on an
   * untranslated document leaves a reader with no way to change language at
   * all. Marking the difference is what keeps it from being a lie: the reader
   * is told the link does not lead to this page in that language, rather than
   * discovering it after the jump.
   */
  readonly available: boolean
}

export interface NavLink {
  readonly href: string
  readonly label: string
  /** True when this link is the page being rendered. */
  readonly current: boolean
}

/** True of every page, whatever it shows. */
export interface SiteContext {
  readonly locale: Locale
  /** Every language this installation serves, for a language switcher. */
  readonly locales: readonly Locale[]
  readonly siteName: string
  /** The path being rendered, so a theme can mark the current link. */
  readonly path: string
  readonly homeHref: string
  /**
   * The site's own navigation, already built. A theme renders links; it never
   * computes one. Where a content type lives is part of its declaration, and a
   * theme that assembled `/en/blog` itself would break the day a `basePath`
   * changed — or would have to know the locale prefixing rule, which is the
   * site's rule and not the theme's.
   */
  readonly nav: readonly NavLink[]
  /** Interface strings. A theme adds its own catalogue rather than hardcoding. */
  readonly t: Translator
  /**
   * Published translations of whatever is on this page, empty elsewhere.
   * Filled by the site, never derived by the theme: which siblings a reader
   * may be told about is an authorization question.
   */
  readonly translations: readonly TranslationLink[]
  readonly head: PageHead
  /**
   * The feed this page belongs to, or null where there is none. Advertised by
   * ThemeHead so a reader's browser or reader application finds it without the
   * theme having to know the URL.
   */
  readonly feedHref: string | null
}

export interface DocumentView {
  readonly id: string
  readonly type: string
  readonly title: string
  readonly excerpt: string | null
  readonly publishedAt: Date | null
  /** The document itself, as blocks. Never a string of HTML. */
  readonly blocks: Blocks
  /** Every asset the blocks reference, already resolved to a URL and alt text. */
  readonly media: ReadonlyMap<string, ResolvedMedia>
  readonly href: string
}

export interface ArchiveEntry {
  readonly id: string
  readonly title: string
  readonly excerpt: string | null
  readonly publishedAt: Date | null
  readonly href: string
}

export interface ArchiveView {
  readonly title: string
  readonly entries: readonly ArchiveEntry[]
  readonly page: number
  readonly pageCount: number
  /** Null at the ends, so a theme renders links rather than computing them. */
  readonly newerHref: string | null
  readonly olderHref: string | null
}

export interface HomeProps {
  readonly site: SiteContext
  readonly archive: ArchiveView
}

export interface ArchiveProps {
  readonly site: SiteContext
  readonly archive: ArchiveView
}

export interface DocumentProps {
  readonly site: SiteContext
  readonly document: DocumentView
}

export interface NotFoundProps {
  readonly site: SiteContext
}

/**
 * What a block component receives. `media` is resolved for an image block and
 * undefined everywhere else — the component knows which type it renders, so
 * narrowing it is the theme's business and not a second prop shape.
 */
export interface BlockProps {
  readonly block: Block
  readonly media?: ResolvedMedia | undefined
}

/**
 * A component per block type, all of them optional. Anything a theme leaves
 * out falls back to the whitelist renderer in packages/blocks, so a theme is
 * allowed to be incomplete and a document is never blank because of one.
 */
export type BlockComponents = Partial<Record<BlockType, AstroComponentFactory>>

export interface ThemeTemplates {
  readonly home: AstroComponentFactory
  readonly archive: AstroComponentFactory
  readonly document: AstroComponentFactory
  readonly notFound: AstroComponentFactory
}

export interface Theme {
  readonly name: string
  readonly templates: ThemeTemplates
  readonly blocks: BlockComponents
}
