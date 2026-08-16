import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { App } from './app.tsx'
import { LocaleProvider } from './lib/i18n.tsx'
import { ThemeProvider } from './lib/theme.tsx'

/*
 * The admin had no behaviour test at all, and the fault that shipped from it
 * was not visible from either end: the API answered correctly and the
 * stylesheet was fine, while the interface kept rendering the signed-in shell
 * against a signed-out cookie. Nothing but rendering it could have said so.
 */

const user = {
  id: 'u1',
  email: 'someone@presslabz.test',
  displayName: 'Someone',
  role: 'administrator',
  locale: 'en',
  themePreference: 'system',
  capabilities: ['content:read', 'content:create'],
}

/** A fake API small enough to read, stateful enough to sign in and out of. */
function fakeApi() {
  const state = { signedIn: false, locale: 'en' }
  const calls: string[] = []

  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )

  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const route = `${init.method ?? 'GET'} ${url.pathname}`
    calls.push(route)

    switch (route) {
      case 'GET /auth/me':
        return state.signedIn ? json({ user: { ...user, locale: state.locale } }) : json({}, 401)
      case 'POST /auth/login':
        state.signedIn = true
        return json({ user: { ...user, locale: state.locale } })
      case 'POST /auth/logout':
        state.signedIn = false
        return Promise.resolve(new Response(null, { status: 204 }))
      case 'PATCH /auth/preferences': {
        const body = JSON.parse(String(init.body ?? '{}'))
        if (body.locale) state.locale = body.locale
        return json(body)
      }
      case 'GET /content-types':
        return state.signedIn
          ? json({ types: [{ name: 'post', hierarchical: false, taxonomies: [] }] })
          : json({}, 401)
      default:
        if (url.pathname.startsWith('/content/')) return json({ contents: [] })
        return json({}, 404)
    }
  })

  return { state, calls, fetchMock }
}

/**
 * The login form wraps its input in the label rather than pairing them by id,
 * so a text query matches both the label and the control. Naming the element
 * asks for the one that can be typed into.
 */
const findInput = (name: RegExp, selector = 'input') => screen.findByLabelText(name, { selector })
const getInput = (name: RegExp, selector = 'input') => screen.getByLabelText(name, { selector })

function renderApp() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })

  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ThemeProvider>
          <App />
        </ThemeProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  )
}

let api: ReturnType<typeof fakeApi>

beforeEach(() => {
  // The router is a module singleton, so a previous test's navigation would
  // otherwise decide where this one starts.
  window.history.pushState({}, '', '/')
  api = fakeApi()
  vi.stubGlobal('fetch', api.fetchMock)
})

afterEach(() => {
  // Registered by hand: Testing Library only hooks itself into afterEach when
  // vitest globals are on, and they are off here so every import stays
  // explicit. Without this the previous test's DOM is still mounted and every
  // query finds two of everything.
  cleanup()
  vi.unstubAllGlobals()
})

async function signIn() {
  await userEvent.type(await findInput(/email/i), 'someone@presslabz.test')
  await userEvent.type(getInput(/password/i), 'passphrase')
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
  await screen.findByRole('navigation')
}

describe('session', () => {
  it('shows the sign-in screen when nobody is signed in', async () => {
    renderApp()
    expect(await findInput(/email/i)).toBeDefined()
    expect(screen.queryByRole('navigation')).toBeNull()
  })

  it('shows the shell once signed in', async () => {
    renderApp()
    await signIn()
    expect(screen.getByRole('link', { name: /dashboard/i })).toBeDefined()
  })

  /**
   * The fault that shipped. queryClient.clear() removes the query object the
   * mounted observer is attached to, so the setQueryData after it wrote to an
   * entry nothing was reading — the API said 204 and the interface stayed
   * exactly where it was.
   */
  it('returns to the sign-in screen after signing out', async () => {
    renderApp()
    await signIn()

    await userEvent.click(screen.getByRole('button', { name: /sign out/i }))

    await waitFor(() => {
      expect(screen.queryByRole('navigation')).toBeNull()
    })
    expect(await findInput(/email/i)).toBeDefined()
    expect(api.calls).toContain('POST /auth/logout')
  })
})

describe('preferences', () => {
  /**
   * The other one: CORS refused PATCH, so this request never left the page.
   * Asserting the request is made is the half this side can prove; the API's
   * own suite asserts the method is allowed to arrive.
   */
  it('saves a language change and changes the interface with it', async () => {
    renderApp()
    await signIn()

    await userEvent.selectOptions(getInput(/language/i, 'select'), 'fr')

    await waitFor(() => {
      expect(api.calls).toContain('PATCH /auth/preferences')
    })
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /tableau de bord/i })).toBeDefined()
    })
  })

  it('records a theme choice without waiting for the server to agree', async () => {
    renderApp()
    await signIn()

    await userEvent.click(screen.getByRole('button', { name: /^dark$/i }))

    // The cookie is written first, so the choice survives a failed request or
    // a visitor who is not signed in at all.
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })
})
