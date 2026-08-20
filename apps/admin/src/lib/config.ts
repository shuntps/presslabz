import { type InstallationConfig, installationConfigSchema } from '@presslabz/core'
import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './api.ts'

/**
 * What this installation serves, asked once and remembered.
 *
 * The admin used to offer every language PressLabz has a catalogue for, which
 * is a fact about the software rather than about the site: an installation
 * configured for English alone still invited somebody to start a French
 * translation, and the API took it. The server answers this question now, and
 * the interface draws the answer.
 *
 * Unauthenticated, because the sign-in screen has a language switcher and no
 * session; and stale for an hour, because a deployment variable does not
 * change while somebody is writing.
 */
const CONFIG_QUERY_KEY = ['config'] as const

export function useInstallationConfig() {
  return useQuery({
    queryKey: CONFIG_QUERY_KEY,
    queryFn: async () => apiFetch('/config', { schema: installationConfigSchema }),
    staleTime: 60 * 60_000,
  })
}

/**
 * The languages content may be written in, for a screen that must decide
 * before the answer arrives.
 *
 * Empty rather than the whole catalogue: offering a language and discovering
 * on save that the installation refuses it is worse than offering nothing for
 * the moment the request is in flight.
 */
export function servedLocales(config: InstallationConfig | undefined) {
  return config?.locales ?? []
}
