import { cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeApiOptions,
  FULL_CREATION_PERMISSIONS,
  fakeApi,
  fakeDocument,
  forgetPreferences,
  getInput,
  renderApp,
  signIn,
  testUser,
} from '../test-utils.tsx'

/*
 * The editor is the most interactive surface in the product and the one place
 * a mistake costs someone their writing, so what it sends is asserted rather
 * than assumed.
 */

let api: ReturnType<typeof fakeApi>

/** jsdom has <dialog> but not its modal methods; the leaving dialog needs them. */
const dialogMethods = Object.getOwnPropertyDescriptors(HTMLDialogElement.prototype)

beforeEach(() => {
  forgetPreferences()
  window.history.pushState({}, '', '/')
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close() {
    this.open = false
    this.dispatchEvent(new Event('close'))
  }
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
  Object.defineProperties(HTMLDialogElement.prototype, dialogMethods)
})

/**
 * The edit that was sent, or a failure that says none was. Reading it as
 * `find(...)?.body` and casting hides the difference between "sent the wrong
 * thing" and "sent nothing at all", which are not the same defect.
 */
function patchRequest() {
  const sent = api.requests.find((request) => request.route.startsWith('PATCH'))
  if (!sent) throw new Error('no PATCH was sent')
  return sent
}

/** Replaces the default fake, for a test that needs the server to say no. */
function serverSays(options: FakeApiOptions) {
  api = fakeApi(options)
  vi.stubGlobal('fetch', api.fetchMock)
}

async function open(path: string) {
  renderApp()
  await signIn()
  window.history.pushState({}, '', path)
  // The router listens to history, but nudging it is what makes the test
  // deterministic rather than dependent on when the listener fires.
  window.dispatchEvent(new PopStateEvent('popstate'))
}

async function openNewDocument() {
  await open('/content/post/new')
  await screen.findByPlaceholderText(/^title$/i)
}

/** A document that is already on the site, as the server would describe it. */
function liveDocument(permissions: {
  update: boolean
  delete: boolean
  statuses: readonly string[]
}) {
  return {
    id: 'doc-1',
    type: 'post',
    locale: 'en',
    translationGroupId: 'group-1',
    slug: 'a-live-document',
    status: 'published',
    title: 'A live document',
    excerpt: null,
    blocks: [],
    meta: {},
    authorId: testUser.id,
    parentId: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissions,
  }
}

/** The same document, carrying the marks an import would have brought. */
function importedDocument(blocks: unknown[]) {
  return {
    ...liveDocument({ update: true, delete: true, statuses: ['draft', 'published'] }),
    blocks,
  }
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

  /*
   * This test used to open a *new* document, save it — which sends a POST —
   * and then loop over the PATCH requests, of which there were none. The loop
   * body never ran and the test passed without touching the behaviour it
   * names. It edits an existing document now, and asserts a patch was sent
   * before asserting anything about its contents, so it can never go hollow
   * again the way it did.
   */
  it('does not send a locale it is forbidden to change', async () => {
    // The server refuses the key by name; sending it anyway would turn every
    // save after the first into a 400 the author cannot act on.
    serverSays({ documents: [fakeDocument({ id: 'doc-1', title: 'An existing document' })] })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('An existing document')

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ', edited')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route.startsWith('PATCH /content/'))).toBe(true)
    })

    const patches = api.requests.filter((request) => request.route.startsWith('PATCH /content/'))
    expect(patches).toHaveLength(1)
    expect(patches[0]?.body).not.toHaveProperty('locale')
    // And it did send the edit, so "no locale" is a statement about a real
    // request rather than about an empty one.
    expect(patches[0]?.body).toMatchObject({ title: 'An existing document, edited' })
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

