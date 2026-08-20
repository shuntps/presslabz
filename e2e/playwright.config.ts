import { defineConfig, devices } from '@playwright/test'
import { E2E_DATABASE_URL, E2E_RATE_LIMIT_NAMESPACE, SESSION_STATE } from './scripts/database.ts'

/**
 * The two servers, against the database `scripts/prepare.ts` just rebuilt.
 *
 * Ports of their own, deliberately not 3000 and 5173: somebody's `pnpm dev` is
 * usually running, and a suite that takes their ports — or worse, quietly
 * tests their server against a database it did not build — is a suite that
 * reports on the wrong system.
 *
 * `reuseExistingServer` is off for the same reason. If something is already
 * listening on these ports, that is a fact worth failing over rather than
 * working around.
 */
const API_PORT = 3100
const ADMIN_PORT = 5273

const API_URL = `http://localhost:${API_PORT}`
const ADMIN_URL = `http://localhost:${ADMIN_PORT}`

/**
 * One hostname end to end. The session cookie is host-only and `SameSite=Lax`,
 * so `localhost` and `127.0.0.1` are two different sites and mixing them drops
 * the cookie with CORS perfectly satisfied — the rule the architecture states,
 * enforced here by using one name for both halves.
 */
const serverEnv = {
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: E2E_DATABASE_URL,
  API_PORT: String(API_PORT),
  API_HOST: '127.0.0.1',
  ADMIN_ORIGIN: ADMIN_URL,
  // Namespaced away from the development instance: Valkey is shared, and a
  // rate-limit counter or a cached page from a run is not this run's.
  RATE_LIMIT_NAMESPACE: E2E_RATE_LIMIT_NAMESPACE,
  PAGE_CACHE_NAMESPACE: 'presslabz:page:e2e:',
}

export default defineConfig({
  testDir: './specs',
  // A browser test that hangs is a build that hangs; these are seconds of
  // work on a laptop, and a CI runner starts two servers from cold.
  timeout: process.env.CI ? 120_000 : 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],

  use: {
    baseURL: ADMIN_URL,
    // Kept only for a failure: a passing run should leave nothing behind.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    // One sign-in per run, whose cookie every test below borrows.
    { name: 'setup', testMatch: /auth\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: SESSION_STATE },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      name: 'api',
      command: 'node src/index.ts',
      cwd: '../apps/api',
      url: `${API_URL}/health`,
      env: serverEnv,
      reuseExistingServer: false,
      // A passing run says nothing; a failing one gets the server's own
      // complaint, which is usually the answer.
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
    },
    {
      name: 'admin',
      command: `pnpm exec vite --port ${ADMIN_PORT} --strictPort`,
      cwd: '../apps/admin',
      url: ADMIN_URL,
      env: { ...serverEnv, VITE_API_URL: API_URL },
      reuseExistingServer: false,
      // A passing run says nothing; a failing one gets the server's own
      // complaint, which is usually the answer.
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
    },
  ],
})
