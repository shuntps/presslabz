import {
  applyTheme,
  readThemeCookie,
  setThemePreference,
  type ThemePreference,
} from '@presslabz/tokens'
import { createContext, type ReactNode, use, useCallback, useMemo, useState } from 'react'

interface ThemeContextValue {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * The pre-paint script in index.html has already applied the attribute by the
 * time React runs. This only mirrors the cookie into state so the control can
 * show which option is active — it must not re-apply on mount, or a system
 * preference would be frozen into an explicit one.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => readThemeCookie(document.cookie) ?? 'system',
  )

  const setPreference = useCallback((next: ThemePreference) => {
    setThemePreference(next, document)
    setPreferenceState(next)
  }, [])

  const value = useMemo(() => ({ preference, setPreference }), [preference, setPreference])

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}

/** Used when the server tells us what the signed-in user chose elsewhere. */
export function syncThemeFromServer(preference: ThemePreference): void {
  applyTheme(preference, document.documentElement)
}
