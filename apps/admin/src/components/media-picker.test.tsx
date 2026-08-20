import { cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type FakeApiOptions, fakeApi, fakeMedia, renderApp, signIn } from '../test-utils.tsx'

/*
 * Alt text is the one thing about an asset a person edits after upload, and
 * the one the server now gates on who uploaded it. What is asserted here is
 * that the interface draws the server's answer — the field is closed on
 * somebody else's asset — and that the answer is the server's, never worked
 * out from a capability list in the browser.
 */

let api: ReturnType<typeof fakeApi>

/*
 * jsdom has the element but not its modal methods. They are stood up rather
 * than the component being changed: a native <dialog> is what gives the picker
 * focus trapping, Escape and a backdrop for free, and swapping it for a div to
 * suit the test environment would be testing a different component.
 */
const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype)

let opened = 0

beforeEach(() => {
  window.history.pushState({}, '', '/')
  window.dispatchEvent(new PopStateEvent('popstate'))
  opened = 0

  HTMLDialogElement.prototype.showModal = function showModal() {
    opened += 1
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close() {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  Object.defineProperties(HTMLDialogElement.prototype, dialogMethods)
})

async function open(options: FakeApiOptions) {
  api = fakeApi(options)
  vi.stubGlobal('fetch', api.fetchMock)

  renderApp()
  await signIn()
  window.history.pushState({}, '', '/content/post/new')
  window.dispatchEvent(new PopStateEvent('popstate'))
  await screen.findByPlaceholderText(/^title$/i)

  await userEvent.click(screen.getByRole('button', { name: /^image$/i }))
}

async function openPicker(media: ReturnType<typeof fakeMedia>[]) {
  await open({ media })
  return screen.findAllByLabelText(/alt text/i)
}

const mine = fakeMedia({ id: 'm1', permissions: { update: true } })
const theirs = fakeMedia({ id: 'm2', url: 'http://localhost:9000/media/m2.avif' })

describe('describing an asset in the library', () => {
  it('opens the field on an asset this actor may describe', async () => {
    const [own] = await openPicker([mine])
    expect((own as HTMLInputElement).disabled).toBe(false)
  })

  it('closes it on one they may not', async () => {
    // Server-decided: whether media:update:own is enough depends on who
    // uploaded this row, which a capability list alone cannot answer.
    const [locked] = await openPicker([{ ...theirs, permissions: { update: false } }])
    expect((locked as HTMLInputElement).disabled).toBe(true)
  })

  it('says who may, rather than leaving an inert box', async () => {
    const [locked] = await openPicker([{ ...theirs, permissions: { update: false } }])
    expect((locked as HTMLInputElement).placeholder).toMatch(/uploaded this/i)
  })

  it('decides per asset, not once for the library', async () => {
    const fields = await openPicker([mine, { ...theirs, permissions: { update: false } }])

    expect(fields).toHaveLength(2)
    expect((fields[0] as HTMLInputElement).disabled).toBe(false)
    expect((fields[1] as HTMLInputElement).disabled).toBe(true)
  })

  it('writes the description for the language being worked in', async () => {
    const [own] = await openPicker([mine])

    await userEvent.type(own as HTMLInputElement, 'A red bicycle')
    // Written on leaving the field: a request per keystroke would be a
    // request per keystroke.
    await userEvent.tab()

    await waitFor(() => {
      expect(api.requests.some((request) => request.route === 'PATCH /media/m1')).toBe(true)
    })

    const sent = api.requests.find((request) => request.route === 'PATCH /media/m1')?.body
    expect(sent).toEqual({ alt: { en: 'A red bicycle' } })
  })

  it('sends one language, never a snapshot of the whole map', async () => {
    /*
     * Posting `{...everything I last saw, mine}` is how two people describing
     * the same image in two languages delete each other's work. The request
     * names only what changed, and the server merges it against the row it
     * has locked.
     */
    const described = fakeMedia({ id: 'm1', alt: { fr: 'Un vélo rouge' } })
    const [own] = await openPicker([described])

    await userEvent.type(own as HTMLInputElement, 'A red bicycle')
    await userEvent.tab()

    await waitFor(() => {
      expect(api.requests.some((request) => request.route === 'PATCH /media/m1')).toBe(true)
    })

    const sent = api.requests.find((request) => request.route === 'PATCH /media/m1')?.body as {
      alt: Record<string, unknown>
    }
    expect(Object.keys(sent.alt)).toEqual(['en'])
    expect(sent.alt).not.toHaveProperty('fr')
    // And the other language is still there afterwards.
    expect(api.media[0]?.alt).toEqual({ fr: 'Un vélo rouge', en: 'A red bicycle' })
  })

  it('clears a description rather than storing an empty string', async () => {
    const described = fakeMedia({ id: 'm1', alt: { en: 'A red bicycle' } })
    const [own] = await openPicker([described])

    await userEvent.clear(own as HTMLInputElement)
    await userEvent.tab()

    await waitFor(() => {
      expect(api.requests.some((request) => request.route === 'PATCH /media/m1')).toBe(true)
    })

    const sent = api.requests.find((request) => request.route === 'PATCH /media/m1')?.body
    expect(sent).toEqual({ alt: { en: null } })
  })

  it('sends nothing when the description was not touched', async () => {
    const [own] = await openPicker([mine])

    await userEvent.click(own as HTMLInputElement)
    await userEvent.tab()

    expect(api.requests.some((request) => request.route.startsWith('PATCH /media/'))).toBe(false)
  })
})

describe('the description follows the language being worked in', () => {
  /*
   * Two controls in this app are labelled "Language": the admin's own switcher
   * in the header and, on a new document, the language that document will be
   * written in. The switcher is asked for by its place in the shell because
   * the accessible name alone does not distinguish them.
   */
  const switcher = () => document.querySelector('.switcher select') as HTMLSelectElement

  async function switchTo(locale: string) {
    await userEvent.selectOptions(switcher(), locale)
    await waitFor(() => expect(switcher().value).toBe(locale))
  }

  const reopen = async () => {
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }))
    await userEvent.click(screen.getByRole('button', { name: /^image$/i }))
  }

  it('does not show one language’s draft as another’s', async () => {
    /*
     * The defect: one buffer for the field, so text typed in English survived
     * the interface changing language and was displayed as the French
     * description — the wrong text, under the wrong language, with nothing on
     * screen to say so.
     */
    const [own] = await openPicker([fakeMedia({ id: 'm1', alt: {} })])
    await userEvent.type(own as HTMLInputElement, 'A red bicycle')

    await reopen()
    await switchTo('fr')

    const afterSwitch = (await screen.findAllByLabelText(/texte alternatif/i))[0]
    expect((afterSwitch as HTMLInputElement).value).toBe('')
  })

  it('does not save one language’s draft under another', async () => {
    const [own] = await openPicker([fakeMedia({ id: 'm1', alt: {} })])
    await userEvent.type(own as HTMLInputElement, 'A red bicycle')

    await reopen()
    await switchTo('fr')

    const afterSwitch = (
      await screen.findAllByLabelText(/texte alternatif/i)
    )[0] as HTMLInputElement
    await userEvent.click(afterSwitch)
    await userEvent.tab()

    /*
     * Closing the dialogue left the English field, so English was written —
     * that is correct. What must never happen is the same text arriving under
     * `fr`, which is what one shared buffer produced.
     */
    const wrote = api.requests
      .filter((request) => request.route.startsWith('PATCH /media/'))
      .map((request) => (request.body as { alt: Record<string, unknown> }).alt)

    expect(wrote).toEqual([{ en: 'A red bicycle' }])
    expect(wrote.some((alt) => 'fr' in alt)).toBe(false)
  })

  it('keeps each language’s draft, so switching back does not lose the work', async () => {
    const [own] = await openPicker([fakeMedia({ id: 'm1', alt: {} })])
    await userEvent.type(own as HTMLInputElement, 'A red bicycle')

    await reopen()
    await switchTo('fr')
    await switchTo('en')

    const back = (await screen.findAllByLabelText(/alt text/i))[0]
    expect((back as HTMLInputElement).value).toBe('A red bicycle')
  })
})

