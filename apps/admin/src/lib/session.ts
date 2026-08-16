import type { Capability, Role } from '@presslabz/core'
import type { Locale } from '@presslabz/i18n'
import type { ThemePreference } from '@presslabz/tokens'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from './api.ts'

export interface SessionUser {
  id: string
  email: string
  displayName: string
  role: Role
  locale: Locale
  themePreference: ThemePreference
  capabilities: Capability[]
}

export const SESSION_QUERY_KEY = ['session'] as const

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
        const body = await apiFetch<{ user: SessionUser }>('/auth/me')
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
      const body = await apiFetch<{ user: SessionUser }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
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
      // Clear everything, not just the session: any cached data belonged to
      // the user who just signed out.
      queryClient.clear()
      queryClient.setQueryData(SESSION_QUERY_KEY, null)
    },
  })
}

export function useSavePreferences() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (preferences: { locale?: Locale; themePreference?: ThemePreference }) =>
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
