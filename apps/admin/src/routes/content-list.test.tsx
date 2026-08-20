import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeApiOptions, fakeApi, fakeDocument, renderApp, signIn } from '../test-utils.tsx'

/*
 * The listing offers one action, and offering it to somebody the server would
 * refuse is offering a form that cannot be saved. Whether to offer it is the
 * server's answer, not a capability list read in the browser.
 */

let api: ReturnType<typeof fakeApi>

beforeEach(() => {
  /*
   * The router is a module singleton, so where the previous test left it is
   * where this one starts. Telling it about the reset — rather than only
   * rewriting the URL — is what makes the navigation below an actual
   * navigation instead of a no-op that renders the last test's screen.
   */
  window.history.pushState({}, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
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

describe('a listing longer than one page', () => {
  /** Six documents, so a page of two is three pages. */
  const six = Array.from({ length: 6 }, (_, index) =>
    fakeDocument({
      id: `doc-${index + 1}`,
      translationGroupId: `group-${index + 1}`,
      slug: `document-${index + 1}`,
      title: `Document ${index + 1}`,
      status: index % 3 === 0 ? 'draft' : 'published',
    }),
  )

  /*
   * The listing asked for everything and got whatever the repository's default
   * capped it at. Nothing said so: the fifty-first document was in the
   * database, absent from the screen, and there was no control anywhere that
   * would have brought it back.
   */
  it('shows the first page and offers the rest', async () => {
    await openListing({ documents: six, pageSize: 2 })

    expect(await screen.findByRole('link', { name: /document 1/i })).toBeDefined()
    expect(screen.queryByRole('link', { name: /document 3/i })).toBeNull()
    expect(screen.getByRole('button', { name: /load more/i })).toBeDefined()
  })

  it('adds the next page to what is already there', async () => {
    await openListing({ documents: six, pageSize: 2 })
    await screen.findByRole('link', { name: /document 1/i })

    await userEvent.click(screen.getByRole('button', { name: /load more/i }))

    expect(await screen.findByRole('link', { name: /document 3/i })).toBeDefined()
    // Added, not replaced: paging that swaps the page is a different design
    // and this one appends.
    expect(screen.getByRole('link', { name: /document 1/i })).toBeDefined()
  })

  it('stops offering more once the last page is in', async () => {
    await openListing({ documents: six, pageSize: 4 })
    await screen.findByRole('link', { name: /document 1/i })

    await userEvent.click(screen.getByRole('button', { name: /load more/i }))
    await screen.findByRole('link', { name: /document 6/i })

    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
    })
  })

  /*
   * The heading describes the type, not the rows in hand. Counting what has
   * been fetched made it say "so far" — a number that grew every time somebody
   * pressed the button, about a question nobody asked.
   */
  it('counts the whole set, not the page', async () => {
    await openListing({ documents: six, pageSize: 2 })
    await screen.findByRole('link', { name: /document 1/i })

    const heading = await screen.findByText(/6 total/i)
    expect(heading.textContent).toMatch(/2 in draft/i)
  })
})

describe('when the listing cannot be read', () => {
  /**
   * Opens the listing with a transport that answers the listing itself however
   * a test needs, and everything else — sign-in, the type registry — the way
   * the fake does.
   *
   * The route is set before the app mounts rather than navigated to
   * afterwards. The router is a module singleton: a test that renders at "/"
   * and pushes the listing's URL is relying on the previous test having left
   * it somewhere else, which the previous test is under no obligation to do.
   */
  async function openBrokenListing(answer: () => Promise<Response>) {
    api = fakeApi()
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) =>
        String(input).includes('/content/post') ? answer() : api.fetchMock(input, init),
      ),
    )

    window.history.pushState({}, '', '/content/post')
    window.dispatchEvent(new PopStateEvent('popstate'))

    renderApp()
    await signIn()
  }

  /*
   * A 200 is not a promise that the body is the one this build expects. It
   * used to be cast into React state unexamined, and the failure surfaced
   * three components later as "undefined is not an object" — about a thing
   * that was never at fault.
   */
  it('refuses a malformed answer instead of rendering it', async () => {
    await openBrokenListing(async () =>
      Response.json({ contents: [{ id: 'doc-1', title: 'From an older API' }] }),
    )

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/does not understand/i)
    // And the shape it could not read is nowhere on the screen.
    expect(screen.queryByText(/from an older api/i)).toBeNull()
  })

  it('says a refusal is a refusal, not a breakage', async () => {
    await openBrokenListing(async () => Response.json({ error: 'forbidden' }, { status: 403 }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/permission/i)
    // Nothing to retry: the same request would be refused the same way.
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('offers to try again when nothing answered', async () => {
    await openBrokenListing(async () => {
      throw new TypeError('Failed to fetch')
    })

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/did not answer/i)
    expect(screen.getByRole('button', { name: /try again/i })).toBeDefined()
  })
})