describe('controls the actor may not use', () => {
  const options = (select: HTMLSelectElement) =>
    Object.fromEntries(
      within(select)
        .getAllByRole('option')
        .map((option) => [
          (option as HTMLOptionElement).value,
          (option as HTMLOptionElement).disabled,
        ]),
    )

  it('offers no publishable status to someone who may not publish', async () => {
    /*
     * The statuses come from the server, which decided them with the same
     * function the route enforces. The interface disables rather than removes:
     * a list that silently drops "Published" reads as a product without
     * publishing, a greyed entry reads as a permission they do not have.
     */
    serverSays({
      creationPermissions: { create: true, statuses: ['draft', 'archived', 'trash'] },
    })
    await openNewDocument()

    expect(options(getInput(/state/i, 'select') as HTMLSelectElement)).toEqual({
      draft: false,
      scheduled: true,
      published: true,
      archived: false,
      trash: false,
    })
  })

  it('lets someone who may publish choose it', async () => {
    await openNewDocument()

    const select = getInput(/state/i, 'select') as HTMLSelectElement
    expect(options(select).published).toBe(false)
    await userEvent.selectOptions(select, 'published')
    expect(select.value).toBe('published')
  })

  it('closes the whole editor on a document the actor may not write', async () => {
    // A contributor whose draft an editor published: they still hold
    // content:update:own over the row, and the server now refuses anyway.
    serverSays({
      documents: [liveDocument({ update: false, delete: false, statuses: [] })],
    })
    await open('/content/post/doc-1')

    await screen.findByPlaceholderText(/^title$/i)

    /*
     * The enclosing fieldset is asserted rather than each control: that is the
     * mechanism, and it is the reason a control added to this screen tomorrow
     * is closed without anybody remembering to close it. jsdom does not report
     * the inherited state on the descendants themselves, so asking them would
     * be asking the wrong element.
     *
     * Re-queried inside waitFor because the router settles its transition
     * after the first paint: a node captured before that is a node the editor
     * has already replaced.
     */
    await waitFor(() => {
      const controls = [
        screen.getByPlaceholderText(/^title$/i),
        getInput(/slug/i),
        getInput(/state/i, 'select'),
        screen.getByRole('button', { name: /^save$/i }),
      ]
      for (const control of controls) expect(control.closest('fieldset')?.disabled).toBe(true)
    })
  })

  it('says why, rather than leaving a row of grey controls to explain itself', async () => {
    serverSays({
      documents: [liveDocument({ update: false, delete: false, statuses: [] })],
    })
    await open('/content/post/doc-1')

    await screen.findByPlaceholderText(/^title$/i)
    expect(screen.getByRole('status').textContent).toMatch(/permission to publish/i)
  })

  it('sends nothing when a refused editor is driven anyway', async () => {
    // The property that matters is not the grey: it is that nothing leaves.
    serverSays({
      documents: [liveDocument({ update: false, delete: false, statuses: [] })],
    })
    await open('/content/post/doc-1')

    const title = await screen.findByPlaceholderText(/^title$/i)
    await userEvent.type(title, 'Rewritten')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect((title as HTMLTextAreaElement).value).toBe('A live document')
    expect(api.requests.some((request) => request.route.startsWith('PATCH /content/'))).toBe(false)
  })

  it('withholds the missing-translation links when the group refuses them', async () => {
    /*
     * The case this closes: a contributor whose draft an editor published may
     * no longer write that document, and joining its group means being able to
     * write one of its members. So the type-level "may create a post" is the
     * wrong question — the editor asked it and offered the link anyway, and
     * the author found out on save.
     *
     * The type still says yes here; only the group says no. A link is not a
     * form control, so the fieldset does not close it — it is withheld.
     */
    serverSays({
      documents: [liveDocument({ update: false, delete: false, statuses: [] })],
      creationPermissions: { create: true, statuses: ['draft', 'archived', 'trash'] },
      translationPermissions: { create: false },
    })
    await open('/content/post/doc-1')

    await screen.findByPlaceholderText(/^title$/i)
    await waitFor(() => expect(screen.getByText(/translations/i)).toBeDefined())
    expect(screen.queryByRole('link', { name: /write it in/i })).toBeNull()
  })

  it('offers them when the group allows them', async () => {
    serverSays({
      documents: [liveDocument({ update: true, delete: true, statuses: ['draft', 'published'] })],
      translationPermissions: { create: true },
    })
    await open('/content/post/doc-1')

    await screen.findByPlaceholderText(/^title$/i)
    await waitFor(() => {
      expect(screen.getByRole('link', { name: /write it in/i })).toBeDefined()
    })
  })

  it('does not offer them merely because the type may be created', async () => {
    // The exact mismatch: create permission held, group permission refused.
    serverSays({
      documents: [liveDocument({ update: false, delete: false, statuses: [] })],
      creationPermissions: FULL_CREATION_PERMISSIONS,
      translationPermissions: { create: false },
    })
    await open('/content/post/doc-1')

    await screen.findByPlaceholderText(/^title$/i)
    await waitFor(() => expect(screen.getByText(/translations/i)).toBeDefined())
    expect(screen.queryByRole('link', { name: /write it in/i })).toBeNull()
  })

  it('opens the same document for someone who may write it', async () => {
    // The negative tests above are only worth anything if the positive one
    // fails when the editor is closed for everybody.
    serverSays({
      documents: [liveDocument({ update: true, delete: true, statuses: ['draft', 'published'] })],
    })
    await open('/content/post/doc-1')

    await screen.findByPlaceholderText(/^title$/i)

    await waitFor(() => {
      const title = screen.getByPlaceholderText(/^title$/i)
      expect(title.closest('fieldset')?.disabled).toBe(false)
    })

    expect(screen.queryByRole('status')).toBeNull()
    const select = getInput(/state/i, 'select') as HTMLSelectElement
    expect(options(select)).toMatchObject({ draft: false, published: false, archived: true })
  })
})

