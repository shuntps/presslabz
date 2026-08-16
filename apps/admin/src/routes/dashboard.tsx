import { useLocale } from '../lib/i18n.tsx'
import { useSession } from '../lib/session.ts'

export function DashboardPage() {
  const { t } = useLocale()
  const { data: user } = useSession()

  if (!user) return null

  return (
    <main className="content">
      <div className="title-row">
        <h1 className="page-title">{t('dashboard.title')}</h1>
        <span className="rule" />
      </div>

      {/*
        All three type roles, in one list, doing the job they exist for: a
        name the user chose is set in the content face, while the role and
        the capability names came from the system and are set in the data
        face. Nothing here has to be labelled "machine-generated" — you can
        see it.
      */}
      <div className="panel">
        <dl className="facts">
          <dt>{t('dashboard.name')}</dt>
          <dd className="authored">{user.displayName}</dd>
          <dt>{t('dashboard.role')}</dt>
          <dd className="data">{user.role}</dd>
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
      </div>

      <p className="muted">{t('dashboard.empty')}</p>
    </main>
  )
}
