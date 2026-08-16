const API_URL = import.meta.env['VITE_API_URL'] ?? 'http://localhost:3000'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
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
      // Only when there is one to describe. Announcing a JSON body and then
      // sending nothing is what made sign-out answer 400.
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...init.headers,
    },
  })

  if (response.status === 204) return undefined as T

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : 'unexpected'
    throw new ApiError(response.status, code)
  }

  return body as T
}
