import {
  CONTENT_STATUSES,
  type CreationPermissions,
  type DocumentPermissions,
} from '@presslabz/core'
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

export interface FakeMedia {
  id: string
  url: string
  mimeType: string
  byteSize: number
  width: number | null
  height: number | null
  alt: Record<string, string>
  createdAt: string
  renditions: never[]
  permissions: { update: boolean }
}

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

export interface FakeApiOptions {
  /** Documents that already exist, each carrying what this actor may do with it. */
  documents?: Record<string, unknown>[]
  /** What the server says about creating one of this type. */
  creationPermissions?: CreationPermissions
  /** What it says about a document this session creates. */
  documentPermissions?: DocumentPermissions
  media?: FakeMedia[]
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
  const state = { signedIn: false, locale: 'en' }
  const requests: RequestRecord[] = []
  const documents: Record<string, unknown>[] = [...(options.documents ?? [])]
  const media: FakeMedia[] = [...(options.media ?? [])]
  const creationPermissions = options.creationPermissions ?? FULL_CREATION_PERMISSIONS
  const documentPermissions = options.documentPermissions ?? FULL_DOCUMENT_PERMISSIONS
  const mediaPermissions = options.mediaPermissions ?? { upload: true }
  const translationPermissions = options.translationPermissions ?? { create: true }

  const json = (body: unknown, status = 200) =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )

  const fetchMock = vi.fn((input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input))
    const method = init.method ?? 'GET'
    const route = `${method} ${url.pathname}`
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body))
    requests.push({ route, body })

    if (route === 'GET /auth/me') {
      return state.signedIn ? json({ user: { ...testUser, locale: state.locale } }) : json({}, 401)
    }
    if (route === 'POST /auth/login') {
      state.signedIn = true
      return json({ user: { ...testUser, locale: state.locale } })
    }
    if (route === 'POST /auth/logout') {
      state.signedIn = false
      return Promise.resolve(new Response(null, { status: 204 }))
    }
    if (route === 'PATCH /auth/preferences') {
      const patch = body as { locale?: string }
      if (patch?.locale) state.locale = patch.locale
      return json(patch)
    }
    if (route === 'GET /content-types') {
      return state.signedIn
        ? json({
            types: [
              {
                name: 'post',
                hierarchical: false,
                taxonomies: [],
                permissions: creationPermissions,
              },
            ],
          })
        : json({}, 401)
    }
    if (method === 'POST' && url.pathname === '/content/post') {
      const created = {
        id: `doc-${documents.length + 1}`,
        type: 'post',
        translationGroupId: 'group-1',
        excerpt: null,
        meta: {},
        authorId: testUser.id,
        parentId: null,
        publishedAt: null,
        createdAt: '2026-08-16T09:00:00.000Z',
        updatedAt: '2026-08-16T09:00:00.000Z',
        permissions: documentPermissions,
        ...(body as Record<string, unknown>),
      }
      documents.push(created)
      return json({ content: created }, 201)
    }
    if (method === 'GET' && url.pathname.endsWith('/translations')) {
      return json({ translations: [], permissions: translationPermissions })
    }
    if (method === 'GET' && url.pathname.startsWith('/content/post/')) {
      const id = url.pathname.split('/').pop()
      const found = documents.find((document) => document.id === id)
      return found ? json({ content: found }) : json({ error: 'not_found' }, 404)
    }
    if (url.pathname.startsWith('/content/')) return json({ contents: documents })

    if (route === 'GET /media') return json({ media, permissions: mediaPermissions })
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
      return json({ media: found })
    }

    return json({}, 404)
  })

  return { state, requests, documents, media, fetchMock }
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
