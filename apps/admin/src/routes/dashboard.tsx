import { LocaleSwitcher } from '../components/locale-switcher.tsx'
import { ThemeSwitcher } from '../components/theme-switcher.tsx'
import { useLocale } from '../lib/i18n.tsx'
import { useSession, useSignOut } from '../lib/session.ts'

export function DashboardPage() {
  const { t } = useLocale()
  const { data: user } = useSession()
  const signOut = useSignOut()

  if (!user) return null

  return (
    <div className="shell">
      <header className="bar">
        <strong>{t('dashboard.title')}</strong>
        <div className="bar-end">
          <LocaleSwitcher />
          <ThemeSwitcher />
          <button type="button" onClick={() => signOut.mutate()} disabled={signOut.isPending}>
            {t('auth.signOut')}
          </button>
        </div>
      </header>

      <main className="content">
        <p>{t('dashboard.greeting', { name: user.displayName })}</p>

        <dl className="facts">
          <dt>{t('dashboard.role')}</dt>
          <dd>{user.role}</dd>
          <dt>{t('dashboard.capabilities')}</dt>
          <dd>
            <ul className="caps">
              {user.capabilities.map((capability) => (
                <li key={capability}>
                  <code>{capability}</code>
                </li>
              ))}
            </ul>
          </dd>
        </dl>

        <p className="muted">{t('dashboard.empty')}</p>
      </main>
    </div>
  )
}
