import { type FormEvent, useState } from 'react'
import { LocaleSwitcher } from '../components/locale-switcher.tsx'
import { ThemeSwitcher } from '../components/theme-switcher.tsx'
import { ApiError } from '../lib/api.ts'
import { useLocale } from '../lib/i18n.tsx'
import { useSignIn } from '../lib/session.ts'

export function LoginPage() {
  const { t } = useLocale()
  const signIn = useSignIn()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  function onSubmit(event: FormEvent) {
    event.preventDefault()
    signIn.mutate({ email, password })
  }

  // 429 gets its own message: telling someone their password is wrong when
  // they have actually been rate limited sends them in circles.
  const errorKey =
    signIn.error instanceof ApiError && signIn.error.status === 429
      ? 'auth.tooManyAttempts'
      : 'auth.invalidCredentials'

  return (
    <main className="centered">
      <form className="card" onSubmit={onSubmit}>
        {/* The wordmark's second half carries the rubric. It is the only
            coloured thing in the chrome, here and in the shell's top bar. */}
        <h1 className="wordmark">
          Press<i>Labz</i>
        </h1>
        <p className="tagline">{t('auth.tagline')}</p>

        <label>
          <span>{t('auth.email')}</span>
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label>
          <span>{t('auth.password')}</span>
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {signIn.isError && (
          <p className="error" role="alert">
            {t(errorKey)}
          </p>
        )}

        <button type="submit" className="primary" disabled={signIn.isPending}>
          {signIn.isPending ? t('auth.signingIn') : t('auth.signIn')}
        </button>
      </form>

      <div className="switchers">
        <LocaleSwitcher />
        <ThemeSwitcher />
      </div>
    </main>
  )
}
