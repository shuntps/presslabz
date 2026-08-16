import type { MessageKey } from '@presslabz/i18n'
import { Link, Outlet } from '@tanstack/react-router'
import { useContentTypes } from '../lib/content.ts'
import { useLocale } from '../lib/i18n.tsx'
import { useSignOut } from '../lib/session.ts'
import { LocaleSwitcher } from './locale-switcher.tsx'
import { ThemeSwitcher } from './theme-switcher.tsx'

/**
 * Navigation is words, not icons.
 *
 * An icon that reads as "Posts" in English reads as nothing at all in the
 * general case, and this product ships in two languages on the day it ships.
 * A word is already translated by the catalogue that translates everything
 * else, and it says exactly one thing.
 */

/**
 * Labels for the types PressLabz declares. A type from a plugin will bring
 * its own catalogue in phase 5; until then an unknown name renders as itself
 * rather than as a missing-key placeholder.
 */
const TYPE_LABELS: Record<string, MessageKey> = {
  post: 'content.type.post.plural',
  page: 'content.type.page.plural',
}

export function Shell() {
  const { t } = useLocale()
  const signOut = useSignOut()
  const { data: types } = useContentTypes()

  return (
    <div className="shell">
      <nav className="rail" aria-label={t('nav.compose')}>
        <Link to="/" className="wordmark">
          Press<i>Labz</i>
        </Link>

        <Link to="/" className="rail-link" activeOptions={{ exact: true }}>
          {t('nav.dashboard')}
        </Link>

        {types && types.length > 0 && (
          <>
            <p className="rail-group">{t('nav.compose')}</p>
            {types.map((type) => {
              const key = TYPE_LABELS[type.name]
              return (
                <Link
                  key={type.name}
                  to="/content/$type"
                  params={{ type: type.name }}
                  className="rail-link"
                >
                  {key ? t(key) : type.name}
                </Link>
              )
            })}
          </>
        )}
      </nav>

      <div className="frame">
        <header className="bar">
          <div className="bar-end">
            <LocaleSwitcher />
            <ThemeSwitcher />
            <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
              {t('auth.signOut')}
            </button>
          </div>
        </header>

        <Outlet />
      </div>
    </div>
  )
}
