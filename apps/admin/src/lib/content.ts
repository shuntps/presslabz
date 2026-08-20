import type { Blocks } from '@presslabz/blocks'
import type { ContentStatus, CreationPermissions, DocumentPermissions } from '@presslabz/core'
import type { Locale } from '@presslabz/i18n'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

/*
 * The permission shapes are imported from core rather than restated here.
 * Retyping them would be the first half of reimplementing the policy: two
 * declarations that agree today and are edited on different days.
 */
export interface ContentSummary {
  /** What this actor may do with this document, decided by the server. */
  permissions: DocumentPermissions
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
  /** What an edit of this document has to state to be accepted. */
  version: number
  createdAt: string
  updatedAt: string
}

export interface ContentTypeSummary {
  name: string
  hierarchical: boolean
  taxonomies: string[]
  /** What this actor could create of this type, for a document with no row yet. */
  permissions: CreationPermissions
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

export function useContent(type: string, id: string) {
  return useQuery({
    queryKey: ['content', type, 'one', id],
    queryFn: async () =>
      (
        await apiFetch<{ content: ContentSummary }>(
          `/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
        )
      ).content,
    // Creating a document mounts this hook with nothing to fetch.
    enabled: id !== '',
  })
}

export interface ContentDraft {
  locale: Locale
  slug: string
  title: string
  /**
   * Null clears, absent leaves alone.
   *
   * The editor sends null for a field it emptied rather than omitting it,
   * because a patch that omits a field is saying "do not touch" — which is why
   * an excerpt could be written and never removed.
   */
  excerpt?: string | null | undefined
  status: ContentStatus
  blocks: Blocks
  publishedAt?: string | null | undefined
  translationGroupId?: string | undefined
  /**
   * The version the editor was looking at. Required on every update: without
   * it two editors overwrite each other with nothing to show for it.
   */
  expectedVersion?: number | undefined
}

/**
 * One mutation for both cases. Creating and editing differ only in which
 * request goes out; the screen behind them is the same screen, so it should
 * not have to know which one it is.
 */
export function useSaveContent(type: string, id: string | null) {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (draft: ContentDraft) => {
      if (id === null) {
        const body = await apiFetch<{ content: ContentSummary }>(
          `/content/${encodeURIComponent(type)}`,
          { method: 'POST', body: JSON.stringify(draft) },
        )
        return body.content
      }

      // Locale is refused on update by the server — a document is one
      // translation — so it is not sent rather than sent and rejected.
      const { locale: _locale, translationGroupId: _group, ...patch } = draft
      const body = await apiFetch<{ content: ContentSummary }>(
        `/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch) },
      )
      return body.content
    },
    onSuccess: (content) => {
      queryClient.setQueryData(['content', type, 'one', content.id], content)
      // The listings are one language each and this document is in one of
      // them, but a status change moves it between filters, so both go.
      queryClient.invalidateQueries({ queryKey: ['content', type] })
    },
  })
}

export interface TranslationSet {
  translations: ContentSummary[]
  /**
   * Whether a translation may be started in this group. Not the same question
   * as "may create a document of this type": joining an existing group also
   * needs the right to write one of its members as it currently stands, and a
   * contributor whose draft an editor published no longer has it.
   */
  permissions: { create: boolean }
}

/**
 * Crosses locales on purpose, like the endpoint behind it. Everything the
 * editor says about a document's siblings comes from here rather than from a
 * listing that quietly dropped its locale filter — including whether to offer
 * starting the language that is missing.
 */
export function useTranslations(type: string, id: string) {
  return useQuery({
    queryKey: ['content', type, 'translations', id],
    queryFn: async () =>
      apiFetch<TranslationSet>(
        `/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}/translations`,
      ),
    enabled: id !== '',
  })
}
