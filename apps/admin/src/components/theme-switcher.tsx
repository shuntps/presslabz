import { THEME_PREFERENCES, type ThemePreference } from '@presslabz/tokens'
import { useLocale } from '../lib/i18n.tsx'
import { useSavePreferences, useSession } from '../lib/session.ts'
import { useTheme } from '../lib/theme.tsx'

const LABEL_KEYS = {
  light: 'theme.light',
  dark: 'theme.dark',
  system: 'theme.system',
} as const

export function ThemeSwitcher() {
  const { t } = useLocale()
  const { preference, setPreference } = useTheme()
  const { data: user } = useSession()
  const savePreferences = useSavePreferences()

  function choose(next: ThemePreference) {
    // Cookie first, so the choice survives even if the request fails or the
    // visitor is not signed in.
    setPreference(next)
    if (user) savePreferences.mutate({ themePreference: next })
  }

  return (
    <fieldset className="switcher segmented">
      <legend>{t('theme.label')}</legend>
      {THEME_PREFERENCES.map((option) => (
        <button
          key={option}
          type="button"
          aria-pressed={preference === option}
          onClick={() => choose(option)}
        >
          {t(LABEL_KEYS[option])}
        </button>
      ))}
    </fieldset>
  )
}