describe('editing content that came from somewhere else', () => {
  const linked = {
    id: '11111111-1111-4111-8111-111111111111',
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Read ' },
      { type: 'text', text: 'the guide', marks: [{ type: 'link', href: 'https://example.com' }] },
      { type: 'text', text: ' today.' },
    ],
  }

  /*
   * The failure this closes: the editor rebuilt the run as one unmarked node
   * on every keystroke, so a document imported with links lost them the first
   * time somebody fixed a typo — and the save that followed made it permanent.
   */
  it('keeps a link the author never touched', async () => {
    serverSays({ documents: [importedDocument([linked])] })
    await open('/content/post/doc-1')

    /*
     * Typed at the end, which is an edit. Clearing the field first would be
     * the author deleting the paragraph and writing another one — the marks
     * are supposed to go in that case, and asserting they survive it would be
     * asserting the wrong thing.
     */
    const field = await screen.findByPlaceholderText(/^paragraph$/i)
    await userEvent.type(field, ' Tomorrow too.')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route.startsWith('PATCH'))).toBe(true)
    })

    const sent = api.requests.find((request) => request.route.startsWith('PATCH'))?.body as {
      blocks: { content: { text: string; marks?: unknown[] }[] }[]
    }

    const marked = sent.blocks[0]?.content.find((node) => node.marks !== undefined)
    expect(marked?.text).toBe('the guide')
    expect(marked?.marks).toEqual([{ type: 'link', href: 'https://example.com' }])
  })

  /*
   * The editor addresses blocks by id, so two blocks sharing one would be
   * edited and deleted together — and the schema refuses to store the
   * document, which would leave it unsavable forever.
   */
  it('repairs a document that arrives with duplicate block ids', async () => {
    const duplicate = { ...linked, content: [{ type: 'text', text: 'Twice' }] }
    serverSays({ documents: [importedDocument([duplicate, { ...duplicate }])] })
    await open('/content/post/doc-1')

    await screen.findAllByPlaceholderText(/^paragraph$/i)
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route.startsWith('PATCH'))).toBe(true)
    })

    const sent = api.requests.find((request) => request.route.startsWith('PATCH'))?.body as {
      blocks: { id: string }[]
    }

    expect(sent.blocks).toHaveLength(2)
    expect(sent.blocks[0]?.id).toBe(duplicate.id)
    expect(sent.blocks[1]?.id).not.toBe(duplicate.id)
  })
})

