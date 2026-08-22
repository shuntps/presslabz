/*
 * These tests write cookies directly because that is what a browser arrives
 * with: a value from a previous visit, or from something else on the host.
 * The rule this suppresses exists for application code, which has helpers.
 */
// biome-ignore-all lint/suspicious/noDocumentCookie: standing in for a browser
import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'
import { API_URL } from './lib/api.ts'
import {
  fakeApi,
  findInput,
  forgetPreferences,
  getInput,
  renderApp,
  signIn,
} from './test-utils.tsx'

/*
 * The admin had no behaviour test at all, and the fault that shipped from it
 * was not visible from either end: the API answered correctly and the
 * stylesheet was fine, while the interface kept rendering the signed-in shell
 * against a signed-out cookie. Nothing but rendering it could have said so.
 */

let api: ReturnType<typeof fakeApi>

beforeEach(() => {
  forgetPreferences()
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
    expect(api.requests.map((r) => r.route)).toContain('POST /auth/logout')
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
      expect(api.requests.map((r) => r.route)).toContain('PATCH /auth/preferences')
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

describe('starting a document from the rail', () => {
  /*
   * The fault reported: "Compose" is a group heading, not a link, so the rail
   * offered nothing to click and the only way to begin writing was to reach a
   * listing first and find the button there. Nobody opens a CMS to look at a
   * listing.
   */
  it('offers a way to begin one, per type', async () => {
    renderApp()
    await signIn()

    // One type in the fake, which is enough: the rail builds a row per type it
    // is told about, so a second would be the same assertion twice.
    const posts = await screen.findByRole('link', { name: /new posts/i })

    expect(posts.getAttribute('href')).toBe('/content/post/new')
  })

  /*
   * Offering it to somebody the server would refuse is offering a form that
   * cannot be saved. The answer comes from the server, like every other one.
   */
  it('offers nothing to somebody who may not create', async () => {
    api = fakeApi({ creationPermissions: { create: false, statuses: [] } })
    vi.stubGlobal('fetch', api.fetchMock)

    renderApp()
    await signIn()

    await screen.findByRole('link', { name: /dashboard/i })
    expect(screen.queryByRole('link', { name: /new posts/i })).toBeNull()
  })
})

describe('when the API does not answer', () => {
  /*
   * Reported from a real machine: every screen of the admin sat on "Loading…"
   * through reload after reload, with the request to /auth/me shown as pending
   * in the network panel and nothing at all in the API's log — something
   * between the two accepted the connection and never carried it through. A
   * fetch has no deadline of its own, so the query never settled and the
   * interface had nothing to say.
   *
   * The deadline itself is asserted in lib/api.test.ts, where a timeout can be
   * measured in milliseconds instead of the fifteen seconds this screen waits.
   * What is asserted here is the other half: that "nothing answered" reaches
   * the screen as an address that did not answer, and not as "something went
   * wrong" — which is advice to look at the wrong thing.
   */
  it('names the address instead of loading forever', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    renderApp()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(API_URL)
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
  })

  it('offers to try again, and does', async () => {
    const failing = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    vi.stubGlobal('fetch', failing)

    renderApp()
    await screen.findByRole('alert')
    const attempts = failing.mock.calls.length

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))

    await waitFor(() => {
      expect(failing.mock.calls.length).toBeGreaterThan(attempts)
    })
  })
})

