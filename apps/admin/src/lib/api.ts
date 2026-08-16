const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3000'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    /**
     * The server distinguishes a taken slug from an existing translation and
     * says which in `reason`. Dropping it here would leave the interface to
     * guess, or to say "conflict" and let the author work out what kind.
     */
    readonly reason?: string,
  ) {
    super(code)
    this.name = 'ApiError'
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