describe('moving from one document to another', () => {
  /** A pair: the same work in two languages, as the panel offers them. */
  const english = fakeDocument({
    id: 'doc-en',
    locale: 'en',
    slug: 'the-english-one',
    title: 'The English one',
    translationGroupId: 'group-1',
  })

  const french = fakeDocument({
    id: 'doc-fr',
    locale: 'fr',
    slug: 'la-version-francaise',
    title: 'La version française',
    translationGroupId: 'group-1',
  })

  async function openThenFollowTheTranslation() {
    serverSays({ documents: [english, french] })
    await open('/content/post/doc-en')
    await screen.findByDisplayValue('The English one')

    await userEvent.click(screen.getByRole('link', { name: /la version française/i }))
    await screen.findByDisplayValue('La version française')
  }

  /*
   * The fault this closes, and the reason it was invisible: the router keeps
   * the component mounted when only `$id` changes, so the draft stayed the one
   * seeded from the English document while the save mutation had already moved
   * to the French id. Pressing save wrote the English document over the French
   * one, under a title bar that read "La version française" the whole time.
   */
  it('never saves the document it came from onto the one it arrived at', async () => {
    await openThenFollowTheTranslation()

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route.startsWith('PATCH'))).toBe(true)
    })

    const sent = patchRequest()
    expect(sent.route).toBe('PATCH /content/post/doc-fr')
    expect((sent.body as { title: string; slug: string }).title).toBe('La version française')
    expect((sent.body as { slug: string }).slug).toBe('la-version-francaise')
  })

  it('shows the document it arrived at, down to the fields nobody looks at', async () => {
    await openThenFollowTheTranslation()

    expect((getInput(/slug/i) as HTMLInputElement).value).toBe('la-version-francaise')
  })

  /*
   * The version travels with the document. Sending the one from the previous
   * screen is how an edit gets refused as stale — or worse, accepted, because
   * the number happened to match.
   */
  it('states the version of the document it is actually editing', async () => {
    serverSays({
      documents: [english, { ...french, version: 7 }],
    })
    await open('/content/post/doc-en')
    await screen.findByDisplayValue('The English one')

    await userEvent.click(screen.getByRole('link', { name: /la version française/i }))
    await screen.findByDisplayValue('La version française')

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route.startsWith('PATCH'))).toBe(true)
    })

    expect((patchRequest().body as { expectedVersion: number }).expectedVersion).toBe(7)
  })
})

describe('work that has not been saved', () => {
  const document_ = fakeDocument({ id: 'doc-1', title: 'A live document', version: 3 })

  async function openAndType(text = ' and then some') {
    serverSays({ documents: [document_] })
    await open('/content/post/doc-1')
    const title = await screen.findByDisplayValue('A live document')

    await userEvent.type(title, text)
    return title
  }

  it('says so, beside the button that would fix it', async () => {
    await openAndType()
    expect(screen.getByText(/not saved yet/i)).toBeDefined()
  })

  /*
   * "Saved" is a statement about what the server holds. Read straight off the
   * mutation, it stayed on screen through a paragraph of new writing and said
   * the opposite of the truth.
   */
  it('stops calling itself saved the moment somebody types', async () => {
    await openAndType()

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/^saved$/i)).toBeDefined()

    await userEvent.type(screen.getByDisplayValue(/a live document/i), '!')

    await waitFor(() => expect(screen.queryByText(/^saved$/i)).toBeNull())
    expect(screen.getByText(/not saved yet/i)).toBeDefined()
  })

  it('lets somebody leave a document they have not touched', async () => {
    serverSays({ documents: [document_] })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')

    await userEvent.click(screen.getByRole('link', { name: /dashboard/i }))

    await screen.findByRole('heading', { name: /dashboard/i })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  describe('and somebody tries to leave', () => {
    async function leave() {
      await openAndType()
      await userEvent.click(screen.getByRole('link', { name: /dashboard/i }))
      return screen.findByRole('dialog')
    }

    it('asks, rather than letting the writing go', async () => {
      const dialog = await leave()

      expect(dialog.textContent).toMatch(/have not saved/i)
      // Still here: the navigation is held, not finished.
      expect(screen.getByDisplayValue(/a live document/i)).toBeDefined()
    })

    it('stays when asked to stay', async () => {
      await leave()

      await userEvent.click(screen.getByRole('button', { name: /stay here/i }))

      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(screen.getByDisplayValue(/a live document and then some/i)).toBeDefined()
      expect(api.requests.some((request) => request.route.startsWith('PATCH'))).toBe(false)
    })

    it('leaves, and sends nothing, when the writing is abandoned on purpose', async () => {
      await leave()

      await userEvent.click(screen.getByRole('button', { name: /leave without saving/i }))

      await screen.findByRole('heading', { name: /dashboard/i })
      expect(api.requests.some((request) => request.route.startsWith('PATCH'))).toBe(false)
    })

    /*
     * The answer people actually want, and the reason this is a dialog of our
     * own rather than the browser's two-button one: leaving is deferred until
     * the save has landed, so the request is not made from a screen that is
     * being torn down.
     */
    it('saves first, then leaves, when asked for both', async () => {
      await leave()

      await userEvent.click(screen.getByRole('button', { name: /save, then leave/i }))

      await screen.findByRole('heading', { name: /dashboard/i })

      const sent = patchRequest()
      expect(sent.route).toBe('PATCH /content/post/doc-1')
      expect((sent.body as { title: string }).title).toBe('A live document and then some')
    })
  })
})

