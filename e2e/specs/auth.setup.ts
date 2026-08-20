import { expect, test as setup } from '@playwright/test'
import { E2E_ADMIN, SESSION_STATE } from '../scripts/database.ts'

/**
 * Signs in once, and lends the session to every test that follows.
 *
 * Not a convenience. The API limits sign-in attempts to ten in fifteen
 * minutes, per address, which is a rule worth keeping and one a suite that
 * signs in per test walks straight into: six tests, two runs, and the third
 * run is answered 429 by a server doing exactly what it should. Playwright's
 * storage state carries the session cookie, so the browser arrives already
 * signed in and the rule stays where it belongs.
 */
setup('sign in', async ({ page }) => {
  await page.goto('/')
  await page.getByLabel(/email/i).fill(E2E_ADMIN.email)
  await page.getByLabel(/password/i).fill(E2E_ADMIN.password)
  await page.getByRole('button', { name: /sign in/i }).click()

  await expect(page.getByRole('link', { name: /dashboard/i })).toBeVisible()

  await page.context().storageState({ path: SESSION_STATE })
})
