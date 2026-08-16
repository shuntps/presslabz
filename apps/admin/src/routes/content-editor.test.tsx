import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakeApi, getInput, renderApp, signIn } from '../test-utils.tsx'

/*
 * The editor is the most interactive surface in the product and the one place
 * a mistake costs someone their writing, so what it sends is asserted rather
 * than assumed.
 */

let api: ReturnType<typeof fakeApi>

beforeEach(() => {
  window.history.pushState({}, '', '/')
  api = fakeApi()
  vi.stubGlobal('fetch', api.fetchMock)
  // Node's webcrypto is present in jsdom, but block ids must be uuids and a
  // predictable one makes a failure readable.
  let counter = 0
  vi.spyOn(crypto, 'randomUUID').mockImplementation(
    () =>
      `00000000-0000-4000-8000-00000000000${++counter}` as `${string}-${string}-${string}-${string}-${string}`,
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function openNewDocument() {
  renderApp()
  await signIn()
  window.history.pushState({}, '', '/content/post/new')
  // The router listens to history, but nudging it is what makes the test
  // deterministic rather than dependent on when the listener fires.
  window.dispatchEvent(new PopStateEvent('popstate'))
  await screen.findByPlaceholderText(/^title$/i)
}

describe('creating a document', () => {
  it('suggests a slug from the title, diacritics folded', async () => {
    await openNewDocument()

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'Écrire dans une galée')

    await waitFor(() => {
      expect((getInput(/slug/i) as HTMLInputElement).value).toBe('ecrire-dans-une-galee')
    })
  })

  it('stops suggesting once the author has written one', async () => {
    await openNewDocument()

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'First')
    await userEvent.clear(getInput(/slug/i))
    await userEvent.type(getInput(/slug/i), 'chosen-by-hand')
    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' and more')

    expect((getInput(/slug/i) as HTMLInputElement).value).toBe('chosen-by-hand')
  })

  it('sends typed blocks, not a string of markup', async () => {
    await openNewDocument()

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'A document')
    await userEvent.click(screen.getByRole('button', { name: /^paragraph$/i }))
    await userEvent.type(screen.getByPlaceholderText(/^paragraph$/i), 'Some words')
    await userEvent.click(screen.getByRole('button', { name: /^divider$/i }))

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route === 'POST /content/post')).toBe(true)
    })

    const sent = api.requests.find((request) => request.route === 'POST /content/post')
      ?.body as Record<string, unknown>

    expect(sent.title).toBe('A document')
    expect(sent.slug).toBe('a-document')
    expect(sent.status).toBe('draft')
    expect(sent.blocks).toEqual([
      {
        id: '00000000-0000-4000-8000-000000000001',
        type: 'paragraph',
        content: [{ type: 'text', text: 'Some words' }],
      },
      { id: '00000000-0000-4000-8000-000000000002', type: 'divider' },
    ])
  })

  it('does not send a locale it is forbidden to change', async () => {
    // The server refuses the key by name; sending it anyway would turn every
    // save after the first into a 400 the author cannot act on.
    await openNewDocument()

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'A document')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route.startsWith('POST /content/post'))).toBe(
        true,
      )
    })

    const patches = api.requests.filter((request) => request.route.startsWith('PATCH /content/'))
    for (const patch of patches) {
      expect(patch.body).not.toHaveProperty('locale')
    }
  })

  it('asks for a date as soon as a schedule is chosen', async () => {
    // The server refuses a scheduled document with no date, so the field has
    // to appear before the save rather than after the rejection.
    await openNewDocument()

    expect(screen.queryByLabelText(/publish at/i)).toBeNull()
    await userEvent.selectOptions(getInput(/state/i, 'select'), 'scheduled')
    expect(getInput(/publish at/i)).toBeDefined()
  })
})
