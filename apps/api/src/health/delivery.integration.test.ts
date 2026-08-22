import {
  backendsOn,
  createScratchDatabase,
  databaseExists,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'

/**
 * `/health` against a real server, in the mode that used to be exempt from it.
 *
 * The delivery probe was skipped whenever `MEDIA_BASE_URL` was set, on the
 * reasoning that the base in front of the store is somebody else's to run.
 * What that produced was an instance answering 200 while every image on the
 * site returned 403 — the delivery base being somebody else's makes it more
 * worth checking, not less, because nothing else in this process would notice.
 *
 * Run through a fresh module registry rather than a child process: the mode is
 * read from the environment when storage.ts is first imported, so the whole
 * graph has to be re-imported for a different one. `app.inject` then exercises
 * the real route, with no port and no server socket.
 */
const ready = hasIntegrationEnv()

let scratch: Awaited<ReturnType<typeof createScratchDatabase>> | undefined
const started: { app: FastifyInstance; namespace: string }[] = []

/** A server whose module graph was loaded with this environment. */
async function serverWith(mediaBaseUrl: string): Promise<FastifyInstance> {
  vi.resetModules()
  vi.stubEnv('MEDIA_BASE_URL', mediaBaseUrl)

  const namespace = testRateLimitNamespace(`delivery-${started.length}`)
  const { buildApp } = await import('../app.ts')

  // Tests only run once beforeAll succeeded; the type is nullable for the
  // teardown, which must cope with a beforeAll that never got that far.
  if (!scratch) throw new Error('serverWith called before the scratch database exists')

  const app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
  /*
   * Tracked from the instant it exists, before ready() gets a chance to
   * throw. close() after a failed ready() resolves and runs the onClose
   * hooks — measured against the pinned Fastify, and pinned as a dependency
   * contract in http/fastify-close.contract.test.ts — and closing the
   * database pool is one of those hooks. An app tracked only after ready()
   * would leak its pool on the one path where cleanup matters most.
   */
  started.push({ app, namespace })
  await app.ready()
  return app
}

/**
 * Closes every tracked application and clears its rate-limit keys.
 *
 * An entry leaves the registry only once **both** of its responsibilities are
 * done; a failure keeps it tracked so the final teardown retries. Both
 * operations are idempotent — a second close() resolves and runs the onClose
 * hooks exactly once (measured), and deleting deleted keys deletes nothing —
 * so a retried entry costs nothing. Every failure is kept, none stops the
 * remaining entries or steps.
 */
async function closeStarted(failures: unknown[]): Promise<void> {
  for (const entry of [...started]) {
    let closed = false
    let cleared = false

    try {
      await entry.app.close()
      closed = true
    } catch (error) {
      failures.push(error)
    }
    // Attempted even when the close failed: the keys exist regardless.
    try {
      await dropRateLimitKeys(process.env.VALKEY_URL as string, entry.namespace)
      cleared = true
    } catch (error) {
      failures.push(error)
    }

    if (closed && cleared) started.splice(started.indexOf(entry), 1)
  }
}

/** One failure keeps its identity; several are all kept, none masking another. */
function rethrow(failures: unknown[]): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, `teardown failed ${failures.length} ways`)
  }
}

describe.skipIf(!ready)('media delivery in the health verdict', () => {
  beforeAll(async () => {
    scratch = await createScratchDatabase('delivery')
  }, 60_000)

  afterEach(async () => {
    const failures: unknown[] = []
    await closeStarted(failures)
    /*
     * Never skipped, whatever the closes did: a test running against the
     * previous test's stubbed environment or module registry fails about the
     * wrong thing.
     */
    try {
      vi.unstubAllEnvs()
    } catch (error) {
      failures.push(error)
    }
    try {
      vi.resetModules()
    } catch (error) {
      failures.push(error)
    }
    rethrow(failures)
  })

  /*
   * The teardown this suite shipped without — every run of this file left a
   * database behind, one hourly sweep away from being noticed (#46). Each
   * step is attempted regardless of the ones before it, and every failure is
   * reported.
   */
  afterAll(async () => {
    const failures: unknown[] = []

    // What a test that failed before its afterEach may have left behind.
    await closeStarted(failures)

    if (scratch) {
      /*
       * Zero backends by exact name, asserted before the drop: on the normal
       * path the applications and their pools are already closed, so the drop
       * never happens under a live pool. When a close above failed, this
       * assertion records it — and the drop below still runs, where FORCE is
       * the last-resort net that severs whatever backend survived. The drop
       * can therefore happen under a live pool; it is just never silent about
       * it.
       */
      try {
        expect(await backendsOn(scratch.name)).toBe(0)
      } catch (error) {
        failures.push(error)
      }
      try {
        await scratch.drop()
      } catch (error) {
        failures.push(error)
      }
      // The contract the architecture states: a suite leaves nothing behind.
      try {
        expect(await databaseExists(scratch.name)).toBe(false)
      } catch (error) {
        failures.push(error)
      }
    }

    rethrow(failures)
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /*
   * The exact false green. An external base that does not serve the check
   * object is a site with no images, and this used to answer 200.
   */
  it('is degraded when the external base does not serve media', async () => {
    const app = await serverWith(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}-not-a-bucket`)

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(503)
    expect(response.json().services.storage).toBe('degraded')
  })

  it('is up when the external base does serve it', async () => {
    const app = await serverWith(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}`)

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(response.statusCode).toBe(200)
    expect(response.json().services.storage).toBe('up')
  })

  /* Whatever the mode, the anonymous answer still names no cause. */
  it('still says nothing about why', async () => {
    const app = await serverWith(`${process.env.S3_ENDPOINT}/${process.env.S3_BUCKET}-not-a-bucket`)

    const response = await app.inject({ method: 'GET', url: '/health' })

    expect(Object.keys(response.json()).sort()).toEqual(['services', 'status'])
    expect(response.body).not.toMatch(/forbidden|missing|denied|policy|credential/i)
  })
})
