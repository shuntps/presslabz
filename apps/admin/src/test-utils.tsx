// biome-ignore-all lint/suspicious/noDocumentCookie: the fixture clears what a
// previous test left in the document, which is what a fresh browser would be.
import {
  CONTENT_STATUSES,
  type CreationPermissions,
  contentDocumentSchema,
  contentPageSchema,
  contentTypesSchema,
  type DocumentPermissions,
  installationConfigSchema,
  type MediaSummary,
  mediaDocumentSchema,
  mediaPageSchema,
  translationSetSchema,
} from '@presslabz/core'
import { LOCALE_COOKIE_NAME } from '@presslabz/i18n'
import { THEME_COOKIE_NAME } from '@presslabz/tokens'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { vi } from 'vitest'
import { App } from './app.tsx'
import { LocaleProvider } from './lib/i18n.tsx'
import { ThemeProvider } from './lib/theme.tsx'

/**
 * A fake API small enough to read and stateful enough to sign in and out of,
 * shared by every test in this app so there is one description of what the
 * server does rather than one per file drifting away from the others.
 *
 * Every response it sends is parsed by the same schemas the real client parses
 * real responses with, and `assertContract` below makes that a failure rather
 * than a warning. A double that answers something the server would never send
 * is a test passing against a fiction — which is what this one was doing: it
 * had no `version` on a document, no `slug` on several, and a listing shape
 * the API had already stopped using.
 */

export const testUser = {
  id: 'u1',
  email: 'someone@presslabz.test',
  displayName: 'Someone',
  role: 'administrator',
  locale: 'en',
  themePreference: 'system',
  capabilities: ['content:read', 'content:create', 'content:publish'],
}

/**
 * Permissions arrive from the server rather than being worked out in the
 * browser, so the fake has to send them — and a test that wants a restricted
 * actor changes what the server says, not what the component computes. That is
 * the property being protected: the interface has no second copy of the rule.
 */
export const FULL_DOCUMENT_PERMISSIONS: DocumentPermissions = {
  update: true,
  delete: true,
  statuses: [...CONTENT_STATUSES],
}

export const FULL_CREATION_PERMISSIONS: CreationPermissions = {
  create: true,
  statuses: [...CONTENT_STATUSES],
}

export type FakeMedia = MediaSummary

export function fakeMedia(overrides: Partial<FakeMedia> = {}): FakeMedia {
  return {
    id: 'm1',
    url: 'http://localhost:9000/media/m1.avif',
    mimeType: 'image/avif',
    byteSize: 512,
    width: 40,
    height: 30,
    alt: {},
    createdAt: '2026-08-16T09:00:00.000Z',
    renditions: [],
    permissions: { update: true },
    ...overrides,
  }
}

/**
 * A document as the server describes one, for tests that need a listing with
 * something in it. Every field the contract requires is present, because the
 * fake now validates what it sends and a half-built fixture fails loudly here
 * rather than quietly passing a test against a shape the API never sends.
 */
export function fakeDocument(overrides: Record<string, unknown> = {}) {
  return {
    id: 'doc-1',
    type: 'post',
    locale: 'en',
    translationGroupId: 'group-1',
    slug: 'a-document',
    status: 'published',
    title: 'A document',
    excerpt: null,
    blocks: [],
    meta: {},
    authorId: testUser.id,
    parentId: null,
    publishedAt: '2026-01-01T00:00:00.000Z',
    version: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    permissions: FULL_DOCUMENT_PERMISSIONS,
    ...overrides,
  }
}

export interface FakeApiOptions {
  /** Documents that already exist, each carrying what this actor may do with it. */
  documents?: Record<string, unknown>[]
  /** What the server says about creating one of this type. */
  creationPermissions?: CreationPermissions
  /** What it says about a document this session creates. */
  documentPermissions?: DocumentPermissions
  media?: FakeMedia[]
  /** What this installation says it serves. Defaults to both languages. */
  locales?: ('en' | 'fr')[]
  /** How many rows a page holds, so a test can force a second one. */
  pageSize?: number
  /** Whether this actor may add to the library. */
  mediaPermissions?: { upload: boolean }
  /**
   * Whether a translation may be started in the group being viewed. Separate
   * from `creationPermissions` on purpose: joining a group also needs the right
   * to write one of its members, which is a fact about the group.
   */
  translationPermissions?: { create: boolean }
}

export interface RequestRecord {
  route: string
  body: unknown
}

