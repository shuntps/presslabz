import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch, UPLOAD_TIMEOUT_MS } from './api.ts'

export interface MediaRendition {
  name: string
  url: string
  contentType: string
  byteSize: number
}

export interface MediaSummary {
  /**
   * Whether this actor may edit the asset's metadata. Server-decided: whether
   * `media:update:own` is enough depends on who uploaded this row, which is
   * not something the client can work out from a capability list.
   */
  permissions: { update: boolean }
  id: string
  url: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  alt: Record<string, string>
  createdAt: string
  renditions: MediaRendition[]
}

export const MEDIA_QUERY_KEY = ['media'] as const

export interface MediaLibrary {
  media: MediaSummary[]
  /** Whether this actor may add to the library at all. */
  permissions: { upload: boolean }
}

/**
 * The listing carries the answer about uploading, not just the assets.
 *
 * Showing the upload control to everyone meant a contributor could choose a
 * file, get a 403, and read it as "that file is not an image this installation
 * accepts" — a refusal about them, reported as a fault in what they picked.
 */
export function useMediaLibrary() {
  return useQuery({
    queryKey: MEDIA_QUERY_KEY,
    queryFn: async () => apiFetch<MediaLibrary>('/media'),
  })
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
      const body = await apiFetch<{ media: MediaSummary }>('/media', {
        method: 'POST',
        body: form,
        // The one request whose length is the file rather than the server:
        // sent over the wire, then decoded and re-encoded twice behind a
        // queue. The ordinary fifteen seconds would refuse a large photo on
        // a slow connection.
        timeoutMs: UPLOAD_TIMEOUT_MS,
      })
      return body.media
    },
    onSuccess: (uploaded) => {
      queryClient.setQueryData(MEDIA_QUERY_KEY, (current: MediaLibrary | undefined) =>
        current ? { ...current, media: [uploaded, ...current.media] } : current,
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
      const body = await apiFetch<{ media: MediaSummary }>(`/media/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        // An empty description is an absent one, not an empty string somebody
        // has to read past.
        body: JSON.stringify({ alt: { [locale]: text === '' ? null : text } }),
      })
      return body.media
    },
    onSuccess: (updated) => {
      queryClient.setQueryData(MEDIA_QUERY_KEY, (current: MediaLibrary | undefined) =>
        current
          ? { ...current, media: current.media.map((i) => (i.id === updated.id ? updated : i)) }
          : current,
      )
    },
  })
}
