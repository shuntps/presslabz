import type { Blocks } from '@presslabz/blocks'
import type { ContentStatus } from '@presslabz/core'
import type { Locale } from '@presslabz/i18n'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

export interface ContentSummary {
  id: string
  type: string
  locale: Locale
  translationGroupId: string
  slug: string
  status: ContentStatus
  title: string
  excerpt: string | null
  blocks: Blocks
  meta: Record<string, unknown>
  authorId: string | null
  parentId: string | null
  publishedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface ContentTypeSummary {
  name: string
  hierarchical: boolean
  taxonomies: string[]
}

/**
 * The navigation is built from what the server actually declares, so a type
 * added in code appears here without a second list to keep in step.
 */
export function useContentTypes() {
  return useQuery({
    queryKey: ['content-types'],
    queryFn: async () => (await apiFetch<{ types: ContentTypeSummary[] }>('/content-types')).types,
    staleTime: 5 * 60_000,
  })
}

export function useContentList(type: string, locale: Locale) {
  return useQuery({
    queryKey: ['content', type, locale],
    queryFn: async () =>
      (
        await apiFetch<{ contents: ContentSummary[] }>(
          `/content/${encodeURIComponent(type)}?locale=${encodeURIComponent(locale)}`,
        )
      ).contents,
  })
}

export interface TranslationGroup {
  translationGroupId: string
  /** The document in the locale being listed. Always present. */
  primary: ContentSummary
  /** Siblings in other languages, by locale. */
  siblings: Partial<Record<Locale, ContentSummary>>
}

/**
 * Groups a listing and the other languages' listings into translation pairs.
 *
 * The pair is the unit of work here, which is the thing a WordPress list table
 * cannot express — there a translation is a separate post that a plugin tries
 * to associate afterwards. Assembled from per-locale listings rather than one
 * cross-locale query because every read stays locale-scoped by design; a
 * dedicated endpoint is the answer once this list needs to paginate.
 */
export function groupTranslations(
  primary: ContentSummary[],
  others: ContentSummary[],
): TranslationGroup[] {
  const byGroup = new Map<string, TranslationGroup>()

  for (const row of primary) {
    byGroup.set(row.translationGroupId, {
      translationGroupId: row.translationGroupId,
      primary: row,
      siblings: {},
    })
  }

  for (const row of others) {
    const group = byGroup.get(row.translationGroupId)
    if (group) group.siblings[row.locale] = row
  }

  return [...byGroup.values()]
}
