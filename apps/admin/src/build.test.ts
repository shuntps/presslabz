import { execFileSync } from 'node:child_process'
import { readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/*
 * What `pnpm build` actually emits.
 *
 * The build reads the installation's shared .env for VITE_API_URL, and that
 * file also carries NODE_ENV=development for the API. Vite reads NODE_ENV from
 * env files, so the production build quietly became a development one: 271
 * modules and 643.01 kB (190.22 kB gzip) with React's development build inside
 * — its DevTools notice, its warnings, its checks — against 265 modules and
 * 405.86 kB (124.31 kB gzip) for the real thing. Exit code 0 either way, which
 * is what made it reportable as a clean build.
 *
 * So this runs the real build script, the same one `pnpm build` runs, with no
 * NODE_ENV in its environment — the state a plain shell and a CI runner are
 * both in — and reads what came out.
 */

const OUT_DIR = 'dist/build-guard'
let bundle = ''

beforeAll(() => {
  const env = { ...process.env }
  // Vitest sets NODE_ENV=test. A build run by hand has nothing, which is the
  // case that broke, so that is the case this reproduces.
  delete env.NODE_ENV

  execFileSync(process.execPath, ['scripts/build.ts', OUT_DIR], {
    env,
    stdio: 'pipe',
    timeout: 120_000,
  })

  const assets = join(OUT_DIR, 'assets')
  bundle = readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(assets, name), 'utf8'))
    .join('\n')

  expect(bundle.length).toBeGreaterThan(0)
}, 180_000)

afterAll(() => {
  rmSync(OUT_DIR, { recursive: true, force: true })
})

describe('the production build', () => {
  it("ships React's production build, not its development one", () => {
    // The notice exists only in the development build, and is what was found
    // in the bundle that shipped.
    expect(bundle).not.toContain('Download the React DevTools')
    // Minified errors point at react.dev instead of carrying their text: the
    // production build of react-dom, asserted positively so that a bundle
    // missing React altogether could not pass by saying nothing.
    expect(bundle).toContain('react.dev/errors')
  })

  it('carries no secret from the shared environment file', () => {
    /*
     * Only VITE_-prefixed variables are exposed to the client, which is Vite's
     * rule; this is that rule held to on the artifact. The values below are
     * the ones .env.example puts in the same file the build now reads.
     */
    expect(bundle).not.toContain('presslabz-dev-secret')
    expect(bundle).not.toContain('postgres://')
    expect(bundle).not.toContain('S3_SECRET_ACCESS_KEY')
    expect(bundle).not.toContain('SEED_ADMIN_PASSWORD')
  })
})
