import { z } from 'zod'
import {
  type AnyContentType,
  createContentTypeRegistry,
  defineContentType,
} from './content-types.ts'

/**
 * The two types PressLabz ships with. They are ordinary calls to
 * defineContentType with no privileged path — which is the point, and the
 * only way to know the declaration API is sufficient before phase 5 exposes
 * it to third-party code.
 */

/**
 * Shared metadata. Typed, so `meta.seo.description` is a field the editor can
 * render a control for and the renderer can read with confidence. Elsewhere it
 * is a row in a key-value table whose shape nobody can state.
 */
const seoSchema = z
  .object({
    title: z.string().max(70).optional(),
    description: z.string().max(160).optional(),
    /** Keeps a page out of search results without unpublishing it. */
    noindex: z.boolean().optional(),
  })
  .optional()

export const postType = defineContentType({
  name: 'post',
  /** Posts are the archive; `/en/blog/hello-world`. */
  basePath: 'blog',
  taxonomies: ['category', 'tag'],
  meta: z.object({
    seo: seoSchema,
    /** A reference, like every image block — never a URL copied into a row. */
    featuredMediaId: z.uuid().optional(),
  }),
  /*
   * The first use of the declaration, and the reason it exists: `featured
   * MediaId` used to be a key that a containment query elsewhere had to know
   * by name. Now the type says where its references are and nothing else has
   * to guess.
   */
  mediaIn: (meta) =>
    meta.featuredMediaId ? [{ mediaId: meta.featuredMediaId, at: 'featuredMediaId' }] : [],
})

export const pageType = defineContentType({
  name: 'page',
  /**
   * Pages sit at the locale root — `/en/about`, `/en/about/team` — which is
   * the only reason posts need a segment of their own.
   */
  basePath: '',
  /** Pages nest; posts do not. */
  hierarchical: true,
  meta: z.object({
    seo: seoSchema,
  }),
  /* Declared even though it is always empty: silence is not a declaration. */
  mediaIn: () => [],
})

export const BUILTIN_CONTENT_TYPES = [
  postType,
  pageType,
] as const satisfies readonly AnyContentType[]

/** Convenience for callers that have no plugin types to add yet. */
export function createBuiltinRegistry() {
  return createContentTypeRegistry(BUILTIN_CONTENT_TYPES)
}
