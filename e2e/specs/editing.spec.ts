import { expect, type Page, test } from '@playwright/test'

/**
 * The editor, in a real browser, against a real API and a real database.
 *
 * These exist for one class of fault: the kind that needs a router, a
 * component that stays mounted, and a request that goes somewhere. The jsdom
 * suites assert the same behaviours and would have caught this one — but the
 * mechanism is TanStack Router's own, and a test of the mechanism is worth
 * running against the mechanism.
 *
 * The fixtures come from `pnpm seed:demo`: "Hello world" in English and
 * "Bonjour le monde" in French, one translation group, which is precisely the
 * navigation that used to lose somebody's work.
 *
 * One database serves the whole file, so a test that saves must not save onto
 * a document another test reads. Each one that writes takes a document of its
 * own, named here rather than chosen at the point of use.
 */

/** Documents from the demo seed, one per test that changes something. */
const FIXTURES = {
  pair: { english: 'Hello world', french: 'Bonjour le monde' },
  renamed: 'The second post',
  untouched: 'Still a draft',
} as const

/** Opens a document from the listing by its title. */
async function openDocument(page: Page, title: string) {
  await page.goto('/content/post')
  await page.getByRole('link', { name: title, exact: true }).click()
  await expect(page.getByPlaceholder(/^title$/i)).toHaveValue(title)
}

test.describe('moving between two translations', () => {
  /*
   * The fault, exactly as it was: the router keeps the route component mounted
   * when only `$id` changes, so the draft stayed seeded from the document that
   * was open first while the save mutation had already followed the URL to the
   * other one. Pressing save wrote the English post over the French one, under
   * a title bar that had said "Bonjour le monde" the whole time.
   */
  test('shows the document that was opened, not the one before it', async ({ page }) => {
    await openDocument(page, FIXTURES.pair.english)

    await page.getByRole('link', { name: FIXTURES.pair.french }).click()

    await expect(page.getByPlaceholder(/^title$/i)).toHaveValue('Bonjour le monde')
    await expect(page.getByLabel(/slug/i)).toHaveValue('bonjour-le-monde')
  })

  test('saves onto the document it is showing', async ({ page }) => {
    await openDocument(page, FIXTURES.pair.english)
    await page.getByRole('link', { name: FIXTURES.pair.french }).click()
    await expect(page.getByPlaceholder(/^title$/i)).toHaveValue('Bonjour le monde')

    const request = page.waitForRequest(
      (candidate) => candidate.method() === 'PATCH' && candidate.url().includes('/content/post/'),
    )
    await page.getByRole('button', { name: /^save$/i }).click()
    const sent = JSON.parse((await request).postData() ?? '{}')

    expect(sent.title).toBe('Bonjour le monde')
    expect(sent.slug).toBe('bonjour-le-monde')

    // And the English document is still the English document, which is the
    // claim that actually matters: a title bar can lie, a reload cannot.
    await openDocument(page, FIXTURES.pair.english)
    await expect(page.getByLabel(/slug/i)).toHaveValue('hello-world')
  })
})

test.describe('leaving a document with unsaved work', () => {
  test('asks before letting it go', async ({ page }) => {
    await openDocument(page, FIXTURES.pair.english)
    await page.getByPlaceholder(/^title$/i).fill('Hello world, edited')

    await page.getByRole('link', { name: /dashboard/i }).click()

    const dialog = page.getByRole('dialog')
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText(/have not saved/i)
    // Held, not finished: the editor is still on screen behind the dialog.
    await expect(page.getByPlaceholder(/^title$/i)).toHaveValue('Hello world, edited')
  })

  test('stays when asked to stay', async ({ page }) => {
    await openDocument(page, FIXTURES.pair.english)
    await page.getByPlaceholder(/^title$/i).fill('Hello world, edited')
    await page.getByRole('link', { name: /dashboard/i }).click()

    await page.getByRole('button', { name: /stay here/i }).click()

    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.getByPlaceholder(/^title$/i)).toHaveValue('Hello world, edited')
  })

  test('saves and then leaves, when asked for both', async ({ page }) => {
    await openDocument(page, FIXTURES.renamed)
    await page.getByPlaceholder(/^title$/i).fill('Saved on the way out')
    await page.getByRole('link', { name: /dashboard/i }).click()

    await page.getByRole('button', { name: /save, then leave/i }).click()

    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()

    // Written, not merely promised: read back from the server.
    await page.goto('/content/post')
    await expect(page.getByRole('link', { name: 'Saved on the way out' })).toBeVisible()
  })

  test('lets go of a document nobody changed', async ({ page }) => {
    await openDocument(page, FIXTURES.untouched)

    await page.getByRole('link', { name: /dashboard/i }).click()

    await expect(page.getByRole('heading', { name: /dashboard/i })).toBeVisible()
    await expect(page.getByRole('dialog')).toBeHidden()
  })
})
