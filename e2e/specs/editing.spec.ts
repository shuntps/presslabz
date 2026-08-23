import { expect, type Page, type Route, test } from '@playwright/test'

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

/*
 * The one thing jsdom cannot answer about the history panel.
 *
 * A restore replaces the open draft, so a restore hidden behind a closed
 * dialog would rewrite somebody's screen out of sight. The panel answers that
 * with `closedby="none"` while the request is in flight — the platform's own
 * boundary, under which no user action closes the dialog at all — and jsdom
 * can only be asked whether the attribute is written. Whether the *browser*
 * then refuses the close is the browser's behaviour, and the close-watcher
 * rules are exactly where a second rapid Escape would otherwise win: the
 * `cancel` guard alone is documented not to survive it. So this presses the
 * real key, twice, against a real engine, while a real request hangs.
 */
test.describe('a restore that has not answered yet', () => {
  const RESTORE_ROUTE = '**/revisions/*/restore'

  test('cannot be dismissed until it settles, and dismisses normally after', async ({ page }) => {
    // Its own document, saved twice: the second save archives the first state,
    // which is the revision this test restores.
    await page.goto('/content/post/new')
    await page.getByLabel(/document title/i).fill('Held restore')
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(page).toHaveURL(/\/content\/post\/[0-9a-f-]{36}$/)

    await page.getByLabel(/document title/i).fill('Held restore, revised')
    await page.getByRole('button', { name: /^save$/i }).click()
    await expect(page.getByText('Saved', { exact: true })).toBeVisible()

    /*
     * The restore is held open in the network layer rather than delayed by a
     * timer: the request genuinely does not answer until this test says so,
     * which is what makes every assertion below about a real pending write.
     *
     * `handling` is the handler's own promise, so the cleanup can wait for a
     * handler that has already started before removing it — `unroute` does not
     * wait on its own, and a handler still parked on a route is a request
     * nobody ever answers.
     */
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let handling: Promise<unknown> = Promise.resolve()
    const holdRestore = async (route: Route) => {
      handling = held.then(() => route.continue())
      await handling
    }
    await page.route(RESTORE_ROUTE, holdRestore)

    /*
     * The body's outcome is recorded rather than propagated, so the cleanup
     * below always runs and its own failures stay visible. A `finally` with
     * swallowed errors would hide a broken teardown on a green run; a
     * `finally` that throws would replace the assertion error with it.
     */
    let bodyError: unknown
    let bodyThrew = false
    try {
      const opener = page.getByRole('button', { name: /^history$/i })
      await opener.click()
      const dialog = page.getByRole('dialog')
      await expect(dialog).toBeVisible()
      await expect(dialog).not.toHaveAttribute('closedby')

      await dialog.getByRole('button', { name: /version 1/i }).click()
      await dialog.getByRole('button', { name: /^restore$/i }).click()
      await dialog.getByRole('button', { name: /^restore$/i }).click()

      // In flight: the boundary is declared, and the request really is hanging.
      await expect(dialog.getByRole('button', { name: /restoring/i })).toBeVisible()
      await expect(dialog).toHaveAttribute('closedby', 'none')

      // Twice, because one prevented `cancel` is not the guarantee — the
      // second rapid close request is the one close-watcher rules would let
      // win, and measurably does when the attribute is taken away.
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      await expect(dialog).toBeVisible()
      await expect(dialog.getByRole('button', { name: /restoring/i })).toBeVisible()
      /*
       * And the document behind it is frozen, so there is nothing to lose. The
       * assertion is on the field somebody would type into rather than on the
       * fieldset that disables it: a disabled fieldset closes its descendants,
       * and the descendant is what a person meets.
       */
      await expect(page.getByLabel(/document title/i)).toBeDisabled()

      release()

      // Settled: the restore landed, the boundary is withdrawn, and the draft
      // carries the restored state.
      await expect(dialog.getByText(/version 1 restored/i)).toBeVisible()
      await expect(dialog).not.toHaveAttribute('closedby')
      await expect(page.getByLabel(/document title/i)).toHaveValue('Held restore')

      // Escape works again, and hands the keyboard back to the opener.
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(opener).toBeFocused()
    } catch (error) {
      bodyError = error
      bodyThrew = true
    }

    /*
     * Every step is attempted even when an earlier one fails, and each
     * failure is kept rather than dropped: a request parked on a promise
     * nobody resolves outlives the test, and so does a handler nobody
     * removed.
     */
    const cleanupErrors: unknown[] = []
    for (const step of [
      // First, because everything else waits on it.
      async () => release(),
      // A handler that has already started must finish with its route before
      // the handler is removed; `unroute` does not wait on its own.
      async () => {
        await handling
      },
      // This test's handler by name, never every route the page may hold.
      async () => {
        await page.unroute(RESTORE_ROUTE, holdRestore)
      },
    ]) {
      try {
        await step()
      } catch (error) {
        cleanupErrors.push(error)
      }
    }

    /*
     * The body's error is the one worth reading, so it stays primary — first
     * in the aggregate when the cleanup failed as well. A cleanup that fails
     * on its own is the whole failure: a teardown nobody sees is a leak that
     * ships. `bodyThrew` rather than a check on the value, because a thrown
     * `undefined` is a failure too.
     */
    if (bodyThrew && cleanupErrors.length > 0) {
      throw new AggregateError(
        [bodyError, ...cleanupErrors],
        'the test failed, and so did its cleanup',
      )
    }
    if (bodyThrew) throw bodyError
    if (cleanupErrors.length === 1) throw cleanupErrors[0]
    if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, 'the cleanup failed')
  })
})
