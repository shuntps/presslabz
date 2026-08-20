import {
  type MediaPage,
  type MediaSummary,
  mediaDocumentSchema,
  mediaPageSchema,
} from '@presslabz/core'
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch, UPLOAD_TIMEOUT_MS } from './api.ts'

/*
 * The shapes come from `@presslabz/core`, where the API's own tests parse its
 * responses with them, rather than being declared a second time here.
 */
export type { MediaPage, MediaSummary }

export const MEDIA_QUERY_KEY = ['media'] as const

/** What React Query holds for an infinite query: the pages, and their cursors. */
interface PagedLibrary {
  pages: MediaPage[]
  pageParams: unknown[]
}

/**
 * The library, one page at a time.
 *
 * It used to ask for everything and receive whatever the repository's default
 * capped it at — sixty assets, with no way to ask for the sixty-first, which
 * was in the bucket, in the database, and unreachable from the interface that
 * uploaded it.
 *
 * Each page carries the answer about uploading, not just the assets. Showing
 * the upload control to everyone meant a contributor could choose a file, get
 * a 403, and read it as "that file is not an image this installation accepts"
 * — a refusal about them, reported as a fault in what they picked.
 */
export function useMediaLibrary() {
  return useInfiniteQuery({
    queryKey: MEDIA_QUERY_KEY,
    queryFn: async ({ pageParam }) =>
      apiFetch(pageParam ? `/media?cursor=${encodeURIComponent(pageParam)}` : '/media', {
        schema: mediaPageSchema,
      }),
    initialPageParam: '',
    getNextPageParam: (last: MediaPage) => last.nextCursor ?? undefined,
  })
}

/** The assets of every page fetched so far, in order. */
export function assetsOf(pages: readonly MediaPage[] | undefined): MediaSummary[] {
  return (pages ?? []).flatMap((page) => page.media)
}

/**
 * Multipart, so the content-type header is the browser's to set — it carries
 * the boundary, and a hand-written one would be wrong. apiFetch only names a
 * type when there is a JSON body, which is what makes this work.
 */
export function useUploadMedia() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', file)
      const body = await apiFetch('/media', {
        method: 'POST',
        body: form,
        schema: mediaDocumentSchema,
        // The one request whose length is the file rather than the server:
        // sent over the wire, then decoded and re-encoded twice behind a
        // queue. The ordinary fifteen seconds would refuse a large photo on
        // a slow connection.
        timeoutMs: UPLOAD_TIMEOUT_MS,
      })
      return body.media
    },
    onSuccess: (uploaded) => {
      /*
       * Put at the top of the first page, where the server would put it: the
       * library is newest first, and the cursor of every later page still
       * names the same row, so nothing shifts underneath the reader.
       */
      queryClient.setQueryData(MEDIA_QUERY_KEY, (current: PagedLibrary | undefined) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page, index) =>
                index === 0 ? { ...page, media: [uploaded, ...page.media] } : page,
              ),
            }
          : current,
      )
    },
  })
}

/**
 * Alt text is what a screen reader says instead of the image, so it is the one
 * piece of an asset that has to be editable after the upload — and the one the
 * server now gates on ownership. The interface only greys the field out; this
 * mutation exists so that the refusal, if it happens anyway, lands somewhere
 * the caller can see rather than silently.
 *
 * It sends **one language**, never the whole map. Posting a snapshot plus your
 * own edit is how two people describing the same image in two languages delete
 * each other's work: the server merges a patch against the row it has locked,
 * and can only do that if the request says what actually changed.
 */
export function useUpdateMediaAlt() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, locale, text }: { id: string; locale: string; text: string }) => {
      const body = await apiFetch(`/media/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        schema: mediaDocumentSchema,
        // An empty description is an absent one, not an empty string somebody
        // has to read past.
        body: JSON.stringify({ alt: { [locale]: text === '' ? null : text } }),
      })
      return body.media
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(MEDIA_QUERY_KEY, (current: PagedLibrary | undefined) =>
        current
          ? {
              ...current,
              pages: current.pages.map((page) => ({
                ...page,
                media: page.media.map((asset) => (asset.id === updated.id ? updated : asset)),
              })),
            }
          : current,
      )
    },
  })
}
