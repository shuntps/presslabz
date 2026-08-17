import { build } from 'vite'

/**
 * The production build, which decides its own NODE_ENV.
 *
 * The admin reads the installation's `.env` for `VITE_API_URL`, and that file
 * also carries `NODE_ENV=development` — correct for the API, which loads it as
 * its process environment. Vite reads NODE_ENV out of env files too, so the
 * build inherited it: measured, 271 modules and 643.01 kB (190.22 kB gzip)
 * carrying React's development build — the DevTools notice, the warnings, the
 * checks — with a chunk-size warning on top, and an exit code of 0 throughout.
 * The real thing is 265 modules and 405.86 kB (124.31 kB gzip).
 *
 * It cannot be fixed inside vite.config.ts. Vite decides whether the process
 * already has a NODE_ENV before it loads the config file — `isNodeEnvSet` is
 * read at the top of resolveConfig, the config is loaded a few lines later —
 * so anything the config sets arrives after that question was answered, and
 * the env file wins. Measured that way too: the same 643.01 kB.
 *
 * So it is set here, before Vite starts. `??=` and not `=`: an explicit
 * NODE_ENV from CI or a container still decides, which is what makes this a
 * default rather than an override. What can no longer happen is a build taking
 * its mode from a file about something else.
 */
process.env.NODE_ENV ??= 'production'

/** Only for the regression guard, which builds somewhere it can inspect. */
const [outDir] = process.argv.slice(2)

await build(outDir ? { build: { outDir, emptyOutDir: true } } : {})
