import { type FormEvent, useState } from 'react'
import { LocaleSwitcher } from '../components/locale-switcher.tsx'
import { ThemeSwitcher } from '../components/theme-switcher.tsx'
import { ApiError } from '../lib/api.ts'
import { messageForError } from '../lib/errors.ts'
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

  /*
   * Only a 401 means the credentials were wrong. Everything else said so too:
   * an unreachable API, a request that timed out, a rate limit and a 500 were
   * all reported as "that email and password do not match" — an accusation
   * about the person, for a fault that was never theirs, and one they could
   * only respond to by retyping a correct password.
   *
   * The 429 is contextual on purpose. The shared table answers a neutral
   * "too many requests" now, because every route sits behind the global
   * limiter and an upload hitting it is nobody's "attempts" — but here the
   * attempts really are the person's own sign-ins, so this screen keeps the
   * message that says so.
   */
  const errorKey =
    signIn.error instanceof ApiError && signIn.error.status === 401
      ? 'auth.invalidCredentials'
      : signIn.error instanceof ApiError && signIn.error.status === 429
        ? 'auth.tooManyAttempts'
        : messageForError(signIn.error)

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