describe('adding to the library', () => {
  it('offers the upload control to somebody who may upload', async () => {
    await open({ media: [mine], mediaPermissions: { upload: true } })
    expect(await screen.findByLabelText(/^upload$/i)).toBeDefined()
  })

  it('withholds it from somebody who may not', async () => {
    /*
     * Showing it to everyone meant a contributor could choose a file, be
     * answered 403, and read "that file is not an image this installation
     * accepts" — a refusal about them, reported as a fault in what they
     * picked. The server says whether uploading is on offer.
     */
    await open({ media: [mine], mediaPermissions: { upload: false } })

    await screen.findAllByLabelText(/alt text/i)
    expect(screen.queryByLabelText(/^upload$/i)).toBeNull()
    expect(api.requests.some((request) => request.route === 'POST /media')).toBe(false)
  })
})

describe('a library longer than one page', () => {
  /** Five assets, so a page of two is three pages. */
  const five = Array.from({ length: 5 }, (_, index) =>
    fakeMedia({
      id: `m${index + 1}`,
      url: `http://localhost:9000/media/m${index + 1}.avif`,
      alt: { en: `Asset ${index + 1}` },
    }),
  )

  /*
   * The picker asked for the whole library and received whatever the
   * repository's default capped it at — sixty assets, with the sixty-first in
   * the bucket, in the database, and unreachable from the interface that
   * uploaded it.
   */
  it('shows the first page and offers the rest', async () => {
    await open({ media: five, pageSize: 2 })
    await screen.findAllByLabelText(/alt text/i)

    expect(screen.getAllByRole('img')).toHaveLength(2)
    expect(screen.getByRole('button', { name: /load more/i })).toBeDefined()
  })

  it('adds the next page to what is already shown', async () => {
    await open({ media: five, pageSize: 2 })
    await screen.findAllByLabelText(/alt text/i)

    await userEvent.click(screen.getByRole('button', { name: /load more/i }))

    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(4))
  })

  it('stops offering more once the last page is in', async () => {
    await open({ media: five, pageSize: 4 })
    await screen.findAllByLabelText(/alt text/i)

    await userEvent.click(screen.getByRole('button', { name: /load more/i }))
    await waitFor(() => expect(screen.getAllByRole('img')).toHaveLength(5))

    expect(screen.queryByRole('button', { name: /load more/i })).toBeNull()
  })
})

