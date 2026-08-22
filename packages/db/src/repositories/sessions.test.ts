import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '../testing.ts'
import { createSession, deleteExpiredSessions, findValidSession } from './sessions.ts'
import { countUsers, createInitialAdministrator, createUser } from './users.ts'

/*
 * On a scratch database, because both properties here are about a system with
 * nothing in it: a sweep has to leave the live rows alone, and bootstrap
 * cannot be raced on a table that already has users — it correctly refuses
 * before the race being tested can happen.
 */
const ready = hasIntegrationEnv()

describe.skipIf(!ready)('session and bootstrap safety', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    scratch = await createScratchDatabase('sessions')
    handle = createDb(scratch.url, { maxConnections: 10 })
    db = handle.db
  }, 60_000)

  afterAll(async () => {
    await handle.close()
    await scratch.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  describe('sweeping expired sessions', () => {
    it('removes what has expired and keeps what has not', async () => {
      const user = await createUser(db, {
        email: 'sweeper@presslabz.test',
        displayName: 'Sweeper',
        role: 'administrator',
        passwordHash: null,
      })

      const hour = 60 * 60 * 1000
      await createSession(db, 'live-token-hash', user.id, new Date(Date.now() + hour))
      await createSession(db, 'dead-token-hash', user.id, new Date(Date.now() - hour))

      const removed = await deleteExpiredSessions(db)

      expect(removed).toBe(1)
      expect(await findValidSession(db, 'live-token-hash')).not.toBeNull()
      expect(await findValidSession(db, 'dead-token-hash')).toBeNull()
    })

    it('is safe to run when there is nothing to remove', async () => {
      // It runs hourly on every instance, so the common case is a no-op and it
      // must not be one that errors or reports work it did not do.
      expect(await deleteExpiredSessions(db)).toBe(0)
    })
  })

  describe('bootstrapping the first administrator', () => {
    /** Its own database, so the users table genuinely starts empty. */
    let bootstrap: Awaited<ReturnType<typeof createScratchDatabase>>
    let bootstrapHandle: ReturnType<typeof createDb>
    let bootstrapDb: Database

    beforeAll(async () => {
      bootstrap = await createScratchDatabase('bootstrap')
      // Enough connections that the concurrent calls below really do overlap
      // rather than queueing on the pool and passing for the wrong reason.
      bootstrapHandle = createDb(bootstrap.url, { maxConnections: 10 })
      bootstrapDb = bootstrapHandle.db
    }, 60_000)

    afterAll(async () => {
      await bootstrapHandle.close()
      await bootstrap.drop()
    }, SCRATCH_TEARDOWN_TIMEOUT_MS)

    it('creates at most one when several processes start together', async () => {
      const attempts = Array.from({ length: 5 }, (_, index) =>
        createInitialAdministrator(bootstrapDb, {
          email: `first-${index}@presslabz.test`,
          displayName: `First ${index}`,
          passwordHash: null,
        }),
      )

      const results = await Promise.all(attempts)
      const created = results.filter((result) => result.created !== null)

      // Without the advisory lock every one of these reads an empty table
      // before any of them commits, and a fresh installation gets five
      // administrators nobody asked for.
      expect(created).toHaveLength(1)
      expect(await countUsers(bootstrapDb)).toBe(1)
    })

    it('refuses once anybody exists, so the seed cannot be a way back in', async () => {
      // The environment variables may well still be set after installation.
      // Running the seed again must not add a privileged account.
      const result = await createInitialAdministrator(bootstrapDb, {
        email: 'second@presslabz.test',
        displayName: 'Second',
        passwordHash: null,
      })

      expect(result.created).toBeNull()
      expect(result.existing).toBe(1)
      expect(await countUsers(bootstrapDb)).toBe(1)
    })
  })
})
