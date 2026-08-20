import type { Blocks } from '@presslabz/blocks'
import {
  type ContentPage,
  type ContentStatus,
  type ContentSummary,
  type ContentTypeSummary,
  contentDocumentSchema,
  contentPageSchema,
  contentTypesSchema,
  type TranslationGroupSummary,
  type TranslationSet,
  translationSetSchema,
} from '@presslabz/core'
import type { Locale } from '@presslabz/i18n'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

/*
 * The shapes come from `@presslabz/core`, where the API's own tests parse its
 * responses with them. They used to be declared here, which made them a second
 * expression of the contract — one edited on a different day than the other.
 */
/** What a page of the listing carries, including the counts for its heading. */
export type {
  ContentPage,
  ContentSummary,
  ContentTypeSummary,
  TranslationGroupSummary,
  TranslationSet,
}

export function useContentTypes() {
  return useQuery({
    queryKey: ['content-types'],
    queryFn: async () => (await apiFetch('/content-types', { schema: contentTypesSchema })).types,
    staleTime: 5 * 60_000,
  })
}

/**
 * The listing, one page at a time, in translation groups.
 *
 * It used to ask for everything and get whatever the repository's default
 * capped it at — fifty documents, with no way to ask for the fifty-first,
 * which was in the database and unreachable from the interface that wrote it.
 * It also asked once per language and paired the results here, which cannot
 * survive paging: the second page of one language has no reason to hold the
 * partners of the second page of the other. The server pairs them now.
 */
export function useContentList(type: string, locale: Locale) {
  return useInfiniteQuery({
    queryKey: ['content', type, locale],
    queryFn: async ({ pageParam }) => {
      const search = new URLSearchParams({ locale })
      if (pageParam) search.set('cursor', pageParam)

      return apiFetch(`/content/${encodeURIComponent(type)}?${search.toString()}`, {
        schema: contentPageSchema,
      })
    },
    initialPageParam: '',
    // Null is the server saying this was the last page; returning undefined is
    // how React Query is told there is nothing more to fetch.
    getNextPageParam: (last: ContentPage) => last.nextCursor ?? undefined,
  })
}

/** The groups of every page fetched so far, in order. */
export function groupsOf(pages: readonly ContentPage[] | undefined): TranslationGroupSummary[] {
  return (pages ?? []).flatMap((page) => page.groups)
}

export function useContent(type: string, id: string) {
  return useQuery({
    queryKey: ['content', type, 'one', id],
    queryFn: async () =>
      (
        await apiFetch(`/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}`, {
          schema: contentDocumentSchema,
        })
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
        const body = await apiFetch(`/content/${encodeURIComponent(type)}`, {
          method: 'POST',
          body: JSON.stringify(draft),
          schema: contentDocumentSchema,
        })
        return body.content
      }

      // Locale is refused on update by the server — a document is one
      // translation — so it is not sent rather than sent and rejected.
      const { locale: _locale, translationGroupId: _group, ...patch } = draft
      const body = await apiFetch(
        `/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}`,
        { method: 'PATCH', body: JSON.stringify(patch), schema: contentDocumentSchema },
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
      apiFetch(`/content/${encodeURIComponent(type)}/${encodeURIComponent(id)}/translations`, {
        schema: translationSetSchema,
      }),
    enabled: id !== '',
  })
}
