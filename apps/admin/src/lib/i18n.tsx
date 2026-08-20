import {
  createTranslator,
  DEFAULT_LOCALE,
  type Locale,
  negotiateLocale,
  readLocaleCookie,
  type Translator,
} from '@presslabz/i18n'
import { applyLocale, setLocalePreference } from '@presslabz/i18n/dom'
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react'

interface LocaleContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: Translator
}

const LocaleContext = createContext<LocaleContextValue | null>(null)

/**
 * A choice already made, then the browser's own languages.
 *
 * The cookie is read first because it is what somebody chose here, on this
 * machine, and it is available before anything is fetched. Without it every
 * load started from `navigator.languages` and the stored preference arrived a
 * moment later with the session — a visible flip on every reload, and no way
 * at all for a visitor who is not signed in to keep a language.
 *
 * The negotiation is the same function the API uses, so the two cannot
 * disagree about what `fr-CA` resolves to. An unreadable cookie is no cookie:
 * `readLocaleCookie` answers null rather than throwing, because this runs
 * while the interface is initialising.
 */
function initialLocale(): Locale {
  if (typeof document !== 'undefined') {
    const chosen = readLocaleCookie(document.cookie)
    if (chosen) return chosen
  }

  if (typeof navigator === 'undefined') return DEFAULT_LOCALE
  return negotiateLocale(navigator.languages?.join(',') ?? navigator.language)
}

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale)

  /*
   * Cookie, `lang` attribute and state move together. They used to be three
   * separate acts — an effect for the attribute, nothing for the cookie —
   * which is how a document could end up announcing one language while the
   * interface spoke another.
   */
  const setLocale = useCallback((next: Locale) => {
    setLocalePreference(next, document)
    setLocaleState(next)
  }, [])

  /*
   * The attribute follows the language, including on the first paint, where
   * the language came from a cookie or from the browser and nothing has
   * written it down yet. An effect rather than a line in the render: touching
   * the document while rendering is a side effect in a function React may call
   * twice and may throw away.
   */
  useEffect(() => {
    applyLocale(locale, document)
  }, [locale])

  const value = useMemo<LocaleContextValue>(
    () => ({ locale, setLocale, t: createTranslator(locale) }),
    [locale, setLocale],
  )

  return <LocaleContext value={value}>{children}</LocaleContext>
}

export function useLocale(): LocaleContextValue {
  const value = use(LocaleContext)
  if (!value) throw new Error('useLocale must be used inside LocaleProvider')
  return value
}
