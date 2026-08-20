import { describe, expect, it } from 'vitest'
import {
  BLOCK_TYPES,
  type Block,
  type BlockType,
  blockSchema,
  blocksSchema,
  blocksToPlainText,
  isSafeHref,
  renderBlocksToHtml,
} from './index.ts'

const id = '00000000-0000-4000-8000-000000000001'

function text(value: string) {
  return [{ type: 'text' as const, text: value }]
}

/**
 * One of every block type, typed as a total record so the compiler refuses a
 * new block type that nothing here exercises. The renderer and the plain-text
 * extractor are both driven from this, which is what stops a block from being
 * added and silently rendering to nothing.
 */
/*
 * A distinct id per sample, because these are also used as one document and
 * two blocks may not share an id — which the schema now refuses rather than
 * leaving to convention. They were all the same constant, and the document
 * test passed only because nothing checked.
 */
const ids = (n: number) => `0e5f2a6c-6a1e-4a1a-8f36-1f4a9d0f1c2${n}`

const SAMPLES: Record<BlockType, Block> = {
  paragraph: { id: ids(1), type: 'paragraph', content: text('A paragraph.') },
  heading: { id: ids(2), type: 'heading', level: 2, content: text('A heading') },
  quote: { id: ids(3), type: 'quote', content: text('A quotation'), attribution: 'Someone' },
  list: { id: ids(4), type: 'list', ordered: false, items: [text('First'), text('Second')] },
  code: { id: ids(5), type: 'code', language: 'ts', code: 'const x = 1' },
  image: { id: ids(6), type: 'image', mediaId: id, caption: text('A caption') },
  divider: { id: ids(7), type: 'divider' },
}

describe('isSafeHref', () => {
  it('accepts the schemes a link is allowed to use', () => {
    expect(isSafeHref('https://example.com/page')).toBe(true)
    expect(isSafeHref('http://example.com')).toBe(true)
    expect(isSafeHref('mailto:someone@example.com')).toBe(true)
  })

  it('accepts links that cannot leave the site', () => {
    expect(isSafeHref('/about')).toBe(true)
    expect(isSafeHref('#section')).toBe(true)
  })

  it('rejects the script-bearing schemes', () => {
    expect(isSafeHref('javascript:alert(1)')).toBe(false)
    expect(isSafeHref('JavaScript:alert(1)')).toBe(false)
    expect(isSafeHref('data:text/html,<script>alert(1)</script>')).toBe(false)
    expect(isSafeHref('vbscript:msgbox(1)')).toBe(false)
  })

  it('rejects a scheme smuggled past the check with control characters', () => {
    // A browser strips these before resolving, so a check that does not would
    // approve a string the browser later reads as javascript:.
    expect(isSafeHref('java\tscript:alert(1)')).toBe(false)
    expect(isSafeHref('java\nscript:alert(1)')).toBe(false)
    expect(isSafeHref('  javascript:alert(1)  ')).toBe(false)
  })

  it('rejects a scheme-relative URL, which silently changes origin', () => {
    expect(isSafeHref('//evil.example/page')).toBe(false)
  })

  it('rejects what it cannot resolve rather than guessing', () => {
    expect(isSafeHref('')).toBe(false)
    expect(isSafeHref('   ')).toBe(false)
    expect(isSafeHref('example.com/page')).toBe(false)
  })
})

describe('blockSchema', () => {
  it('accepts every sample', () => {
    for (const [type, block] of Object.entries(SAMPLES)) {
      expect(blockSchema.safeParse(block).success, type).toBe(true)
    }
  })

  it('refuses a block type that is not in the vocabulary', () => {
    expect(blockSchema.safeParse({ id, type: 'html', html: '<script>x</script>' }).success).toBe(
      false,
    )
  })

  it('refuses a mark that is not in the vocabulary', () => {
    const block = {
      id,
      type: 'paragraph',
      content: [{ type: 'text', text: 'x', marks: [{ type: 'blink' }] }],
    }
    expect(blockSchema.safeParse(block).success).toBe(false)
  })

  it('refuses an unsafe link at the door', () => {
    const block = {
      id,
      type: 'paragraph',
      content: [
        { type: 'text', text: 'x', marks: [{ type: 'link', href: 'javascript:alert(1)' }] },
      ],
    }
    expect(blockSchema.safeParse(block).success).toBe(false)
  })

  it('keeps headings below h1, which the document title owns', () => {
    expect(blockSchema.safeParse({ ...SAMPLES.heading, level: 1 }).success).toBe(false)
    expect(blockSchema.safeParse({ ...SAMPLES.heading, level: 5 }).success).toBe(false)
    expect(blockSchema.safeParse({ ...SAMPLES.heading, level: 3 }).success).toBe(true)
  })

  it('requires an id, so the editor and revisions can name a block', () => {
    const { id: _dropped, ...withoutId } = SAMPLES.paragraph
    expect(blockSchema.safeParse(withoutId).success).toBe(false)
    expect(blockSchema.safeParse({ ...SAMPLES.paragraph, id: 'not-a-uuid' }).success).toBe(false)
  })
})

