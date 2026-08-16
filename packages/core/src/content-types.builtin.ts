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
 * render a control for and the renderer can read with confidence. In
 * WordPress this is a row in wp_postmeta whose shape nobody can state.
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
  taxonomies: ['category', 'tag'],
  meta: z.object({
    seo: seoSchema,
    /** A reference, like every image block — never a URL copied into a row. */
    featuredMediaId: z.uuid().optional(),
  }),
})

export const pageType = defineContentType({
  name: 'page',
  /** Pages nest; posts do not. */
  hierarchical: true,
  meta: z.object({
    seo: seoSchema,
  }),
})

export const BUILTIN_CONTENT_TYPES = [
  postType,
  pageType,
] as const satisfies readonly AnyContentType[]

/** Convenience for callers that have no plugin types to add yet. */
export function createBuiltinRegistry() {
  return createContentTypeRegistry(BUILTIN_CONTENT_TYPES)
}
