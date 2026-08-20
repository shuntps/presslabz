import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { API_URL } from './lib/api.ts'
import { fakeApi, findInput, getInput, renderApp, signIn } from './test-utils.tsx'

/*
 * The admin had no behaviour test at all, and the fault that shipped from it
 * was not visible from either end: the API answered correctly and the
 * stylesheet was fine, while the interface kept rendering the signed-in shell
 * against a signed-out cookie. Nothing but rendering it could have said so.
 */

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