describe('renderBlocksToHtml', () => {
  const resolveMedia = () => ({ src: '/media/x.avif', alt: 'A bicycle', width: 8, height: 6 })

  it('escapes text rather than trusting it', () => {
    const html = renderBlocksToHtml([
      { id, type: 'paragraph', content: text('<script>alert(1)</script>') },
    ])
    expect(html).not.toContain('<script>')
    expect(html).toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>')
  })

  it('escapes the attributes it writes, so a value cannot break out of one', () => {
    const html = renderBlocksToHtml([SAMPLES.image], {
      resolveMedia: () => ({ src: '/x.avif" onerror="alert(1)', alt: 'a" onload="alert(1)' }),
    })

    // The payload text surviving inside the value is fine and expected; what
    // matters is that no closing quote survived to start a new attribute, so
    // the browser never sees an event handler here.
    expect(html).not.toMatch(/\son\w+="/)
    expect(html).toContain('&quot;')
  })

  it('drops a link the schema would no longer accept but keeps the words', () => {
    // Rows written before a schema change are exactly this case.
    const html = renderBlocksToHtml([
      {
        id,
        type: 'paragraph',
        content: [{ type: 'text', text: 'click', marks: [{ type: 'link', href: 'javascript:x' }] }],
      },
    ])
    expect(html).toBe('<p>click</p>')
  })

  it('marks up a safe link, and only opts into a new tab when asked', () => {
    const link = (newTab?: boolean) =>
      renderBlocksToHtml([
        {
          id,
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'here',
              marks: [{ type: 'link', href: 'https://example.com', ...(newTab ? { newTab } : {}) }],
            },
          ],
        },
      ])

    expect(link()).toBe('<p><a href="https://example.com">here</a></p>')
    expect(link(true)).toContain('rel="noopener noreferrer"')
  })

  it('nests marks outside in, so the same content always renders the same', () => {
    const html = renderBlocksToHtml([
      {
        id,
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'italic' }] }],
      },
    ])
    expect(html).toBe('<p><strong><em>x</em></strong></p>')
  })

  it('drops a language hint that is not one', () => {
    const html = renderBlocksToHtml([
      { id, type: 'code', language: 'ts" onload="alert(1)', code: 'x' },
    ])
    expect(html).toBe('<pre><code>x</code></pre>')
  })

  it('renders nothing for an image it cannot resolve', () => {
    expect(renderBlocksToHtml([SAMPLES.image])).toBe('')
    expect(renderBlocksToHtml([SAMPLES.image], { resolveMedia })).toContain('<img')
  })

  it('produces markup for every block type', () => {
    for (const type of BLOCK_TYPES) {
      const html = renderBlocksToHtml([SAMPLES[type]], { resolveMedia })
      expect(html, `${type} rendered nothing`).not.toBe('')
      expect(html, `${type} emitted a raw tag`).not.toMatch(/<script|javascript:|on\w+=/i)
    }
  })
})

describe('blocksToPlainText', () => {
  it('reads text out of every block type that has any', () => {
    for (const type of BLOCK_TYPES) {
      if (type === 'divider') continue
      expect(blocksToPlainText([SAMPLES[type]]), `${type} contributed nothing`).not.toBe('')
    }
  })

  it('carries no markup, so an excerpt is safe wherever it is put', () => {
    const plain = blocksToPlainText([
      { id, type: 'paragraph', content: text('<b>bold</b> & plain') },
    ])
    expect(plain).toBe('<b>bold</b> & plain')
  })

  it('keeps list items on their own lines', () => {
    expect(blocksToPlainText([SAMPLES.list])).toBe('First\nSecond')
  })
})

describe('blocksSchema', () => {
  it('accepts a whole document', () => {
    expect(blocksSchema.safeParse(Object.values(SAMPLES)).success).toBe(true)
  })

  it('rejects the document if one block is bad', () => {
    expect(blocksSchema.safeParse([SAMPLES.paragraph, { id, type: 'html' }]).success).toBe(false)
  })
})