describe('what the sign-in screen says went wrong', () => {
  /**
   * Signs in against a transport that answers the login request however a test
   * needs, leaving the session check to the fake.
   */
  async function attemptSignIn(answer: () => Promise<Response>) {
    api = fakeApi()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
        String(input).includes('/auth/login') ? answer() : api.fetchMock(input, init),
      ),
    )

    renderApp()
    await userEvent.type(await findInput(/email/i), 'someone@presslabz.test')
    await userEvent.type(getInput(/password/i, 'input[type="password"]'), 'passphrase')
    await userEvent.click(screen.getByRole('button', { name: /sign in/i }))

    return screen.findByRole('alert')
  }

  it('says the credentials were wrong only when they were', async () => {
    const alert = await attemptSignIn(async () =>
      Response.json({ error: 'invalid_credentials' }, { status: 401 }),
    )

    expect(alert.textContent).toMatch(/do not match/i)
  })

  /*
   * The one that sent people in circles: an unreachable API was reported as
   * "that email and password do not match" — an accusation about the person,
   * for a fault that was never theirs, and one they could only answer by
   * retyping a password that was already right.
   */
  it('does not blame the credentials when nothing answered', async () => {
    const alert = await attemptSignIn(async () => {
      throw new TypeError('Failed to fetch')
    })

    expect(alert.textContent).toMatch(/did not answer/i)
    expect(alert.textContent).not.toMatch(/do not match/i)
  })

  /*
   * A 200 that is not a session. The password may well have been right, so
   * "those do not match" would be an accusation about the person for a fault
   * that is between two builds — and the half-payload behind it must not reach
   * the shell either.
   */
  it('does not blame the credentials for an answer it cannot read', async () => {
    /*
     * This one provokes the malformed-response diagnostic on purpose, so the
     * console is spied for exactly this test — and asserted, not silenced.
     * The finally puts the real console back even when an assertion throws.
     */
    const diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})

    try {
      const alert = await attemptSignIn(async () =>
        Response.json({ user: { id: 'u1', role: 'administrator' } }, { status: 200 }),
      )

      expect(alert.textContent).toMatch(/does not understand/i)
      expect(alert.textContent).not.toMatch(/do not match/i)
      // Still on the sign-in screen rather than in a shell built from a
      // fragment.
      expect(screen.queryByRole('navigation')).toBeNull()

      // One diagnostic, about the sign-in route, carrying a validation error
      // — and nothing else wrote to the console.
      expect(diagnostics).toHaveBeenCalledTimes(1)
      const [message, error] = diagnostics.mock.calls[0] ?? []
      expect(message).toBe('Malformed response from /auth/login')
      expect(error).toHaveProperty('issues')
    } finally {
      diagnostics.mockRestore()
    }
  })

  it('says so when the attempt was rate limited', async () => {
    const alert = await attemptSignIn(async () =>
      Response.json({ error: 'too_many_requests' }, { status: 429 }),
    )

    expect(alert.textContent).toMatch(/too many attempts/i)
  })

  it('says the server broke when the server broke', async () => {
    const alert = await attemptSignIn(async () =>
      Response.json({ error: 'internal' }, { status: 500 }),
    )

    expect(alert.textContent).toMatch(/nothing you did/i)
  })
})

describe('preferences that outlive the tab', () => {
  /*
   * The language used to live in React state alone: every load started from
   * `navigator.languages`, and the choice arrived a moment later with the
   * session — a visible flip on every reload, and nothing at all for somebody
   * who is not signed in.
   */
  it('remembers the language it was told, without being signed in', async () => {
    api = fakeApi()
    vi.stubGlobal('fetch', api.fetchMock)
    renderApp()

    await findInput(/email/i)
    await userEvent.selectOptions(getInput(/language/i, 'select'), 'fr')

    expect(document.cookie).toContain('presslabz-locale=fr')
    expect(document.documentElement.lang).toBe('fr')
  })

  it('starts in the language the cookie names', async () => {
    document.cookie = 'presslabz-locale=fr; Path=/'
    api = fakeApi()
    vi.stubGlobal('fetch', api.fetchMock)

    renderApp()

    expect(await screen.findByText(/composer, traduire/i)).toBeDefined()
  })

  /*
   * The fault this closes: a cookie value is a string anybody on the host can
   * write, decodeURIComponent throws on a malformed escape, and this is read
   * inside a state initialiser. The pre-paint script has its own try/catch, so
   * the page was drawn and then React died on top of it — a blank screen with
   * an explanation in the console.
   */
  it('renders with a cookie nothing can decode, and repairs it', async () => {
    document.cookie = 'presslabz-theme=%E0%A4%A; Path=/'
    document.cookie = 'presslabz-locale=%E0%A4%A; Path=/'
    api = fakeApi()
    vi.stubGlobal('fetch', api.fetchMock)

    renderApp()

    expect(await findInput(/email/i)).toBeDefined()
    // Repaired rather than left to fail on every load from now on.
    await waitFor(() => expect(document.cookie).toContain('presslabz-theme=system'))
  })

  /**
   * What the server holds wins, because it followed the person from another
   * machine — and it has to arrive through the same door a local choice uses.
   * The theme used to come through a door of its own that touched the document
   * and neither the state nor the cookie: the page went dark while the control
   * still read "System", and the next load undid it.
   */
  it('takes the stored preferences, and keeps the control agreeing with them', async () => {
    api = fakeApi()
    api.state.themePreference = 'dark'
    api.state.locale = 'fr'
    vi.stubGlobal('fetch', api.fetchMock)

    renderApp()
    await signIn()

    await waitFor(() => {
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    })
    expect(document.cookie).toContain('presslabz-theme=dark')
    expect(screen.getByRole('button', { name: /sombre/i }).getAttribute('aria-pressed')).toBe(
      'true',
    )
  })
})

/*
 * A 200 whose body is not a session.
 *
 * The reported case is an API a version ahead of the interface, but anything
 * on that address answering 200 lands here — a proxy's own page, another
 * service, a build mid-deploy. Until the session call was parsed, the fields
 * went straight into React and failed several components later as "undefined
 * is not an object", about a component that was never at fault.
 *
 * The person is not signed out. Their session may be perfectly valid; what is
 * broken is the protocol between the two builds, and dropping their cookie
 * over it would lose their work and tell them the wrong thing.
 */
