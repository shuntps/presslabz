import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { UserConfig } from 'vite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import viteConfig from '../../vite.config.ts'

/*
 * Where the admin sends its requests, and where that setting comes from.
 *
 * Both halves failed together in the browser: the admin was open on
 * http://127.0.0.1:5173 and calling http://localhost:3000, the API allowed
 * only http://localhost:5173, and the browser blocked the answer to
 * /auth/me — so apiFetch saw a network error instead of a 401 and the
 * interface showed a breakage instead of the sign-in form. Pointing the admin
 * at the other host was supposed to be a configuration change, and was not:
 * Vite reads .env from its own project root, so VITE_API_URL in the
 * monorepo's .env reached nothing.
 */

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

function respondWith(body: unknown, status = 200) {
  // Typed with fetch's own parameters, so the recorded call carries the URL
  // and the init this asserts on rather than an empty tuple.
  const fetchSpy = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  )
  vi.stubGlobal('fetch', fetchSpy)
  return fetchSpy
}

describe('the API base URL', () => {
  it('is the one the installation configured', async () => {
    // The whole of the 127.0.0.1 alternative, on this side: one variable.
    vi.stubEnv('VITE_API_URL', 'http://127.0.0.1:3000')
    vi.resetModules()

    const fetchSpy = respondWith({ user: null })
    const { apiFetch } = await import('./api.ts')
    await apiFetch('/auth/me')

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3000/auth/me')
  })

  it('treats an empty setting as no setting, not as same-origin', async () => {
    // `VITE_API_URL=` in .env means "not set yet". Resolving to relative paths
    // would send every request to the dev server instead of the API.
    vi.stubEnv('VITE_API_URL', '   ')
    vi.resetModules()

    const fetchSpy = respondWith({ user: null })
    const { apiFetch } = await import('./api.ts')
    await apiFetch('/auth/me')

    expect(fetchSpy.mock.calls[0]?.[0]).toBe('http://localhost:3000/auth/me')
  })

  it('sends credentials, which is what carries the session cookie', async () => {
    const fetchSpy = respondWith({ user: null })
    const { apiFetch } = await import('./api.ts')
    await apiFetch('/auth/me')

    expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ credentials: 'include' })
  })
})

describe('a failing response', () => {
  it('becomes an ApiError carrying the status', async () => {
    /*
     * A 401 from /auth/me is the normal answer for a visitor with no session,
     * and useSession turns it into "signed out". That only works if the
     * response is readable: when CORS blocks it, fetch rejects and this throws
     * a TypeError instead, which is what put a breakage on screen.
     */
    respondWith({ error: 'unauthorized' }, 401)
    const { ApiError, apiFetch } = await import('./api.ts')

    const failure = await apiFetch('/auth/me').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as InstanceType<typeof ApiError>).status).toBe(401)
    expect((failure as InstanceType<typeof ApiError>).code).toBe('unauthorized')
  })
})

describe('where configuration comes from', () => {
  it('reads the monorepo root, not the app directory', async () => {
    /*
     * Without this, `VITE_API_URL` in the root .env is read by the API and
     * ignored by the admin — the setting appears to exist and does nothing.
     *
     * Vite resolves envDir against the project root, which is the directory
     * holding the config; vitest runs with that same directory as its working
     * directory, so resolving it here lands where Vite lands.
     */
    const { envDir } = viteConfig as UserConfig
    expect(envDir).toBeTypeOf('string')

    const root = resolve(process.cwd(), envDir as string)
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true)
    expect(existsSync(join(root, '.env.example'))).toBe(true)
  })
})