export function fakeApi(options: FakeApiOptions = {}) {
  /*
   * What the server holds for this account. A test changes it to stand for
   * "chosen on another machine", which is the only way that path can be
   * exercised from here.
   */
  const state = { signedIn: false, locale: 'en', themePreference: 'system' }
  const requests: RequestRecord[] = []
  /*
   * Copied, not referenced. The fake writes to these on PATCH, the way the
   * server writes to rows, and a test's fixture is usually a module-level
   * constant shared with every other test in the file — so without this, one
   * test's edit is the next test's starting state.
   */
  const documents: Record<string, unknown>[] = structuredClone(options.documents ?? [])
  const media: FakeMedia[] = structuredClone(options.media ?? [])
  const creationPermissions = options.creationPermissions ?? FULL_CREATION_PERMISSIONS
  const documentPermissions = options.documentPermissions ?? FULL_DOCUMENT_PERMISSIONS
  const mediaPermissions = options.mediaPermissions ?? { upload: true }
  const pageSize = options.pageSize ?? 25

  /** Documents of the same group in another language, keyed by locale. */
  const siblingsOf = (document: Record<string, unknown>) =>
    Object.fromEntries(
      documents
        .filter(
          (candidate) =>
            candidate.translationGroupId === document.translationGroupId &&
            candidate.locale !== document.locale,
        )
        .map((sibling) => [sibling.locale as string, sibling]),
    )
  const translationPermissions = options.translationPermissions ?? { create: true }

  /**
   * Sends a body, having checked it is one the API could have sent.
   *
   * Only successful answers are checked: a 401 or a 404 carries an error
   * shape, not a document, and the client reads those without a schema.
   */
  const json = (body: unknown, status = 200, schema?: { parse: (value: unknown) => unknown }) => {
    if (status < 400 && schema) schema.parse(body)

    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )
  }

  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const route = `${method} ${url.pathname}`
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ route, body })

    const currentUser = () => ({
      ...testUser,
      locale: state.locale,
      themePreference: state.themePreference,
    })

    if (route === 'GET /auth/me') {
      return state.signedIn ? json({ user: currentUser() }) : json({}, 401)
    }
    if (route === 'POST /auth/login') {
      state.signedIn = true
      return json({ user: currentUser() })
    }
    if (route === 'POST /auth/logout') {
      state.signedIn = false
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (route === 'PATCH /auth/preferences') {
      const patch = body as { locale?: string; themePreference?: string }
      if (patch?.locale) state.locale = patch.locale
      if (patch?.themePreference) state.themePreference = patch.themePreference
      return json(patch)
    }
    if (route === 'GET /config') {
      return json(
        { locales: options.locales ?? ['en', 'fr'], defaultLocale: options.locales?.[0] ?? 'en' },
        200,
        installationConfigSchema,
      )
    }

    if (route === 'GET /content-types') {
      return state.signedIn
        ? json(
            {
              types: [
                {
                  name: 'post',
                  hierarchical: false,
                  taxonomies: [],
                  permissions: creationPermissions,
                },
              ],
            },
            200,
            contentTypesSchema,
          )
        : json({}, 401)
    }
    if (method === 'POST' && url.pathname === '/content/post') {
      /*
       * Built from the same fixture every other document here is built from,
       * so it carries every field the contract requires. It did not: `version`
       * was missing, the response failed validation inside this fake, and the
       * editor saw the create as a network failure — in every test that
       * created a document, none of which looked at the answer.
       */
      const created = {
        ...fakeDocument(),
        id: `doc-${documents.length + 1}`,
        translationGroupId: 'group-1',
        permissions: documentPermissions,
        ...(body as Record<string, unknown>),
      }
      documents.push(created)
      return json({ content: created }, 201, contentDocumentSchema)
    }
    /*
     * An edit lands on the stored document and comes back as the server would
     * send it: merged, with the version moved on. It used to fall through to
     * the listing branch and answer a page — which every test accepted,
     * because nothing looked at what came back.
     */
    if (method === 'PATCH' && url.pathname.startsWith('/content/')) {
      const id = url.pathname.split('/').pop()
      const found = documents.find((document) => document.id === id)
      if (!found) return json({ error: 'not_found' }, 404)

      const { expectedVersion, ...changes } = (body ?? {}) as Record<string, unknown>
      if (typeof expectedVersion === 'number' && expectedVersion !== found.version) {
        return json({ error: 'conflict', reason: 'stale-version' }, 409)
      }

      Object.assign(found, changes, {
        version: (found.version as number) + 1,
        updatedAt: '2026-08-16T10:00:00.000Z',
      })
      return json({ content: found }, 200, contentDocumentSchema)
    }

    if (method === 'GET' && url.pathname.endsWith('/translations')) {
      // The whole group, the way the real endpoint answers it: the document
      // asked about is in the list, and so are its other languages.
      const id = url.pathname.split('/').at(-2)
      const anchor = documents.find((document) => document.id === id)
      const group = anchor
        ? documents.filter((document) => document.translationGroupId === anchor.translationGroupId)
        : []

      return json(
        { translations: group, permissions: translationPermissions },
        200,
        translationSetSchema,
      )
    }
    if (method === 'GET' && url.pathname.startsWith('/content/post/')) {
      const id = url.pathname.split('/').pop()
      const found = documents.find((document) => document.id === id)
      return found
        ? json({ content: found }, 200, contentDocumentSchema)
        : json({ error: 'not_found' }, 404)
    }
    /*
     * A page of translation groups, the way the real listing answers. The
     * cursor is the index of the next row, which is a cursor this fake issued
     * and nothing else reads — exactly the contract the real one keeps.
     */
    if (url.pathname.startsWith('/content/')) {
      const locale = url.searchParams.get('locale') ?? 'en'
      const rows = documents.filter((document) => (document.locale ?? 'en') === locale)
      const limit = Number(url.searchParams.get('limit') ?? pageSize)
      const from = Number(url.searchParams.get('cursor') ?? 0)
      const page = rows.slice(from, from + limit)

      return json(
        {
          groups: page.map((document) => ({
            translationGroupId: document.translationGroupId,
            primary: document,
            siblings: siblingsOf(document),
          })),
          total: rows.length,
          drafts: rows.filter((document) => document.status === 'draft').length,
          nextCursor: from + limit < rows.length ? String(from + limit) : null,
        },
        200,
        contentPageSchema,
      )
    }

    if (url.pathname === '/media' && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? pageSize)
      const from = Number(url.searchParams.get('cursor') ?? 0)
      const page = media.slice(from, from + limit)

      return json(
        {
          media: page,
          permissions: mediaPermissions,
          nextCursor: from + limit < media.length ? String(from + limit) : null,
        },
        200,
        mediaPageSchema,
      )
    }
    if (method === 'PATCH' && url.pathname.startsWith('/media/')) {
      const id = url.pathname.split('/').pop()
      const found = media.find((item) => item.id === id)
      if (!found) return json({ error: 'not_found' }, 404)
      // The server decides again, so a client that was told "no" and asked
      // anyway is answered rather than obeyed.
      if (!found.permissions.update) {
        return json({ error: 'forbidden', reason: 'media-forbidden' }, 403)
      }
      // A patch by language, merged — the same semantics the real route has,
      // so a client that sent a whole snapshot would be caught here too.
      for (const [locale, text] of Object.entries(
        (body as { alt: Record<string, string | null> }).alt,
      )) {
        if (text === null) delete found.alt[locale]
        else found.alt[locale] = text
      }
      return json({ media: found }, 200, mediaDocumentSchema)
    }

    return json({}, 404)
  })

  return { state, requests, documents, media, fetchMock }
}

