import fastify from 'fastify'
import { describe, expect, it } from 'vitest'

/*
 * A dependency contract, not a test of this codebase.
 *
 * Fastify's documentation promises that `close()` runs the `onClose` hooks.
 * The two behaviours below are narrower than that promise, and the text
 * consulted does not spell either of them out — they are **measured**
 * behaviours of the Fastify version this repository pins, held in place by
 * this test rather than by the documentation. Two teardown decisions
 * elsewhere lean on them:
 *
 * - `health/delivery.integration.test.ts` tracks an application before
 *   `ready()`, so an app whose boot failed is still closed — which only
 *   releases its database pool if `close()` runs the `onClose` hooks after a
 *   failed `ready()`.
 * - The same suite may close an application twice — once in `afterEach`, and
 *   again in `afterAll` when an earlier failure kept it tracked — which is
 *   only safe if a second `close()` resolves without running the hooks again.
 *
 * If a Fastify upgrade changes either answer, this file fails by name instead
 * of a teardown quietly leaking a pool. It builds bare instances on purpose:
 * what is under test is Fastify's lifecycle, never `buildApp`.
 */
describe('the Fastify lifecycle this repository depends on', () => {
  it('runs onClose hooks when close() follows a failed ready()', async () => {
    const app = fastify()
    let closed = false

    app.addHook('onClose', async () => {
      closed = true
    })
    app.register(async () => {
      throw new Error('a plugin that fails to boot')
    })

    await expect(app.ready()).rejects.toThrow('a plugin that fails to boot')
    // Resolving is the contract; a rejection here fails the test on its own.
    await app.close()
    expect(closed).toBe(true)
  })

  it('resolves a second close() and runs the hooks exactly once', async () => {
    const app = fastify()
    let hookRuns = 0

    app.addHook('onClose', async () => {
      hookRuns += 1
    })

    await app.ready()
    await app.close()
    await app.close()
    expect(hookRuns).toBe(1)
  })
})
