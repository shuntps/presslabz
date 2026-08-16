import {
  createTranslator,
  DEFAULT_LOCALE,
  LOCALE_TAGS,
  type Locale,
  negotiateLocale,
  type Translator,
} from '@presslabz/i18n'
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from 'react'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translator
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

/**
 * Before sign-in there is no stored preference, so the browser's own
 * languages decide. The same negotiation function the API uses runs here, so
 * the two cannot disagree about what `fr-CA` resolves to.
 */
function initialLocale(): Locale {
  if (typeof navigator === 'undefined') return DEFAULT_LOCALE
  return negotiateLocale(navigator.languages?.join(',') ?? navigator.language)
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocale] = useState<Locale>(initialLocale)

  useEffect(() => {
    document.documentElement.lang = LOCALE_TAGS[locale]
  }, [locale])

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale) }),
    [locale],
  )

  return <LocaleContext value={value}>{children}</LocaleContext>
}

export function useLocale(): LocaleContextValue {
  const value = use(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}
