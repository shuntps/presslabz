import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Where the browser tests' own database is, and who signs in to it.
 *
 * Facts only — importing this starts nothing. `prepare.ts` builds the database
 * and `playwright.config.ts` points the servers at it, and both need to agree
 * about the name without one of them running the other.
 */

export const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))

// The same root .env every other part of this repository reads. Playwright
// does not load it, and CI sets the variables directly, so a missing file is
// not an error.
const envFile = `${REPOSITORY_ROOT}/.env`
if (existsSync(envFile)) process.loadEnvFile(envFile)

export const E2E_DATABASE = 'presslabz_e2e'

/**
 * The prefix this run's rate-limit counters carry, so they can be cleared with
 * it and cannot spend the development instance's allowance.
 */
export const E2E_RATE_LIMIT_NAMESPACE = 'presslabz:rl:e2e:'

/**
 * A bucket of its own, for the same reason the database is its own.
 *
 * These tests upload real images through the real pipeline, and the run's
 * database is dropped at the end — so every object they wrote into the shared
 * development bucket became a file no row anywhere referenced. "Leaves the
 * object store clean" is not something a suite can promise while writing into
 * somebody else's bucket.
 */
export const E2E_BUCKET = 'presslabz-e2e-media'

/**
 * Where the signed-in browser state is kept between the setup project and the
 * tests. Under the run's own directory, and ignored by git: it holds a session
 * cookie, which is a credential however throwaway the account is.
 */
export const SESSION_STATE = `${REPOSITORY_ROOT}/e2e/.auth/session.json`

/** Local, throwaway, and known to the specs: this account exists for one run. */
export const E2E_ADMIN = {
  email: 'e2e@presslabz.test',
  password: 'e2e-passphrase-not-a-secret',
  name: 'End To End',
}

/** The configured server, with a different database named on the end of it. */
export function databaseUrl(name: string): string {
  const base = process.env.DATABASE_URL
  if (!base) {
    throw new Error('DATABASE_URL is not set. Copy .env.example to .env at the repository root.')
  }

  const url = new URL(base)
  url.pathname = `/${name}`
  return url.toString()
}

export const E2E_DATABASE_URL = databaseUrl(E2E_DATABASE)
