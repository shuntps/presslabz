/**
 * The two XML documents the site publishes for machines.
 *
 * Built by hand rather than with a library, and escaped by one function that
 * every value passes through. What goes into them is a title an author typed
 * and a URL built from a slug — so the interesting property is not that the
 * XML is pretty, it is that nothing an author can write closes a tag.
 */

const XML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
}

/**
 * Escapes text and attributes both, so neither can be got wrong, and drops the
 * control characters XML forbids outright.
 *
 * That second half matters more than it looks: one of those characters in one
 * title makes the whole document unparseable rather than ugly, and takes every
 * other entry down with it. Tab, newline and carriage return are the three XML
 * allows, so they stay.
 */
export function escapeXml(value: string): string {
  return (
    value
      // biome-ignore lint/suspicious/noControlCharactersInRegex: naming them is how they are removed
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
      .replace(/[&<>"']/g, (character) => XML_ESCAPES[character] as string)
  )
}

export interface SitemapAlternate {
  readonly hreflang: string
  readonly href: string
}

export interface SitemapEntry {
  readonly loc: string
  readonly lastmod?: Date | undefined
  readonly alternates?: readonly SitemapAlternate[] | undefined
}

export function sitemapXml(entries: readonly SitemapEntry[]): string {
  const urls = entries.map((entry) => {
    const parts = [`    <loc>${escapeXml(entry.loc)}</loc>`]

    if (entry.lastmod) parts.push(`    <lastmod>${entry.lastmod.toISOString()}</lastmod>`)

    for (const alternate of entry.alternates ?? []) {
      parts.push(
        `    <xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}"` +
          ` href="${escapeXml(alternate.href)}" />`,
      )
    }

    return `  <url>\n${parts.join('\n')}\n  </url>`
  })

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"' +
    ' xmlns:xhtml="http://www.w3.org/1999/xhtml">\n' +
    `${urls.join('\n')}\n` +
    '</urlset>\n'
  )
}

export interface FeedEntry {
  readonly id: string
  readonly title: string
  readonly href: string
  readonly updated: Date
  readonly published: Date | null
  readonly summary: string | null
  /** Already-rendered HTML, escaped into the document rather than wrapped. */
  readonly contentHtml: string | null
}

export interface FeedInput {
  readonly title: string
  readonly siteHref: string
  readonly selfHref: string
  readonly language: string
  readonly updated: Date
  readonly entries: readonly FeedEntry[]
}

/**
 * Atom rather than RSS 2.0. It states its own language, requires a stable id
 * per entry, and dates in one unambiguous format — three things a multilingual
 * CMS needs and RSS leaves to convention. Readers accept both.
 *
 * Content is escaped, never wrapped in CDATA: a CDATA section ends at the
 * first `]]>`, and that sequence can appear in a code block somebody
 * published.
 */
export function feedXml(input: FeedInput): string {
  const entries = input.entries.map((entry) => {
    const parts = [
      `    <title>${escapeXml(entry.title)}</title>`,
      `    <id>urn:uuid:${escapeXml(entry.id)}</id>`,
      `    <link rel="alternate" type="text/html" href="${escapeXml(entry.href)}" />`,
      `    <updated>${entry.updated.toISOString()}</updated>`,
    ]

    if (entry.published) parts.push(`    <published>${entry.published.toISOString()}</published>`)
    if (entry.summary) parts.push(`    <summary>${escapeXml(entry.summary)}</summary>`)
    if (entry.contentHtml) {
      parts.push(`    <content type="html">${escapeXml(entry.contentHtml)}</content>`)
    }

    return `  <entry>\n${parts.join('\n')}\n  </entry>`
  })

  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="${escapeXml(input.language)}">\n` +
    `  <title>${escapeXml(input.title)}</title>\n` +
    `  <id>${escapeXml(input.selfHref)}</id>\n` +
    `  <link rel="self" type="application/atom+xml" href="${escapeXml(input.selfHref)}" />\n` +
    `  <link rel="alternate" type="text/html" href="${escapeXml(input.siteHref)}" />\n` +
    `  <updated>${input.updated.toISOString()}</updated>\n` +
    `${entries.join('\n')}\n` +
    '</feed>\n'
  )
}
