import node from '@astrojs/node'
import { resolveLocaleConfig } from '@presslabz/i18n'
import { defineConfig } from 'astro/config'

/*
 * The repository keeps one .env at its root, and this file is read by Astro
 * before Vite's own env loading has happened — so nothing here would see it
 * otherwise. Same reasoning as the API's --env-file flag: one file, read by
 * whoever needs it, rather than a copy per app.
 */
try {
  process.loadEnvFile(new URL('../../.env', import.meta.url).pathname)
} catch {
  // A deployment supplies the environment directly. Validation happens in
  // src/env.ts, which refuses to start rather than assuming a default.
}

const { locales, defaultLocale } = resolveLocaleConfig({
  supported: process.env.SUPPORTED_LOCALES,
  default: process.env.DEFAULT_LOCALE,
})

/*
 * Read here rather than passed as flags: astro.config is the one place that
 * has already loaded the repository's .env, and a script interpolating unset
 * variables into `--host --port` starts a server on nothing.
 */
const host = process.env.WEB_HOST ?? '127.0.0.1'
const port = Number(process.env.WEB_PORT ?? 4321)

export default defineConfig({
  output: 'server',
  server: { host, port },
  adapter: node({ mode: 'standalone' }),
  /** Absolute URLs in canonical tags, hreflang and the sitemap need this. */
  site: process.env.SITE_URL ?? 'http://localhost:4321',
  /*
   * One URL per page. With 'ignore', `/en/about` and `/en/about/` are both
   * served, which is two cache entries and two things to index for one
   * document — and the canonical redirect below could not tell them apart.
   */
  trailingSlash: 'never',
  i18n: {
    locales: [...locales],
    defaultLocale,
    routing: {
      /*
       * Every locale is prefixed, the default one included. An unprefixed
       * default means changing DEFAULT_LOCALE later moves every URL on the
       * site, and it makes `hreflang` describe two different URL shapes.
       */
      prefixDefaultLocale: true,
      /*
       * Off, because `/` is ours: Astro would redirect straight to the default
       * locale, and the reader's own Accept-Language is a better answer than
       * the installation's default. src/pages/index.astro does that.
       */
      redirectToDefaultLocale: false,
    },
  },
  vite: {
    define: {
      /*
       * The locale list is baked into the build by the i18n block above. The
       * runtime compares it with the environment it actually starts under, so
       * a deployment that adds a language without rebuilding is told, rather
       * than serving routes Astro's i18n does not know about.
       */
      __BUILT_LOCALES__: JSON.stringify(locales),
    },
  },
})
