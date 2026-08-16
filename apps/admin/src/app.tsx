import { RouterProvider } from '@tanstack/react-router'
import { useEffect } from 'react'
import { useLocale } from './lib/i18n.tsx'
import { useSession } from './lib/session.ts'
import { syncThemeFromServer } from './lib/theme.tsx'
import { router } from './router.tsx'
import { LoginPage } from './routes/login.tsx'

/**
 * The session gate sits above the router rather than inside it. Every route
 * below already has a user, so no route has to remember to guard itself, and
 * signing out returns here rather than navigating somewhere that then has to
 * decide what to do about it.
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

  return user ? <RouterProvider router={router} /> : <LoginPage />
}
