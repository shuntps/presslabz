/**
 * Where the API is, as the installation configured it.
 *
 * An empty value is a missing value, not a request for same-origin calls: an
 * operator who writes `VITE_API_URL=` in .env means "I have not set this yet",
 * and resolving to relative paths would send every request to the admin's own
 * server — the dev server, in development — where it would be answered by the
 * page shell rather than by the API.
 *
 * The default is the canonical local configuration. It must match the host in
 * the browser's address bar; see vite-env.d.ts and .env.example for why the
 * two cannot be mixed.
 */
const API_URL = import.meta.env.VITE_API_URL?.trim() || 'http://localhost:3000'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  /**
   * The server distinguishes a taken slug from an existing translation and
   * says which in `reason`. Dropping it here would leave the interface to
   * guess, or to say "conflict" and let the author work out what kind.
   */
  readonly reason: string | undefined

  /**
   * Assigned in the body rather than declared as constructor parameter
   * properties. Vite compiles this app and would accept them, but the rule is
   * one rule: they are the syntax Node refuses to strip, and code that moves
   * into a shared package should not have to be rewritten to make the move.
   */
  constructor(status: number, code: string, reason?: string) {
    super(code)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.reason = reason
  }
}

/**
 * `credentials: 'include'` is what carries the session cookie across origins
 * in development, where the admin runs on 5173 and the API on 3000. The API
 * allows exactly that origin, never a wildcard.
 */
export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      /*
       * Named only for a body this function serialized. Announcing JSON and
       * then sending nothing is what made sign-out answer 400; announcing it
       * over a FormData would be worse, because the browser has to set that
       * header itself — it carries the multipart boundary, and a hand-written
       * one is always wrong.
       */
      ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...init.headers,
    },
  })

  if (response.status === 204) return undefined as T

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : 'unexpected'
    const reason = typeof body?.reason === 'string' ? body.reason : undefined
    throw new ApiError(response.status, code, reason)
  }

  return body as T
}
