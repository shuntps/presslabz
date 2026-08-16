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

export default defineConfig({
  plugins: [react(), themeInitScript()],
  server: {
    port: 5173,
    strictPort: true,
  },
})
