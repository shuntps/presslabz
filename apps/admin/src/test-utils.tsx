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

export interface RequestRecord {
  route: string
  body: unknown
}

export function fakeApi() {
  const state = { signedIn: false, locale: 'en' }
  const requests: RequestRecord[] = []
  const documents: Record<string, unknown>[] = []

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
        ? json({ types: [{ name: 'post', hierarchical: false, taxonomies: [] }] })
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
        ...(body as Record<string, unknown>),
      }
      documents.push(created)
      return json({ content: created }, 201)
    }
    if (method === 'GET' && url.pathname.startsWith('/content/post/')) {
      const id = url.pathname.split('/').pop()
      const found = documents.find((document) => document.id === id)
      return found ? json({ content: found }) : json({ error: 'not_found' }, 404)
    }
    if (url.pathname.startsWith('/content/')) return json({ contents: documents })

    return json({}, 404)
  })

  return { state, requests, documents, fetchMock }
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
