import { z } from 'zod'

/**
 * Slugs are the one piece of a document that lives in a URL, so they are
 * restricted rather than escaped: lowercase, digits, and single hyphens
 * between them. Anything a reader could mistake for a path segment, a query
 * or an encoded character simply cannot be stored.
 */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const slugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(SLUG_PATTERN, { error: 'Use lowercase letters, digits and single hyphens' })

/**
 * Suggests a slug from a title. A suggestion only — the author owns the slug,
 * and changing a published one breaks every link to it, so nothing calls this
 * on an existing document.
 *
 * Decomposing to NFKD and dropping the combining marks is what makes this
 * work for the launch locales rather than only for English: "Rôle" has to
 * become "role" and not "rle". Scripts with no Latin decomposition fall
 * through to nothing, which is why the caller must handle an empty result
 * instead of assuming a title always yields a slug.
 */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/g, '')
}

export function isSlug(value: unknown): value is string {
  return slugSchema.safeParse(value).success
}
