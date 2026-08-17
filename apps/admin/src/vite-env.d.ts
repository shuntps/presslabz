/// <reference types="vite/client" />

/**
 * The client's own configuration, declared rather than reached for through
 * Vite's index signature — which types every unknown key as `any` and would
 * make a typo compile.
 *
 * Only `VITE_`-prefixed variables are compiled into the bundle, so everything
 * declared here is public by construction. Nothing secret may join it.
 */
interface ImportMetaEnv {
  /**
   * Where the admin sends its requests, read from the monorepo's .env — see
   * `envDir` in vite.config.ts. It has to name the same host the browser has
   * in its address bar: CORS compares whole origins, and the session cookie is
   * SameSite=Lax, so localhost and 127.0.0.1 cannot be mixed.
   *
   * Substituted at build time, like every `VITE_` value. Each build takes what
   * the environment holds then; a bundle already built cannot be repointed.
   */
  readonly VITE_API_URL?: string
}
