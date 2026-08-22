import { type SessionUser, sessionResponseSchema } from '@presslabz/core'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from './api.ts'

/*
 * Inferred, not restated. The interface that used to live here declared the
 * same six fields with the same types and was checked by nobody: it described
 * what the API was expected to send, and `apiFetch<{ user: SessionUser }>`
 * asserted that it had. Two declarations of one shape, and only one of them
 * ever looked at a response.
 */
export type { SessionUser }

const SESSION_QUERY_KEY = ['session'] as const

/**
 * A 401 is the expected answer for a signed-out visitor, not a failure, so it
 * resolves to null instead of throwing. Anything else is a real error and
 * must surface rather than silently render the sign-in page.
 */
export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: async (): Promise<SessionUser | null> => {
      try {
        const body = await apiFetch('/auth/me', { schema: sessionResponseSchema })
        return body.user
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) return null
        throw error
      }
    },
    retry: false,
    staleTime: 60_000,
  })
}

export function useSignIn() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (credentials: { email: string; password: string }) => {
      const body = await apiFetch('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
        schema: sessionResponseSchema,
      })
      return body.user
    },
    onSuccess: (user) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, user)
    },
  })
}

export function useSignOut() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: () => apiFetch<void>('/auth/logout', { method: 'POST' }),
    onSuccess: () => {
      /*
       * The session goes to null first, and the session entry is then left
       * alone while everything else is dropped.
       *
       * clear() removes the query object the mounted observer is attached to;
       * a setQueryData after it creates a fresh entry that nothing is
       * listening to, so the interface kept rendering the signed-in shell
       * with a signed-out cookie. Order matters, and so does not removing the
       * one query that is being read at that moment.
       */
      queryClient.setQueryData(SESSION_QUERY_KEY, null)

      // Anything else in the cache belonged to the user who just left.
      queryClient.removeQueries({
        predicate: (query) => query.queryKey[0] !== SESSION_QUERY_KEY[0],
      })
    },
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (preferences: {
      locale?: SessionUser['locale']
      themePreference?: SessionUser['themePreference']
    }) =>
      apiFetch<unknown>('/auth/preferences', {
        method: 'PATCH',
        body: JSON.stringify(preferences),
      }),
    onSuccess: (_result, preferences) => {
      queryClient.setQueryData(SESSION_QUERY_KEY, (current: SessionUser | null | undefined) =>
        current ? { ...current, ...preferences } : current,
      )
    },
  })
}
