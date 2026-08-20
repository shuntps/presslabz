import { expect, test } from '@playwright/test'
import { SESSION_STATE } from '../scripts/database.ts'

/**
 * A browser that has never been here: no session, no preferences. Stated
 * rather than assumed, because a context created from this project inherits
 * the signed-in state the setup saved.
 */
const NOBODY = { cookies: [], origins: [] }

/**
 * The theme and the language, in the two places only a browser has: before the
 * application's own code runs, and on a second machine.
 *
 * Both are cookies so the page can honour them before anything is fetched. The
 * first paint is the whole reason — a page that renders light and then flips is
 * the flash every themed site gets wrong — and it is not observable in jsdom,
 * where nothing paints and the inline script in index.html is never the thing
 * under test.
 */

test.describe('before the application runs', () => {
  /*
   * The module graph is blocked, so React never boots. Whatever the document
   * looks like is the work of the inline script in the head, which is exactly
   * the claim: the theme is applied before first paint, not after hydration.
   */
  test('the theme is already applied with no application code at all', async ({ browser }) => {
    const context = await browser.newContext({ storageState: NOBODY })
    await context.addCookies([
      { name: 'presslabz-theme', value: 'dark', url: 'http://localhost:5273' },
    ])

    const page = await context.newPage()
    await page.route('**/src/main.tsx*', (route) => route.abort())
    await page.goto('/')

    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    // And nothing rendered, which is what makes the assertion above mean
    // something rather than describing React's work.
    await expect(page.locator('#root')).toBeEmpty()

    await context.close()
  })

  /*
   * A cookie value is a string anything on the host can write, and
   * `decodeURIComponent` throws on a malformed escape. The inline script has
   * its own try/catch, so the page was drawn and the interface died on top of
   * it: a blank screen, with the explanation in a console nobody had open.
   */
  test('an undecodable cookie cannot stop the interface', async ({ browser }) => {
    const context = await browser.newContext({ storageState: NOBODY })
    await context.addCookies([
      { name: 'presslabz-theme', value: '%E0%A4%A', url: 'http://localhost:5273' },
      { name: 'presslabz-locale', value: '%E0%A4%A', url: 'http://localhost:5273' },
    ])

    const page = await context.newPage()
    await page.goto('/')

    await expect(page.getByLabel(/email/i)).toBeVisible()

    // Repaired, so the next load does not start from the same broken value.
    const cookies = await context.cookies()
    expect(cookies.find((cookie) => cookie.name === 'presslabz-theme')?.value).toBe('system')

    await context.close()
  })
})

test.describe('a preference made on another machine', () => {
  /*
   * The theme used to reach the document through a path of its own that
   * touched neither the state nor the cookie: the page went dark while the
   * control still read "System", and the next load undid it. Two browser
   * contexts is the only honest way to state "another machine".
   */
  test('follows the person to it, and the control agrees', async ({ browser }) => {
    const first = await browser.newContext({ storageState: SESSION_STATE })
    const chooser = await first.newPage()
    await chooser.goto('/')
    await chooser.getByRole('button', { name: /^dark$/i }).click()
    // Written on the server, not only in this browser.
    await chooser.waitForResponse(
      (response) => response.url().includes('/auth/preferences') && response.status() === 200,
    )
    await first.close()

    const second = await browser.newContext({ storageState: SESSION_STATE })
    const arriving = await second.newPage()
    await arriving.goto('/')

    await expect(arriving.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(arriving.getByRole('button', { name: /^dark$/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    )

    // Put it back, so this test does not decide the theme for the next one.
    await arriving.getByRole('button', { name: /^system$/i }).click()
    await arriving.waitForResponse(
      (response) => response.url().includes('/auth/preferences') && response.status() === 200,
    )
    await second.close()
  })
})