/**
 * Forgets the preferences a previous test left in the document.
 *
 * The language and the theme are cookies now, which is the point — they
 * survive a reload — and jsdom keeps one document for a whole file, so
 * "survives a reload" becomes "survives into the next test". A test that
 * switched the interface to French would otherwise hand the next one an
 * interface in French, and its failure would be about a label it could not
 * find rather than about what it was testing.
 */
export function forgetPreferences() {
  for (const name of [THEME_COOKIE_NAME, LOCALE_COOKIE_NAME]) {
    document.cookie = `${name}=; Path=/; Max-Age=0`
  }
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('lang')
}

export function renderApp(children?: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  })

  return render(
    <QueryClientProvider client={client}>
      <LocaleProvider>
        <ThemeProvider>{children ?? <App />}</ThemeProvider>
      </LocaleProvider>
    </QueryClientProvider>,
  )
}

/**
 * The login form wraps its input in the label rather than pairing them by id,
 * so a text query matches both the label and the control. Naming the element
 * asks for the one that can be typed into.
 */
export const findInput = (name: RegExp, selector = 'input') =>
  screen.findByLabelText(name, { selector })

export const getInput = (name: RegExp, selector = 'input') =>
  screen.getByLabelText(name, { selector })

export async function signIn() {
  await userEvent.type(await findInput(/email/i), testUser.email)
  await userEvent.type(getInput(/password/i), 'passphrase')
  await userEvent.click(screen.getByRole('button', { name: /sign in/i }))
  await screen.findByRole('navigation')
}
