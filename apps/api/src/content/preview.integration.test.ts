import { previewLinkSchema, type Role } from '@presslabz/core'
import { createDb, createSession, createUser, type Database } from '@presslabz/db'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { generateSessionToken, hashSessionToken } from '../auth/session.ts'
import {
  closeThenRestore,
  dropRateLimitKeys,
  testRateLimitNamespace,
  withCleanup,
} from '../testing.ts'

/*
 * An installation that cannot issue preview links.
 *
 * Its own file because `env.ts` parses `process.env` once, when it is first
 * imported, and every other suite sets a preview secret before importing the
 * app — so the branch that answers 503 is unreachable from them. Vitest gives
 * each file its own module registry, which is what makes an installation
 * configured differently something a test can actually stand up.
 *
 * The variables are stubbed rather than assigned: `hasIntegrationEnv` loads
 * the repository's .env to find the database, whatever it happens to contain
 * must not decide what this suite is testing, and a direct assignment is not
 * something Vitest can put back — `vi.unstubAllEnvs` restores exactly what was
 * there before, whichever path the test took out.
 */
const ready = hasIntegrationEnv()

const uniqueSlug = (name: string) => `pv-${name}-${Math.floor(Math.random() * 1e9)}`

describe.skipIf(!ready)('an installation with no preview configuration', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let namespace: string
  let app: FastifyInstance
  let cookieName: string
  const cookies: Record<string, string> = {}

  async function signIn(role: Role, email: string) {
    const user = await createUser(db, { email, displayName: role, role, passwordHash: null })
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookies[role] = token
  }

  const as = (role: string) => ({ [cookieName]: cookies[role] as string })

  beforeAll(async () => {
    scratch = await createScratchDatabase('preview-unconfigured')
    namespace = testRateLimitNamespace('preview-unconfigured')

    // The whole point of this suite: an installation that was never told how
    // to sign a preview, and never told where its public site lives.
    vi.stubEnv('PREVIEW_SECRET', undefined)
    vi.stubEnv('SITE_URL', undefined)

    const [{ buildApp }, { SESSION_COOKIE }] = await Promise.all([
      import('../app.ts'),
      import('../auth/session.ts'),
    ])
    cookieName = SESSION_COOKIE

    app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
    await app.ready()

    handle = createDb(scratch.url, { maxConnections: 3 })
    db = handle.db

    await signIn('editor', 'pv-editor@presslabz.test')
    await signIn('subscriber', 'pv-subscriber@presslabz.test')
  }, 60_000)

  /*
   * One hook, because two would run in the wrong order: Vitest's default is
   * `stack`, so the hook declared second runs first — the environment would go
   * back before anything had closed. `closeThenRestore` states the order
   * instead of leaving it to declaration.
   */
  afterAll(
    () =>
      closeThenRestore(
        [
          () => handle?.close(),
          () => app?.close(),
          () => scratch?.drop(),
          () => dropRateLimitKeys(process.env.VALKEY_URL as string, namespace),
        ],
        () => vi.unstubAllEnvs(),
      ),
    SCRATCH_TEARDOWN_TIMEOUT_MS,
  )

  const preview = (role: string, id: string) =>
    app.inject({ method: 'POST', url: `/content/post/${id}/preview`, cookies: as(role) })

  it('answers 503 with the configuration reason rather than a link', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: as('editor'),
      payload: { locale: 'en', slug: uniqueSlug('unconfigured'), title: 'A document' },
    })
    expect(created.statusCode).toBe(201)

    const response = await preview('editor', created.json().content.id as string)

    expect(response.statusCode).toBe(503)
    expect(response.json()).toEqual({
      error: 'preview_unavailable',
      reason: 'no-preview-configuration',
    })
    // Nothing that could be mistaken for a link, and no hint of a secret.
    expect(JSON.stringify(response.json())).not.toMatch(/http|token|secret/i)
  })

  /*
   * The answer comes before the document is looked up and before the actor is
   * authorized, so an unconfigured installation says the same thing to every
   * caller. What that order reveals is the installation's preview
   * configuration state, and nothing about whether the requested document
   * exists or was readable — which is also why the interface must never read a
   * 503 as proof of either.
   */
  it('says the same thing for a document that does not exist', async () => {
    const response = await preview('editor', '00000000-0000-4000-8000-000000000000')

    expect(response.statusCode).toBe(503)
    expect(response.json().reason).toBe('no-preview-configuration')
  })

  it('says the same thing to somebody who could not read the document', async () => {
    const own = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: as('editor'),
      payload: { locale: 'en', slug: uniqueSlug('closed'), title: 'A draft' },
    })

    const response = await preview('subscriber', own.json().content.id as string)

    // 503, not 403: the configuration check runs first, deliberately.
    expect(response.statusCode).toBe(503)
    expect(response.json().reason).toBe('no-preview-configuration')
  })

  it('still refuses when the secret exists but the site address does not', async () => {
    /*
     * The other half of the same condition, and the reason this suite does not
     * simply say "no secret": an installation that can sign a token but has
     * nowhere to point it cannot produce a link either. A fresh module
     * registry is what lets one file hold two configurations.
     */
    vi.resetModules()
    vi.stubEnv('PREVIEW_SECRET', 'y'.repeat(48))
    vi.stubEnv('SITE_URL', undefined)

    /*
     * Taken once and kept. `testRateLimitNamespace` mints a fresh id on every
     * call, so asking for it again at teardown would clean a namespace this
     * app never used and leave its own keys behind in a shared Valkey.
     */
    const halfNamespace = testRateLimitNamespace('preview-half')

    const { buildApp } = await import('../app.ts')
    const halfConfigured = await buildApp({
      databaseUrl: scratch.url,
      rateLimitNamespace: halfNamespace,
    })

    /*
     * The protection starts the moment the instance exists, `ready()`
     * included: a failure there would otherwise leave an app nobody closed and
     * a namespace nobody swept. Both cleanup steps are attempted even if one
     * throws, and the environment goes back last — a plain `finally` closing
     * in sequence would skip everything after a `close()` that failed.
     */
    await withCleanup(
      async () => {
        await halfConfigured.ready()

        const created = await halfConfigured.inject({
          method: 'POST',
          url: '/content/post',
          cookies: as('editor'),
          payload: { locale: 'en', slug: uniqueSlug('half'), title: 'A document' },
        })

        const response = await halfConfigured.inject({
          method: 'POST',
          url: `/content/post/${created.json().content.id}/preview`,
          cookies: as('editor'),
        })

        expect(response.statusCode).toBe(503)
        expect(response.json().reason).toBe('no-preview-configuration')
      },
      [
        () => halfConfigured.close(),
        () => dropRateLimitKeys(process.env.VALKEY_URL as string, halfNamespace),
      ],
      /*
       * Back to what the surrounding suite stubbed, not `unstubAllEnvs`: that
       * would also drop the SITE_URL stub this whole describe depends on.
       * Only what this second application changed is put back.
       */
      () => vi.stubEnv('PREVIEW_SECRET', undefined),
    )

    /*
     * Nothing of this app's is left under its own prefix. Asked of Valkey
     * rather than of the limiter: a second sweep of the same namespace finds
     * nothing to remove, which says the first one cleaned the namespace that
     * was actually used without this test knowing how a counter is stored.
     */
    expect(await dropRateLimitKeys(process.env.VALKEY_URL as string, halfNamespace)).toBe(0)
  })
})

