import { AxeBuilder } from '@axe-core/playwright'
import { expect, type Page, test } from '@playwright/test'

/**
 * An audit of the real pages, and a keyboard walking the paths that matter.
 *
 * axe finds a specific class of fault very well — a control with no accessible
 * name, a contrast ratio below the minimum, a landmark used wrongly — and
 * finds nothing at all about whether the interface can be *operated*. So both:
 * the scan, on every screen somebody actually works in, and a keyboard-only
 * walk through composing and saving a document.
 *
 * Scoped to WCAG 2.2 AA, which is the standard the project states.
 */
const STANDARD = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

async function audit(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(STANDARD).analyze()

  return results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    where: violation.nodes.map((node) => node.target.join(' ')).slice(0, 4),
  }))
}

test.describe('every screen, scanned', () => {
  test('the sign-in screen', async ({ browser }) => {
    // Signed out, which is a different page and its own set of controls.
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } })
    const page = await context.newPage()
    await page.goto('/')
    await page.getByLabel(/email/i).waitFor()

    expect(await audit(page)).toEqual([])

    await context.close()
  })

  test('the dashboard', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('heading', { name: /dashboard/i }).waitFor()

    expect(await audit(page)).toEqual([])
  })

  test('a listing', async ({ page }) => {
    await page.goto('/content/post')
    await page.locator('a.title-link').first().waitFor()

    expect(await audit(page)).toEqual([])
  })

  test('the editor, with a document open', async ({ page }) => {
    await page.goto('/content/post')
    await page.getByRole('link', { name: 'Hello world', exact: true }).click()
    await expect(page.getByPlaceholder(/^title$/i)).toHaveValue('Hello world')

    expect(await audit(page)).toEqual([])
  })

  /*
   * The picker is where the names come from user-written alt text, which is
   * often not written: every undescribed asset used to be a button with no
   * accessible name at all.
   */
  test('the media picker, holding images nobody described', async ({ page }) => {
    await page.goto('/content/post/new')
    await page.getByRole('button', { name: /^image$/i }).click()
    await page.locator('.picker-asset').first().waitFor()

    expect(await audit(page)).toEqual([])
  })
})

test.describe('with a keyboard only', () => {
  /*
   * Not "does it have a tabindex" — whether a person who never touches the
   * pointer can do the work. Composing and saving is the whole product.
   */
  test('writes a document and saves it', async ({ page }) => {
    await page.goto('/content/post/new')
    await page.getByLabel(/document title/i).waitFor()

    // Into the title, by tabbing from the top of the document.
    await page.keyboard.press('Tab')
    for (let guard = 0; guard < 40; guard += 1) {
      const focused = await page.evaluate(() => document.activeElement?.id ?? '')
      if (focused === 'document-title') break
      await page.keyboard.press('Tab')
    }

    await expect(page.locator('#document-title')).toBeFocused()
    await page.keyboard.type('Written without a pointer')

    // The block palette is reachable and its buttons answer to Enter.
    await page.getByRole('button', { name: /^paragraph$/i }).focus()
    await page.keyboard.press('Enter')
    await expect(page.getByLabel(/^paragraph$/i)).toHaveCount(1)
    await page.getByLabel(/^paragraph$/i).focus()
    await page.keyboard.type('A paragraph, typed.')

    await page.getByRole('button', { name: /^save$/i }).focus()
    await page.keyboard.press('Enter')

    // Saved means the server took it: the editor moves to the document's URL.
    await expect(page).toHaveURL(/\/content\/post\/[0-9a-f-]{36}$/)
  })

  /*
   * A dialog that traps focus is the platform's job, and using a native
   * <dialog> is how that was bought — which is only true if it is opened the
   * way the platform expects. Escape closing it is part of the same bargain.
   */
  test('opens and dismisses the image picker', async ({ page }) => {
    await page.goto('/content/post/new')
    await page.getByRole('button', { name: /^image$/i }).focus()
    await page.keyboard.press('Enter')

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()

    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })
})
