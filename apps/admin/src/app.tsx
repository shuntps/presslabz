import { RouterProvider } from '@tanstack/react-router'
import { useEffect } from 'react'
import { API_URL, ApiError, NO_RESPONSE } from './lib/api.ts'
import { useLocale } from './lib/i18n.tsx'
import { useSession } from './lib/session.ts'
import { useTheme } from './lib/theme.tsx'
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
  const { syncFromServer } = useTheme()
  const { data: user, isPending, isError, error, refetch } = useSession()

  /*
   * The stored preferences win over what the browser or a cookie guessed, so a
   * choice made on one machine follows the person to another. Both go through
   * the same functions a local choice uses — state, cookie and document
   * together — because the theme used to arrive by a path of its own that
   * touched the document and nothing else: the page went dark while the
   * control still read "System", and the next load undid it.
   */
  useEffect(() => {
    if (!user) return
    if (user.locale !== locale) setLocale(user.locale)
    syncFromServer(user.themePreference)
  }, [user, locale, setLocale, syncFromServer])

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
