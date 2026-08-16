import { isLocale, LOCALE_LABELS, LOCALES } from '@presslabz/i18n'
import { useLocale } from '../lib/i18n.tsx'
import { useSavePreferences, useSession } from '../lib/session.ts'

export function LocaleSwitcher() {
  const { locale, setLocale, t } = useLocale()
  const { data: user } = useSession()
  const savePreferences = useSavePreferences()

  return (
    <label className="switcher">
      <span>{t('locale.label')}</span>
      <select
        value={locale}
        onChange={(event) => {
          const next = event.target.value
          if (!isLocale(next)) return
          setLocale(next)
          if (user) savePreferences.mutate({ locale: next })
        }}
      >
        {LOCALES.map((option) => (
          <option key={option} value={option}>
            {LOCALE_LABELS[option]}
          </option>
        ))}
      </select>
    </label>
  )
}