/** A configured installation, so the response can be checked against the contract. */
describe.skipIf(!ready)('an installation that can issue preview links', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let namespace: string
  let app: FastifyInstance
  let cookieName: string
  let cookie: string

  beforeAll(async () => {
    scratch = await createScratchDatabase('preview-configured')
    namespace = testRateLimitNamespace('preview-configured')

    vi.resetModules()
    vi.stubEnv('PREVIEW_SECRET', 'z'.repeat(48))
    vi.stubEnv('SITE_URL', 'https://exemple.test')

    const [{ buildApp }, { SESSION_COOKIE }] = await Promise.all([
      import('../app.ts'),
      import('../auth/session.ts'),
    ])
    cookieName = SESSION_COOKIE

    app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
    await app.ready()

    handle = createDb(scratch.url, { maxConnections: 3 })
    db = handle.db

    const user = await createUser(db, {
      email: 'pv-configured@presslabz.test',
      displayName: 'editor',
      role: 'editor',
      passwordHash: null,
    })
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), user.id, new Date(Date.now() + 3_600_000))
    cookie = token
  }, 60_000)

  afterAll(
    () =>
      closeThenRestore(
        [
          () => handle?.close(),
          () => app?.close(),
          () => scratch?.drop(),
          () => dropRateLimitKeys(process.env.VALKEY_URL as string, namespace),
        ],
        () => vi.unstubAllEnvs(),
      ),
    SCRATCH_TEARDOWN_TIMEOUT_MS,
  )

  it('answers a body the shared contract accepts', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/content/post',
      cookies: { [cookieName]: cookie },
      payload: { locale: 'en', slug: uniqueSlug('contracted'), title: 'A document' },
    })

    const response = await app.inject({
      method: 'POST',
      url: `/content/post/${created.json().content.id}/preview`,
      cookies: { [cookieName]: cookie },
    })

    expect(response.statusCode).toBe(200)

    // The contract the admin parses this with, applied to what the route
    // actually sends — so a drift fails here rather than in the interface.
    const { preview } = previewLinkSchema.parse(response.json())
    expect(preview.url.startsWith('https://exemple.test/en/preview/')).toBe(true)
    expect(Number.isNaN(Date.parse(preview.expiresAt))).toBe(false)
  })
})
