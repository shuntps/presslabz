import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

export interface MediaRendition {
  name: string
  url: string
  contentType: string
  byteSize: number
}

export interface MediaSummary {
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

export function useMediaLibrary() {
  return useQuery({
    queryKey: MEDIA_QUERY_KEY,
    queryFn: async () => (await apiFetch<{ media: MediaSummary[] }>('/media')).media,
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
      const body = await apiFetch<{ media: MediaSummary }>('/media', { method: 'POST', body: form })
      return body.media
    },
    onSuccess: (uploaded) => {
      queryClient.setQueryData(MEDIA_QUERY_KEY, (current: MediaSummary[] | undefined) =>
        current ? [uploaded, ...current] : [uploaded],
      )
    },
  })
}
