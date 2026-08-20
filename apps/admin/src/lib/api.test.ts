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

describe('a request nothing answers', () => {
  /**
   * A fetch that behaves like the network does: it settles only when its
   * signal aborts. `vi.fn(() => new Promise(() => {}))` would hang the test
   * instead of the request.
   */
  function neverAnswers() {
    const fetchSpy = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    )
    vi.stubGlobal('fetch', fetchSpy)
    return fetchSpy
  }

  /*
   * The state this exists to end: a server that accepts the connection and
   * never answers left the promise pending for as long as the tab was open,
   * so the query never settled and the admin sat on "Loading…" — no error, no
   * retry, nothing to act on, and nothing in the log either, because the
   * request never reached the API at all.
   */
  it('gives up, and says nothing answered rather than staying pending', async () => {
    neverAnswers()
    const { ApiError, apiFetch, NO_RESPONSE } = await import('./api.ts')

    const failure = await apiFetch('/auth/me', { timeoutMs: 20 }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as InstanceType<typeof ApiError>).status).toBe(NO_RESPONSE)
    expect((failure as InstanceType<typeof ApiError>).code).toBe('timeout')
  })

  it('says the same about an address with nothing behind it', async () => {
    // What fetch does when the connection is refused or CORS blocks the
    // answer: it rejects with a TypeError that says nothing useful.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )
    const { ApiError, apiFetch, NO_RESPONSE } = await import('./api.ts')

    const failure = await apiFetch('/auth/me').catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(ApiError)
    expect((failure as InstanceType<typeof ApiError>).status).toBe(NO_RESPONSE)
    expect((failure as InstanceType<typeof ApiError>).code).toBe('unreachable')
  })

  it('lets a caller who cancelled deliberately have their own abort back', async () => {
    // A component that unmounts is not a failure to report, and dressing its
    // cancellation as "the API did not answer" would put that on screen.
    neverAnswers()
    const { ApiError, apiFetch } = await import('./api.ts')

    const controller = new AbortController()
    const pending = apiFetch('/auth/me', { signal: controller.signal }).catch(
      (error: unknown) => error,
    )
    controller.abort()

    expect(await pending).not.toBeInstanceOf(ApiError)
  })

  it('waits longer for an upload than for anything else', async () => {
    // An upload is sent over the wire and then decoded and re-encoded twice,
    // behind a queue; fifteen seconds would refuse a large photo on a slow
    // connection.
    const { REQUEST_TIMEOUT_MS, UPLOAD_TIMEOUT_MS } = await import('./api.ts')

    expect(UPLOAD_TIMEOUT_MS).toBeGreaterThan(REQUEST_TIMEOUT_MS)
  })
})
