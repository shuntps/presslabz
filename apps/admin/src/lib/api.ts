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
export const API_URL = import.meta.env.VITE_API_URL?.trim() || 'http://localhost:3000'

/**
 * How long a request may go unanswered before the interface says so.
 *
 * A fetch has no timeout of its own: a server that accepts the connection and
 * never answers leaves the promise pending for as long as the tab is open, and
 * a query that never settles is a screen that never leaves "Loading…" — no
 * error, no retry, nothing to act on. That is the state a misrouted port left
 * the admin in, and it looked like a broken application rather than an
 * unreachable API.
 *
 * Fifteen seconds is far longer than any of these routes takes and short
 * enough to be an answer rather than a wait.
 */
export const REQUEST_TIMEOUT_MS = 15_000

/**
 * An upload is the one request whose duration is the user's file rather than
 * the server's work: it is sent over the wire and then decoded and re-encoded
 * twice, behind a queue that bounds how many run at once.
 */
export const UPLOAD_TIMEOUT_MS = 120_000

/** No HTTP status, because nothing answered. */
export const NO_RESPONSE = 0

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

export interface ApiFetchInit extends RequestInit {
  /** Overridden for uploads, which are legitimately slow. */
  timeoutMs?: number
}

/**
 * `credentials: 'include'` is what carries the session cookie across origins
 * in development, where the admin runs on 5173 and the API on 3000. The API
 * allows exactly that origin, never a wildcard.
 */
export async function apiFetch<T>(path: string, init: ApiFetchInit = {}): Promise<T> {
  const { timeoutMs = REQUEST_TIMEOUT_MS, signal, ...rest } = init

  /*
   * The caller's own signal still cancels — a component that unmounts should
   * not have to wait out the timeout — and either one aborting aborts the
   * request.
   */
  const deadline = AbortSignal.timeout(timeoutMs)
  const aborter = signal ? AbortSignal.any([signal, deadline]) : deadline

  let response: Response

  try {
    response = await fetch(`${API_URL}${path}`, {
      ...rest,
      signal: aborter,
      credentials: 'include',
      headers: {
        /*
         * Named only for a body this function serialized. Announcing JSON and
         * then sending nothing is what made sign-out answer 400; announcing it
         * over a FormData would be worse, because the browser has to set that
         * header itself — it carries the multipart boundary, and a
         * hand-written one is always wrong.
         */
        ...(typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    })
  } catch (error) {
    // A caller that cancelled deliberately is not a failure to report.
    if (signal?.aborted) throw error

    /*
     * Two shapes of one fact — nothing answered — that both used to arrive as
     * an unlabelled TypeError, or as nothing at all. Named here so a screen
     * can say which of "there is no API at this address" and "it never
     * answered" happened, instead of showing a spinner for as long as the tab
     * stays open.
     */
    throw new ApiError(NO_RESPONSE, deadline.aborted ? 'timeout' : 'unreachable')
  }

  if (response.status === 204) return undefined as T

  const body = await response.json().catch(() => null)

  if (!response.ok) {
    const code = typeof body?.error === 'string' ? body.error : 'unexpected'
    const reason = typeof body?.reason === 'string' ? body.reason : undefined
    throw new ApiError(response.status, code, reason)
  }

  return body as T
}
