import { useEffect } from 'react'
import { useLocale } from './lib/i18n.tsx'
import { useSession } from './lib/session.ts'
import { syncThemeFromServer } from './lib/theme.tsx'
import { DashboardPage } from './routes/dashboard.tsx'
import { LoginPage } from './routes/login.tsx'

/**
 * Routing stays deliberately trivial while there are two screens. TanStack
 * Router arrives with the content routes in phase 2, when there is a tree
 * worth describing; introducing it now would be machinery around a boolean.
 */
export function App() {
  const { t, locale, setLocale } = useLocale()
  const { data: user, isPending, isError } = useSession()

  // The signed-in user's stored preferences win over what the browser or the
  // cookie guessed, so a choice made on one machine follows them to another.
  useEffect(() => {
    if (!user) return
    if (user.locale !== locale) setLocale(user.locale)
    syncThemeFromServer(user.themePreference)
  }, [user, locale, setLocale])

  if (isPending) {
    return (
      <main className="centered">
        <p className="muted">{t('common.loading')}</p>
      </main>
    )
  }

  if (isError) {
    return (
      <main className="centered">
        <p className="error" role="alert">
          {t('error.unexpected')}
        </p>
      </main>
    )
  }

  return user ? <DashboardPage /> : <LoginPage />
}