describe('a session response this build cannot read', () => {
  /*
   * Every test here provokes the malformed-response diagnostic on purpose,
   * and `apiFetch` writes it to console.error in development — which a test
   * run is. Captured for exactly this describe, and asserted rather than
   * silenced: each test states how many diagnostics it expects and about
   * which route, so an unexpected line fails a count instead of scrolling
   * past as noise. `mockRestore` in the describe's own afterEach puts the
   * real console back even when an assertion throws; every other suite keeps
   * an unspied console, so a new, undeclared console.error stays visible.
   */
  let diagnostics: MockInstance<typeof console.error>

  beforeEach(() => {
    diagnostics = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    diagnostics.mockRestore()
  })

  /** The captured diagnostics: so many, about this route, each a validation error. */
  function expectDiagnostics(count: number, route = '/auth/me') {
    expect(diagnostics).toHaveBeenCalledTimes(count)
    for (const [message, error] of diagnostics.mock.calls) {
      expect(message).toBe(`Malformed response from ${route}`)
      // A Zod validation error carries its findings in `issues`; asserting on
      // the shape keeps this file from importing zod for one line.
      expect(error).toHaveProperty('issues')
    }
  }

  /** The API renamed a field. Everything else about the answer is right. */
  const renamedField = {
    id: 'u1',
    email: 'someone@presslabz.test',
    display_name: 'Someone',
    role: 'administrator',
    locale: 'en',
    themePreference: 'system',
    capabilities: [],
  }

  /*
   * Signed in as far as the server is concerned — the cookie is valid and the
   * route answers 200. That is the case being described: the session is fine
   * and the body is not.
   */
  function withSession(session: unknown) {
    api = fakeApi({ session })
    api.state.signedIn = true
    vi.stubGlobal('fetch', api.fetchMock)
  }

  it('says the answer was not understood, not that something went wrong', async () => {
    withSession(renamedField)
    renderApp()

    /*
     * This is the assertion that would have failed before: the root screen
     * knew "nothing answered" and said "Something went wrong" for every other
     * case, including this one — the one case that names what to do about it.
     */
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/does not understand/i)
    expect(alert.textContent).not.toMatch(/something went wrong/i)
    expectDiagnostics(1)
  })

  it('does not send the person back to the sign-in form', async () => {
    withSession(renamedField)
    renderApp()

    await screen.findByRole('alert')
    expect(screen.queryByLabelText(/password/i)).toBeNull()
    expect(screen.queryByRole('navigation')).toBeNull()
    expectDiagnostics(1)
  })

  it('offers a way back rather than a dead screen', async () => {
    withSession(renamedField)
    renderApp()

    await screen.findByRole('alert')
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
    expectDiagnostics(1)
  })

  it('lets a retry succeed once the API answers properly', async () => {
    withSession(renamedField)
    renderApp()

    await screen.findByRole('alert')

    // The deploy finished: the same address now answers a session.
    api = fakeApi()
    api.state.signedIn = true
    vi.stubGlobal('fetch', api.fetchMock)

    await userEvent.click(screen.getByRole('button', { name: /try again/i }))
    expect(await screen.findByRole('navigation')).toBeDefined()
    // Only the first answer was malformed; the retry that worked adds no line.
    expectDiagnostics(1)
  })

  it('puts nothing from the body into the query cache', async () => {
    withSession(renamedField)
    const { client } = renderApp()

    await screen.findByRole('alert')

    /*
     * Not a partial user, not an empty object, not null — null is what a
     * signed-out visitor is, and writing it here would be the sign-out this
     * case must not perform. The query holds no data at all and carries the
     * error instead.
     */
    expect(client.getQueryData(['session'])).toBeUndefined()
    expect(client.getQueryState(['session'])?.status).toBe('error')
    expectDiagnostics(1)
  })

  it('admits none of the body into the interface', async () => {
    withSession({ ...renamedField, locale: 'de', themePreference: 'neon' })
    renderApp()

    await screen.findByRole('alert')

    /*
     * Half a payload is worse than none: a language nothing is translated into
     * and a theme matching no palette, applied to the document and remembered
     * in a cookie, would outlive the failed request and the tab.
     */
    expect(document.documentElement.getAttribute('lang')).not.toBe('de')
    expect(document.documentElement.getAttribute('data-theme')).not.toBe('neon')
    expect(document.cookie).not.toContain('neon')
    expectDiagnostics(1)
  })

  it('is still an unreadable answer when the whole envelope is wrong', async () => {
    // Not an object with a user at all — a proxy's error page, say.
    withSession(undefined)
    renderApp()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/does not understand/i)
    expectDiagnostics(1)
  })

  /*
   * The one case that keeps its own message: the address is the useful part of
   * it, and no shared table can supply the address.
   */
  it('still names the API address when nothing answers at all', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    )
    renderApp()

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(API_URL)
  })
})
