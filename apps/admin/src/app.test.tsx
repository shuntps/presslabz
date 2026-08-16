import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
