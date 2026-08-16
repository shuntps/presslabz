import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeApiOptions, fakeApi, renderApp, signIn } from '../test-utils.tsx'

/*
 * The listing offers one action, and offering it to somebody the server would
 * refuse is offering a form that cannot be saved. Whether to offer it is the
 * server's answer, not a capability list read in the browser.
 */

let api: ReturnType<typeof fakeApi>

beforeEach(() => {
  window.history.pushState({}, '', '/')
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openListing(options: FakeApiOptions = {}) {
  api = fakeApi(options)
  vi.stubGlobal('fetch', api.fetchMock)

  renderApp()
  await signIn()
  window.history.pushState({}, '', '/content/post')
  window.dispatchEvent(new PopStateEvent('popstate'))
  await screen.findByRole('heading', { level: 1 })
}

describe('the listing', () => {
  it('offers a new document to somebody who may create one', async () => {
    await openListing()
    expect(await screen.findByRole('link', { name: /new/i })).toBeDefined()
  })

  it('withholds it from somebody who may not', async () => {
    await openListing({ creationPermissions: { create: false, statuses: [] } })

    // Waited for rather than asserted on the first paint: absent because the
    // answer has not arrived yet is not the same as absent because it said no.
    await waitFor(() =>
      expect(api.requests.some((r) => r.route === 'GET /content-types')).toBe(true),
    )
    expect(screen.queryByRole('link', { name: /new/i })).toBeNull()
  })
})
