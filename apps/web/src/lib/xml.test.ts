import { describe, expect, it } from 'vitest'
import { escapeXml, feedXml, sitemapXml } from './xml.ts'

const WHEN = new Date('2026-08-20T12:00:00.000Z')

describe('escapeXml', () => {
  it('escapes everything that could close a tag or an attribute', () => {
    expect(escapeXml(`<a href="x">& '`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp; &apos;')
  })

  /*
   * A title is text an author typed. These characters are not merely ugly in
   * XML — they are forbidden, so one of them in one title makes the whole
   * document unparseable and takes every other entry down with it.
   */
  it('drops the control characters XML cannot carry, and keeps the three it can', () => {
    expect(escapeXml('be\u0007fore')).toBe('before')
    expect(escapeXml('also\u0000gone')).toBe('alsogone')
    expect(escapeXml('kept\tand\nkept\r')).toBe('kept\tand\nkept\r')
  })
})

describe('sitemapXml', () => {
  it('lists a URL with its date and its alternates', () => {
    const xml = sitemapXml([
      {
        loc: 'https://example.com/en/blog/hello',
        lastmod: WHEN,
        alternates: [{ hreflang: 'fr', href: 'https://example.com/fr/blog/bonjour' }],
      },
    ])

    expect(xml).toContain('<loc>https://example.com/en/blog/hello</loc>')
    expect(xml).toContain('<lastmod>2026-08-20T12:00:00.000Z</lastmod>')
    expect(xml).toContain('hreflang="fr"')
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true)
  })

  it('cannot be escaped out of by a URL that contains markup', () => {
    const xml = sitemapXml([{ loc: 'https://example.com/en/</loc><script>' }])

    expect(xml).not.toContain('<script>')
    expect(xml).toContain('&lt;/loc&gt;&lt;script&gt;')
  })
})

describe('feedXml', () => {
  const base = {
    title: 'PressLabz',
    siteHref: 'https://example.com/en',
    selfHref: 'https://example.com/en/blog/feed.xml',
    language: 'en',
    updated: WHEN,
  }

  it('states its language and links back to itself', () => {
    const xml = feedXml({ ...base, entries: [] })

    expect(xml).toContain('xml:lang="en"')
    expect(xml).toContain('rel="self"')
    expect(xml).toContain('href="https://example.com/en/blog/feed.xml"')
  })

  it('carries an entry with a stable id and its content', () => {
    const xml = feedXml({
      ...base,
      entries: [
        {
          id: '0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c22',
          title: 'Hello',
          href: 'https://example.com/en/blog/hello',
          updated: WHEN,
          published: WHEN,
          summary: 'A summary',
          contentHtml: '<p>Body</p>',
        },
      ],
    })

    expect(xml).toContain('<id>urn:uuid:0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c22</id>')
    expect(xml).toContain('<content type="html">&lt;p&gt;Body&lt;/p&gt;</content>')
  })

  /*
   * The reason content is escaped rather than wrapped in CDATA: a section ends
   * at the first `]]>`, and a code block can contain one.
   */
  it('survives content that would close a CDATA section', () => {
    const xml = feedXml({
      ...base,
      entries: [
        {
          id: 'x',
          title: 'Tricky',
          href: 'https://example.com/en/blog/tricky',
          updated: WHEN,
          published: null,
          summary: null,
          contentHtml: '<pre>]]> & </feed></pre>',
        },
      ],
    })

    expect(xml).not.toContain('</feed></pre>')
    expect(xml.match(/<\/feed>/g)).toHaveLength(1)
  })
})
