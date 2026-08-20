import { RouterProvider } from '@tanstack/react-router'
import { useEffect } from 'react'
import { API_URL, ApiError, NO_RESPONSE } from './lib/api.ts'
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
  const { data: user, isPending, isError, error, refetch } = useSession()

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
    /*
     * "Nothing answered" is not "something went wrong". The first is an
     * address problem the person reading can act on — the API is not running,
     * or something else holds the port — and saying which one it is, with the
     * address in the message, is the difference between a broken application
     * and a server that is not there. Until the request had a deadline this
     * state was unreachable: the query simply stayed pending and the screen
     * said "Loading…" for as long as the tab was open.
     */
    const unreachable = error instanceof ApiError && error.status === NO_RESPONSE

    return (
      <main className="centered">
        <p className="error" role="alert">
          {unreachable ? t('error.apiUnreachable', { url: API_URL }) : t('error.unexpected')}
        </p>
        {unreachable && <p className="muted">{t('error.apiUnreachableHint')}</p>}
        <button type="button" className="primary" onClick={() => void refetch()}>
          {t('common.retry')}
        </button>
      </main>
    )
  }

  return user ? <RouterProvider router={router} /> : <LoginPage />
}
