import { z } from 'zod'

/**
 * Inline content — the text inside a block, and the marks on it.
 *
 * Storing a paragraph as a string of HTML — which is how the classic content
 * managers do it — is why formatting, links and script all arrive through the
 * same door. Here a run of text is a node and its formatting is a list of
 * marks, so there is no place for markup to hide: anything that is not in the
 * whitelist below cannot be represented at all, let alone stored.
 */

/**
 * The schemes a link may use.
 *
 * `javascript:` is the classic stored-XSS vector and `data:` lets an author
 * hand a reader a whole document from your origin. Relative links and
 * fragments are allowed because they cannot leave the site.
 */
export const ALLOWED_LINK_SCHEMES = ['http:', 'https:', 'mailto:'] as const

/**
 * Browsers strip tab, newline and carriage return from a URL before they
 * resolve it, so `java&#9;script:alert(1)` navigates to `javascript:alert(1)`.
 * A check that does not strip them first passes a string the browser will
 * later read differently — which is the whole trick.
 */
export function isSafeHref(href: string): boolean {
  const normalized = href.replace(/[\t\n\r]/g, '').trim()
  if (normalized === '') return false

  // Scheme-relative: `//evil.example` silently points at another origin.
  if (normalized.startsWith('//')) return false
  if (normalized.startsWith('/') || normalized.startsWith('#')) return true

  let url: URL
  try {
    url = new URL(normalized)
  } catch {
    // Not absolute and not one of the relative forms above. A bare
    // `example.com/page` is ambiguous, so it is rejected rather than guessed at.
    return false
  }

  return (ALLOWED_LINK_SCHEMES as readonly string[]).includes(url.protocol)
}

export const markSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bold') }),
  z.object({ type: z.literal('italic') }),
  z.object({ type: z.literal('strike') }),
  z.object({ type: z.literal('code') }),
  z.object({
    type: z.literal('link'),
    href: z.string().max(2048).refine(isSafeHref, {
      message: 'Link scheme is not allowed',
    }),
    /** Author's choice, not the renderer's: some links should stay in place. */
    newTab: z.boolean().optional(),
  }),
])

export type Mark = z.infer<typeof markSchema>

/**
 * One node for now. It stays an object rather than a single-member union
 * because a union of one is noise; when a second inline node exists — a hard
 * break, a footnote reference — this becomes a discriminated union on `type`
 * and every consumer already switches on it.
 */
export const inlineNodeSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
  marks: z.array(markSchema).max(8).optional(),
})

export type InlineNode = z.infer<typeof inlineNodeSchema>

export const inlineContentSchema = z.array(inlineNodeSchema)

export type InlineContent = z.infer<typeof inlineContentSchema>
