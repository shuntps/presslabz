import type { FastifyCorsOptions } from '@fastify/cors'

/**
 * Who may call this API from a browser, and with what.
 *
 * Two things are settled here rather than at the registration site, because
 * both have already been got wrong once.
 *
 * **The origin list is exact.** Never `true`, never `*`, never a function that
 * reflects whatever arrived: these requests carry the session cookie, and an
 * origin that is echoed back is an origin nobody authorised. The cost of being
 * exact is that a mismatch is total — a browser on `http://127.0.0.1:5173`
 * talking to an API that allows `http://localhost:5173` cannot read the
 * response at all, not even a 401. That is not a bug to work around by
 * loosening the list; it is a deployment configured with two names for one
 * host, and the fix is to pick one. Adding both origins would not even work:
 * the session cookie is `SameSite=Lax`, and `localhost` and `127.0.0.1` are
 * different sites, so a cross-site fetch would not send it.
 *
 * **The method list is explicit.** The plugin's default is GET, HEAD and POST,
 * so every PATCH and DELETE this API serves was refused by the browser before
 * it left the page — while curl and `app.inject()` sailed through, because
 * neither performs a preflight.
 */
export function corsOptions(origins: readonly string[]): FastifyCorsOptions {
  return {
    origin: [...origins],
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  }
}
