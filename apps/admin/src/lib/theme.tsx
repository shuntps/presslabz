import {
  readThemeCookie,
  setThemePreference,
  THEME_COOKIE_NAME,
  type ThemePreference,
  writeThemeCookie,
} from '@presslabz/tokens'
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

interface ThemeContextValue {
  preference: ThemePreference
  setPreference: (preference: ThemePreference) => void
  /** What the signed-in person chose somewhere else, on another machine. */
  syncFromServer: (preference: ThemePreference) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

/**
 * The pre-paint script in index.html has already applied the attribute by the
 * time React runs. This only mirrors the cookie into state so the control can
 * show which option is active — it must not re-apply on mount, or a system
 * preference would be frozen into an explicit one.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  /*
   * An unreadable cookie is no cookie. `readThemeCookie` answers null rather
   * than throwing on a malformed escape — `presslabz-theme=%E0%A4%A` used to
   * take the whole interface down from inside this initialiser, after the
   * pre-paint script had already rendered the page, so the admin showed a
   * blank screen and the console explained it to nobody.
   */
  const [preference, setPreferenceState] = useState<ThemePreference>(
    () => readThemeCookie(document.cookie) ?? 'system',
  )

  const setPreference = useCallback((next: ThemePreference) => {
    setThemePreference(next, document)
    setPreferenceState(next)
  }, [])

  /*
   * The same three things, from a different source. This used to apply the
   * attribute alone, so the page went dark while the control still read
   * "System" and the next reload undid it — the cookie, which is what
   * survives, had never been told.
   */
  const syncFromServer = useCallback(
    (next: ThemePreference) => {
      if (next !== preference) setPreference(next)
    },
    [preference, setPreference],
  )

  /*
   * A cookie that is present and unreadable is repaired rather than left to
   * fail every load. Writing the preference back replaces whatever is there
   * with something this build can read.
   */
  useEffect(() => {
    const stored = document.cookie.includes(`${THEME_COOKIE_NAME}=`)
    if (stored && readThemeCookie(document.cookie) === null) {
      writeThemeCookie(preference, document)
    }
    // Once, on mount: a cookie written afterwards is one this code wrote.
  }, [])

  const value = useMemo(
    () => ({ preference, setPreference, syncFromServer }),
    [preference, setPreference, syncFromServer],
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

export function useTheme(): ThemeContextValue {
  const value = use(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
