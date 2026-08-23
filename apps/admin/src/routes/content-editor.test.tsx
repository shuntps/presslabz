import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  type FakeApiOptions,
  FULL_CREATION_PERMISSIONS,
  fakeApi,
  fakeDocument,
  fakeRevision,
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

describe('revision history', () => {
  const EVERY_STATUS = ['draft', 'scheduled', 'published', 'archived', 'trash'] as const

  const permitted = (statuses: readonly string[] = EVERY_STATUS) => ({
    update: true,
    delete: true,
    statuses,
  })

  const PARAGRAPH_ID = '00000000-0000-4000-8000-0000000000c1'
  const IMAGE_BLOCK_ID = '00000000-0000-4000-8000-0000000000c2'
  const MEDIA_ID = '00000000-0000-4000-8000-0000000000c9'

  const oldParagraph = {
    id: PARAGRAPH_ID,
    type: 'paragraph',
    content: [{ type: 'text', text: 'The old paragraph' }],
  }
  const oldImage = {
    id: IMAGE_BLOCK_ID,
    type: 'image',
    mediaId: MEDIA_ID,
    caption: [{ type: 'text', text: 'A caption from back then' }],
  }

  async function openDocument(options: FakeApiOptions = {}) {
    serverSays({ documents: [liveDocument(permitted())], ...options })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
  }

  async function openHistory() {
    await userEvent.click(await screen.findByRole('button', { name: /^history$/i }))
    return screen.findByRole('dialog')
  }

  const jsonResponse = (body: unknown, status: number) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    })

  /** Overrides chosen routes; everything else still reaches the fake API. */
  function routesAnswering(
    match: (method: string, path: string) => Response | Promise<Response> | null,
  ) {
    const inner = api.fetchMock
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        const overridden = match(init.method ?? 'GET', url.pathname)
        return overridden ? Promise.resolve(overridden) : inner(input, init)
      }),
    )
  }

  it('withholds the control when the server says the document is not editable', async () => {
    serverSays({ documents: [liveDocument({ update: false, delete: false, statuses: [] })] })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')

    expect(screen.queryByRole('button', { name: /^history$/i })).toBeNull()
  })

  it('lists versions with honest archived-at labels, newest first', async () => {
    await openDocument({
      revisions: [
        fakeRevision({
          id: 'rev-2',
          version: 2,
          title: 'Second wording',
          archivedAt: '2026-02-02T00:00:00.000Z',
        }),
        fakeRevision({ id: 'rev-1', version: 1, title: 'First wording' }),
      ],
    })
    const dialog = await openHistory()

    const entries = await within(dialog).findAllByRole('listitem')
    expect(entries).toHaveLength(2)
    expect(entries[0]?.textContent).toMatch(/second wording/i)
    expect(entries[0]?.textContent).toMatch(/version 2 — archived/i)
    expect(entries[1]?.textContent).toMatch(/version 1/i)
    // Labels talk about the archiving instant, never about writing.
    expect(dialog.textContent).not.toMatch(/written/i)
  })

  it('says a new document has no history yet', async () => {
    await openDocument({ revisions: [] })
    const dialog = await openHistory()

    expect(await within(dialog).findByText(/no earlier versions yet/i)).toBeDefined()
  })

  it('reports a list that failed to load, and retries on request', async () => {
    await openDocument({ revisions: [fakeRevision()] })
    let failures = 0
    routesAnswering((method, path) => {
      if (method === 'GET' && path.endsWith('/revisions') && failures === 0) {
        failures += 1
        return jsonResponse({ error: 'server_error' }, 500)
      }
      return null
    })
    const dialog = await openHistory()

    expect(await within(dialog).findByRole('alert')).toBeDefined()
    await userEvent.click(within(dialog).getByRole('button', { name: /try again/i }))

    expect(await within(dialog).findAllByRole('listitem')).toHaveLength(1)
  })

  it('inspects a revision as static reading matter, not as form controls', async () => {
    await openDocument({
      revisions: [fakeRevision({ id: 'rev-1', version: 1, blocks: [oldParagraph, oldImage] })],
    })
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    const paragraph = await within(dialog).findByText('The old paragraph')
    expect(paragraph.tagName).toBe('P')
    // The image is a reference and a caption; there is no alt to show and no
    // media request to make — a neutral placeholder stands in.
    expect(within(dialog).getByRole('img', { name: /^image$/i })).toBeDefined()
    expect(within(dialog).getByText('A caption from back then')).toBeDefined()
    expect(dialog.querySelector('.history-content textarea, .history-content input')).toBeNull()
  })

  it('shows an incompatible revision as its summary, restore withheld', async () => {
    const incompatible = fakeRevision({ compatible: false, id: 'rev-old', version: 1 })
    delete (incompatible as Record<string, unknown>).blocks
    delete (incompatible as Record<string, unknown>).meta
    delete (incompatible as Record<string, unknown>).parentId

    await openDocument({ revisions: [incompatible] })
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    expect(await within(dialog).findByText(/predates the current content rules/i)).toBeDefined()
    expect(within(dialog).queryByRole('button', { name: /^restore$/i })).toBeNull()
  })

  it('withholds restore when the served statuses exclude the revision, and says why', async () => {
    serverSays({
      documents: [liveDocument(permitted(['draft', 'archived', 'trash']))],
      revisions: [fakeRevision({ id: 'rev-1', version: 1, status: 'published' })],
    })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    expect(await within(dialog).findByText(/needs a permission/i)).toBeDefined()
    expect(within(dialog).queryByRole('button', { name: /^restore$/i })).toBeNull()
  })

  it('restores after an explicit confirmation, re-seeds the draft, and stays undoable', async () => {
    serverSays({
      documents: [liveDocument(permitted())],
      revisions: [
        fakeRevision({
          id: 'rev-1',
          version: 1,
          title: 'The first wording',
          slug: 'first-slug',
          status: 'draft',
          blocks: [oldParagraph],
        }),
      ],
    })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))

    // The confirmation names what will be replaced, and the safe answer holds
    // the keyboard.
    expect(await within(dialog).findByText(/restore version 1\?/i)).toBeDefined()
    const cancel = within(dialog).getByRole('button', { name: /keep the current state/i })
    expect(document.activeElement).toBe(cancel)

    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    await within(dialog).findByText(/version 1 restored/i)
    const restore = api.requests.find((request) => request.route.endsWith('/restore'))
    expect(restore?.body).toEqual({ expectedVersion: 1 })

    // The open draft took the restored state without a reload, and it is
    // saved state: nothing warns about unsaved work.
    expect(await screen.findByDisplayValue('The first wording')).toBeDefined()
    expect(screen.queryByText(/not saved yet/i)).toBeNull()

    // The history now starts with the state the restore superseded — which is
    // what keeps the restore itself undoable.
    const entries = await within(dialog).findAllByRole('listitem')
    expect(entries[0]?.textContent).toMatch(/a live document/i)

    // And the version chain continues: the next save is composed against the
    // version the restore produced.
    await userEvent.click(within(dialog).getByRole('button', { name: /^close$/i }))
    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' again')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => {
      expect(patchRequest().body).toMatchObject({ expectedVersion: 2 })
    })
  })

  it('warns before discarding unsaved changes', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' touched')
    await screen.findByText(/not saved yet/i)

    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))

    expect(await within(dialog).findByText(/unsaved changes/i)).toBeDefined()
  })

  it('shows a stale restore with the reload affordance', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse({ error: 'conflict', reason: 'stale-version' }, 409)
        : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toMatch(/somebody else saved this document/i)
    expect(within(dialog).getByRole('button', { name: /reload/i })).toBeDefined()
  })

  it('treats a vanished revision as a stale history and refetches the list', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse({ error: 'not_found', reason: 'revision-not-found' }, 404)
        : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    const listedBefore = api.requests.filter((request) =>
      request.route.endsWith('GET /content/post/doc-1/revisions'),
    ).length
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    expect(await within(dialog).findByText(/no longer in the history/i)).toBeDefined()
    await waitFor(() => {
      const listed = api.requests.filter((request) =>
        request.route.endsWith('GET /content/post/doc-1/revisions'),
      ).length
      expect(listed).toBeGreaterThan(listedBefore)
    })
  })

  it('explains a snapshot the current rules refuse, without Zod internals', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse(
            { error: 'invalid_state', issues: [{ path: 'blocks.0', message: 'zod says no' }] },
            400,
          )
        : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    expect(await within(dialog).findByText(/predates the current content rules/i)).toBeDefined()
    expect(dialog.textContent).not.toContain('zod says no')
  })

  it('locates each validated missing-media reference in words, never as identifiers', async () => {
    await openDocument({
      revisions: [fakeRevision({ id: 'rev-1', version: 1, blocks: [oldParagraph, oldImage] })],
    })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse(
            {
              error: 'unprocessable',
              reason: 'media-missing',
              references: [
                { source: 'block', mediaId: MEDIA_ID, at: IMAGE_BLOCK_ID },
                { source: 'meta', mediaId: MEDIA_ID, at: 'featuredMediaId' },
              ],
            },
            422,
          )
        : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    expect(
      await within(dialog).findByText('Block 2 (Image) names an image that no longer exists.'),
    ).toBeDefined()
    expect(
      within(dialog).getByText('The "featuredMediaId" field names an image that no longer exists.'),
    ).toBeDefined()
    // Neither the medium nor the block is ever named by identifier.
    expect(within(dialog).getByRole('alert').textContent).not.toContain(MEDIA_ID)
    expect(within(dialog).getByRole('alert').textContent).not.toContain(IMAGE_BLOCK_ID)
  })

  it('keeps one write in flight: a running restore closes the save button', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore') ? new Promise<Response>(() => {}) : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    // The second invocation is absorbed: the confirm button is now pending.
    expect(await within(dialog).findByRole('button', { name: /restoring/i })).toHaveProperty(
      'disabled',
      true,
    )
    expect(screen.getByRole('button', { name: /^save$/i })).toHaveProperty('disabled', true)
  })

  it('shows every field the restore would replace, not just the text', async () => {
    // Differs from the live document only where the old panel said nothing:
    // metadata, parent and the publication instant.
    await openDocument({
      revisions: [
        fakeRevision({
          id: 'rev-1',
          version: 1,
          title: 'A live document',
          slug: 'a-live-document',
          status: 'published',
          publishedAt: '2026-03-05T00:00:00.000Z',
          parentId: '00000000-0000-4000-8000-0000000000dd',
          meta: { kicker: 'From the old build' },
        }),
      ],
    })
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    await within(dialog).findByRole('heading', { name: 'A live document' })
    // The publication instant, formatted; the parent and the metadata as a
    // labelled technical section — escaped text, never markup.
    expect(within(dialog).getByText(/Mar 5, 2026/)).toBeDefined()
    expect(within(dialog).getByText('00000000-0000-4000-8000-0000000000dd')).toBeDefined()
    expect(within(dialog).getByText(/"kicker"/)).toBeDefined()
    expect(within(dialog).getByText(/From the old build/)).toBeDefined()
  })

  it('scopes a restore outcome to the revision it was attempted on', async () => {
    await openDocument({
      revisions: [
        fakeRevision({ id: 'rev-a', version: 2, title: 'With the image', blocks: [oldImage] }),
        fakeRevision({ id: 'rev-b', version: 1, title: 'Plain words', blocks: [oldParagraph] }),
      ],
    })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse(
            {
              error: 'unprocessable',
              reason: 'media-missing',
              references: [{ source: 'block', mediaId: MEDIA_ID, at: IMAGE_BLOCK_ID }],
            },
            422,
          )
        : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 2/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))
    await within(dialog).findByText(/block 1 \(image\)/i)

    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await within(dialog).findByRole('heading', { name: 'Plain words' })

    // The refusal belonged to the attempt on version 2; nothing about it —
    // not the alert, not the located block — may appear under version 1.
    expect(within(dialog).queryByRole('alert')).toBeNull()
    expect(within(dialog).queryByText(/block 1 \(image\)/i)).toBeNull()
  })

  it('clears a selection whose revision vanished, reloads the list, and says so', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'GET' && /\/revisions\/[^/]+$/.test(path)
        ? jsonResponse({ error: 'not_found', reason: 'revision-not-found' }, 404)
        : null,
    )
    const dialog = await openHistory()
    const listedBefore = api.requests.filter(
      (request) => request.route === 'GET /content/post/doc-1/revisions',
    ).length
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    expect(await within(dialog).findByText(/no longer in the history/i)).toBeDefined()
    // The stale selection is gone — no revision heading — and the list asked
    // the server again for what the history holds now.
    expect(within(dialog).queryByRole('heading', { level: 3 })).toBeNull()
    await waitFor(() => {
      const listed = api.requests.filter(
        (request) => request.route === 'GET /content/post/doc-1/revisions',
      ).length
      expect(listed).toBeGreaterThan(listedBefore)
    })
  })

  it('offers a retry when the detail fails temporarily', async () => {
    await openDocument({
      revisions: [fakeRevision({ id: 'rev-1', version: 1, title: 'Recovered detail' })],
    })
    let failures = 0
    routesAnswering((method, path) => {
      if (method === 'GET' && /\/revisions\/[^/]+$/.test(path) && failures === 0) {
        failures += 1
        return jsonResponse({ error: 'server_error' }, 500)
      }
      return null
    })
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    const alert = await within(dialog).findByRole('alert')
    await userEvent.click(within(alert).getByRole('button', { name: /try again/i }))

    expect(await within(dialog).findByRole('heading', { name: 'Recovered detail' })).toBeDefined()
  })

  it('closes once, through the platform close event alone', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    const dialog = await openHistory()
    const opener = screen.getByRole('button', { name: /^history$/i })

    /*
     * The focus return is the observable half of the close callback: were the
     * Close button to run the cleanup itself and the close event to run it
     * again, the opener would be focused twice. Restored in `finally`, like
     * the console spy below: a red assertion — or a close that never comes —
     * must not leave every button's `focus` patched behind it.
     */
    const focusSpy = vi.spyOn(HTMLButtonElement.prototype, 'focus')
    try {
      await userEvent.click(within(dialog).getByRole('button', { name: /^close$/i }))
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())

      expect(focusSpy.mock.contexts.filter((element) => element === opener)).toHaveLength(1)
    } finally {
      focusSpy.mockRestore()
    }
  })

  it('nests marks exactly as the reference renderer does', async () => {
    await openDocument({
      revisions: [
        fakeRevision({
          id: 'rev-1',
          version: 1,
          blocks: [
            {
              id: PARAGRAPH_ID,
              type: 'paragraph',
              content: [
                { type: 'text', text: 'both marks', marks: [{ type: 'bold' }, { type: 'italic' }] },
              ],
            },
          ],
        }),
      ],
    })
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))

    // First mark outermost — packages/blocks/render.ts wraps over the
    // reversed list, so [bold, italic] is <strong><em>…</em></strong>.
    const text = await within(dialog).findByText('both marks')
    expect(text.tagName).toBe('EM')
    expect(text.parentElement?.tagName).toBe('STRONG')
  })

  it('names missing media on an ordinary save with the same validated details', async () => {
    serverSays({
      documents: [{ ...liveDocument(permitted()), blocks: [oldImage] }],
    })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
    routesAnswering((method, path) =>
      method === 'PATCH' && path.startsWith('/content/')
        ? jsonResponse(
            {
              error: 'unprocessable',
              reason: 'media-missing',
              references: [{ source: 'block', mediaId: MEDIA_ID, at: IMAGE_BLOCK_ID }],
            },
            422,
          )
        : null,
    )

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' touched')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(
      await screen.findByText('Block 1 (Image) names an image that no longer exists.'),
    ).toBeDefined()
  })

  it('drops a malformed media-missing body instead of trusting it', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse(
            {
              error: 'unprocessable',
              reason: 'media-missing',
              references: [{ source: 'block', mediaId: 'raw-id-9', at: 'not-a-uuid' }],
            },
            422,
          )
        : null,
    )
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

    // The named message alone: a body the contract refuses attaches nothing,
    // and nothing raw reaches the screen.
    const alert = await within(dialog).findByRole('alert')
    expect(alert.textContent).toMatch(/names an image that no longer exists/i)
    expect(within(alert).queryAllByRole('listitem')).toHaveLength(0)
    expect(dialog.textContent).not.toContain('not-a-uuid')
    expect(dialog.textContent).not.toContain('raw-id-9')
  })

  /**
   * Suspends chosen routes until released; everything else reaches the fake.
   * With an `answer`, the released route resolves to it instead of the fake —
   * a request that hangs and then fails, deterministically.
   */
  function gatedRoutes(match: (method: string, path: string) => boolean, answer?: () => Response) {
    const inner = api.fetchMock
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(String(input))
        if (match(init.method ?? 'GET', url.pathname)) {
          return gate.then(() => (answer ? answer() : inner(input, init)))
        }
        return inner(input, init)
      }),
    )
    return release
  }

  const editorFieldset = () => {
    const fieldset = document.querySelector('fieldset.editor')
    if (!(fieldset instanceof HTMLFieldSetElement)) throw new Error('no editor fieldset')
    return fieldset
  }

  it('cannot be dismissed while a restore is in flight', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore') ? new Promise<Response>(() => {}) : null,
    )
    const dialog = await openHistory()
    // Dismissible while nothing runs: the native boundary is not declared.
    expect(dialog.getAttribute('closedby')).toBeNull()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))
    await within(dialog).findByRole('button', { name: /restoring/i })

    /*
     * The platform boundary is declared for the whole flight — where closedby
     * is known, no user action closes the dialog at all — and the prevented
     * cancel below is the fallback for engines that do not know it yet.
     * Cancel is closed, and the editor behind stays frozen: there is no way
     * back to the draft while the write that will replace it is running.
     */
    expect(dialog.getAttribute('closedby')).toBe('none')
    expect(within(dialog).getByRole('button', { name: /keep the current state/i })).toHaveProperty(
      'disabled',
      true,
    )
    const cancel = new Event('cancel', { cancelable: true })
    ;(dialog as HTMLDialogElement).dispatchEvent(cancel)
    expect(cancel.defaultPrevented).toBe(true)
    expect((dialog as HTMLDialogElement).open).toBe(true)
    expect(editorFieldset().disabled).toBe(true)
  })

  it('freezes the document while a restore runs, and loses nothing on success', async () => {
    serverSays({
      documents: [liveDocument(permitted())],
      revisions: [
        fakeRevision({ id: 'rev-1', version: 1, title: 'The first wording', status: 'draft' }),
      ],
    })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
    const release = gatedRoutes((method, path) => method === 'POST' && path.endsWith('/restore'))
    const dialog = await openHistory()
    await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
    await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
    await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))
    await within(dialog).findByRole('button', { name: /restoring/i })

    // Nothing can be typed while the write runs, so nothing can be lost by it.
    expect(editorFieldset().disabled).toBe(true)
    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'X')
    expect((screen.getByPlaceholderText(/^title$/i) as HTMLTextAreaElement).value).toBe(
      'A live document',
    )

    release()
    await within(dialog).findByText(/version 1 restored/i)
    // Settled: the native boundary is withdrawn and closing works again.
    expect(dialog.getAttribute('closedby')).toBeNull()
    expect((screen.getByPlaceholderText(/^title$/i) as HTMLTextAreaElement).value).toBe(
      'The first wording',
    )
    expect(screen.queryByText(/not saved yet/i)).toBeNull()
  })

  it('freezes the fields while a save runs and locates its refusal in the submitted blocks', async () => {
    serverSays({ documents: [{ ...liveDocument(permitted()), blocks: [oldImage] }] })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
    const release = gatedRoutes(
      (method, path) => method === 'PATCH' && path.startsWith('/content/'),
      () =>
        jsonResponse(
          {
            error: 'unprocessable',
            reason: 'media-missing',
            references: [{ source: 'block', mediaId: MEDIA_ID, at: IMAGE_BLOCK_ID }],
          },
          422,
        ),
    )

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' touched')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(editorFieldset().disabled).toBe(true))

    // The fields hold still for the duration of the request…
    await userEvent.type(screen.getByPlaceholderText(/^title$/i), 'MORE')
    expect((screen.getByPlaceholderText(/^title$/i) as HTMLTextAreaElement).value).toBe(
      'A live document touched',
    )

    release()
    // …and the refusal is located in the snapshot that was actually sent.
    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByText('Block 1 (Image) names an image that no longer exists.'),
    ).toBeDefined()
    // A refused save leaves the work unsaved, and the indicator says so.
    expect(screen.getByText(/not saved yet/i)).toBeDefined()
  })

  it('keeps the unsaved indicator truthful across a write', async () => {
    await openDocument()
    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' one')
    expect(screen.getByText(/not saved yet/i)).toBeDefined()

    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await screen.findByText('Saved')
    expect(screen.queryByText(/not saved yet/i)).toBeNull()

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' two')
    expect(screen.getByText(/not saved yet/i)).toBeDefined()
    expect(screen.queryByText('Saved')).toBeNull()
  })

  it('announces the general message and the located references as one region', async () => {
    serverSays({ documents: [{ ...liveDocument(permitted()), blocks: [oldImage] }] })
    await open('/content/post/doc-1')
    await screen.findByDisplayValue('A live document')
    routesAnswering((method, path) =>
      method === 'PATCH' && path.startsWith('/content/')
        ? jsonResponse(
            {
              error: 'unprocessable',
              reason: 'media-missing',
              references: [{ source: 'block', mediaId: MEDIA_ID, at: IMAGE_BLOCK_ID }],
            },
            422,
          )
        : null,
    )

    await userEvent.type(screen.getByPlaceholderText(/^title$/i), ' touched')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    // One announced region: a list outside the alert is a list a screen
    // reader never mentions.
    const alert = await screen.findByRole('alert')
    expect(
      within(alert).getByText('This document names an image that no longer exists'),
    ).toBeDefined()
    expect(
      within(alert).getByText('Block 1 (Image) names an image that no longer exists.'),
    ).toBeDefined()
  })

  it('keeps reference lines apart when two media share one place', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    routesAnswering((method, path) =>
      method === 'POST' && path.endsWith('/restore')
        ? jsonResponse(
            {
              error: 'unprocessable',
              reason: 'media-missing',
              references: [
                { source: 'meta', mediaId: 'medium-one', at: 'gallery' },
                { source: 'meta', mediaId: 'medium-two', at: 'gallery' },
              ],
            },
            422,
          )
        : null,
    )
    // Spied without a replacement implementation, so unexpected diagnostics
    // still reach the console — and restored in finally, so a failing
    // assertion cannot leave the spy behind for the tests after this one.
    const consoleError = vi.spyOn(console, 'error')
    try {
      const dialog = await openHistory()
      await userEvent.click(within(dialog).getByRole('button', { name: /version 1/i }))
      await userEvent.click(await within(dialog).findByRole('button', { name: /^restore$/i }))
      await userEvent.click(within(dialog).getByRole('button', { name: /^restore$/i }))

      const alert = await within(dialog).findByRole('alert')
      expect(within(alert).getAllByRole('listitem')).toHaveLength(2)
      // Distinct keys, so React never warns — and the ids stay out of the text.
      expect(consoleError.mock.calls.flat().join(' ')).not.toMatch(/same key/i)
      expect(alert.textContent).not.toContain('medium-one')
      expect(alert.textContent).not.toContain('medium-two')
    } finally {
      consoleError.mockRestore()
    }
  })

  it('holds the focus contract: in on open, back to the opener on close', async () => {
    await openDocument({ revisions: [fakeRevision({ id: 'rev-1', version: 1 })] })
    const dialog = await openHistory()

    // The declared initial target, focused by the opening effect.
    expect(document.activeElement).toBe(within(dialog).getByRole('button', { name: /^close$/i }))

    /*
     * Escape reaches jsdom as nothing — the platform's cancel-then-close is
     * native behaviour it does not implement — so the test drives the same
     * close the platform would, and the browser walk in e2e presses the real
     * key. What is pinned here is ours: the close handler returns focus to
     * the control that opened the panel.
     */
    act(() => {
      ;(dialog as HTMLDialogElement).close()
    })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^history$/i }))
  })
})
