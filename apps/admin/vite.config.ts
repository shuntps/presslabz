import { THEME_INIT_SCRIPT } from '@presslabz/tokens'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

/**
 * Injects the pre-paint theme script from @presslabz/tokens rather than
 * duplicating it in index.html, so the script has exactly one definition.
 * It must be inline and blocking: an external file would be fetched after
 * first paint and the page would flash.
 */
function themeInitScript(): Plugin {
  return {
    name: 'presslabz-theme-init',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => ({
        html,
        tags: [
          {
            tag: 'script',
            children: THEME_INIT_SCRIPT,
            injectTo: 'head-prepend',
          },
        ],
      }),
    },
  }
}

/**
 * One .env for the installation, at the root of the monorepo.
 *
 * Vite loads .env from its own project root unless told otherwise, so this app
 * was reading `apps/admin/.env` — a file nobody creates. `VITE_API_URL` set at
 * the root therefore did nothing, in development and in the build alike, and
 * the admin silently kept its compiled-in default while the operator believed
 * they had pointed it somewhere else. The API reads that same root file
 * (`node --env-file-if-exists=../../.env`), so this is what makes the two
 * halves of a deployment configurable from one place.
 *
 * Only `VITE_`-prefixed variables are exposed to the client, which is Vite's
 * own rule and the reason nothing secret can leak this way: the root file
 * holds database and S3 credentials, and none of them carry that prefix.
 *
 * That file also carries NODE_ENV, which is the API's business and not this
 * app's — Vite reads NODE_ENV out of env files, so a production build was
 * inheriting `development` from it. The mode is therefore decided before Vite
 * starts, in scripts/build.ts, which explains why it cannot be decided here.
 *
 * `VITE_API_URL` is substituted into the bundle at build time. It is
 * configurable per environment and per build; it does not become something an
 * image or a bundle can be repointed at afterwards.
 */
export default defineConfig({
  plugins: [react(), themeInitScript()],
  // Relative to the project root, which is this directory: Vite's own way of
  // saying it, and the one that does not care where the command was run from.
  envDir: '../..',
  server: {
    port: 5173,
    strictPort: true,
  },
})