describe('the languages this installation writes in', () => {
  /*
   * The admin used to offer every language PressLabz has a catalogue for,
   * which is a fact about the software rather than about the site. An
   * installation configured for English alone still invited somebody to start
   * a French translation, and the API accepted it — content the public site
   * has no route for and does not announce.
   */
  /**
   * The document's language, not the interface's. Both are labelled
   * "Language" and they answer different questions — one is what this site
   * publishes in, the other is what PressLabz is being read in — so the query
   * is scoped to the editor rather than made ambiguous.
   */
  function documentLanguages(): string[] {
    const editor = document.querySelector('fieldset.editor') as HTMLElement
    const select = within(editor).getByLabelText(/language/i, { selector: 'select' })
    return [...(select as HTMLSelectElement).options].map((option) => option.value)
  }

  it('offers the configured languages when starting a document', async () => {
    serverSays({ locales: ['en'] })
    await openNewDocument()

    await waitFor(() => expect(documentLanguages()).toEqual(['en']))
  })

  it('offers all of them when the installation serves both', async () => {
    serverSays({ locales: ['en', 'fr'] })
    await openNewDocument()

    await waitFor(() => expect(documentLanguages()).toEqual(['en', 'fr']))
  })

  it('does not offer to translate into a language the site does not serve', async () => {
    serverSays({
      locales: ['en'],
      documents: [fakeDocument({ id: 'doc-1', locale: 'en', title: 'Only in English' })],
    })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('Only in English')

    await waitFor(() => {
      expect(screen.getByText(/translations/i)).toBeDefined()
    })
    expect(screen.queryByRole('link', { name: /français/i })).toBeNull()
  })
})

describe('a document that did not exist a moment ago', () => {
  /*
   * The editor's own navigation, blocked by its own guard. `shouldBlockFn` is
   * called at the moment a navigation starts, and React state is not updated
   * by then — so clearing "unsaved" and navigating in the same tick, which is
   * exactly what a successful save does, left the guard reading the old value.
   * The save landed, the screen stayed on /content/post/new, and pressing save
   * again answered 409 about a slug the author had just used.
   *
   * The move to the new document's address is asserted in the browser suite,
   * where a router's own interception is observable; jsdom renders from the
   * router's internal location and never shows the difference. What this
   * asserts is the state the guard reads: after a save that landed, there is
   * nothing left to warn about.
   */
  it('has nothing left unsaved once the server has it', async () => {
    await openNewDocument()

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'Brand new')
    expect(screen.getByText(/not saved yet/i)).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() => {
      expect(api.requests.some((request) => request.route === 'POST /content/post')).toBe(true)
    })
    await waitFor(() => {
      expect(screen.queryByText(/not saved yet/i)).toBeNull()
    })
    // And nothing is asking whether to leave: the work is on the server.
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})
