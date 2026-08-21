import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
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

let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
const started: { app: FastifyInstance; namespace: string }[] = []

/** A server whose module graph was loaded with this environment. */
async function serverWith(mediaBaseUrl: string): Promise<FastifyInstance> {
  vi.resetModules()
  vi.stubEnv('MEDIA_BASE_URL', mediaBaseUrl)

  const namespace = testRateLimitNamespace(`delivery-${started.length}`)
  const { buildApp } = await import('../app.ts')
  const app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
  await app.ready()
  started.push({ app, namespace })
  return app
}

describe.skipIf(!ready)('media delivery in the health verdict', () => {
  beforeAll(async () => {
    scratch = await createScratchDatabase('delivery')
  }, 60_000)

  afterEach(async () => {
    for (const { app, namespace } of started.splice(0)) {
      await app.close()
      await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
    }
    vi.unstubAllEnvs()
    vi.resetModules()
  })

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