describe('the dialog is opened after the render, not during it', () => {
  /*
   * `showModal()` used to be called from the component body and again from the
   * ref callback — both during render. React may render more than once for a
   * single commit and may throw a render away entirely, so a component that
   * reaches into the DOM while rendering is relying on it doing neither.
   *
   * What that looked like from outside: every re-render of the editor asked
   * the dialog to open again. Counting the calls is how this stays fixed —
   * once the picker is open, typing in it must not reopen it.
   */
  it('opens once, however many times the screen re-renders', async () => {
    const [field] = await openPicker([mine])
    expect(opened).toBe(1)

    await userEvent.type(field as HTMLInputElement, 'A description, typed slowly')

    expect(opened).toBe(1)
  })

  it('does not open a picker nobody asked for', async () => {
    // The editor mounts the picker closed; a render-phase call would open it
    // on the first paint of every document that has an image block.
    await open({ media: [mine] })
    expect(opened).toBeGreaterThan(0)

    await userEvent.click(screen.getByRole('button', { name: /close/i }))
    await waitFor(() => expect(document.querySelector('dialog')?.open).toBe(false))

    await userEvent.type(await screen.findByPlaceholderText(/^title$/i), 'Still closed')
    expect(document.querySelector('dialog')?.open).toBe(false)
  })
})
