import {
  createDb,
  createMedia,
  type Database,
  deleteMedia,
  forgetOrphan,
  listOrphans,
  type MediaRow,
} from '@presslabz/db'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '@presslabz/db/testing'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The half of the media lifecycle that cannot be a transaction.
 *
 * The row lives in Postgres and the bytes in an object store, so one of them
 * is always written or removed first and something is left behind when the
 * other fails. That was survivable and invisible: a failed delete left bytes
 * nothing referenced, nothing listed, and nothing would ever try again.
 *
 * These run against a real database because the property being asserted is
 * that the record of the leak is written in the same transaction as the
 * deletion — which is exactly what a fake would not tell us. The object store
 * is injected, since what matters here is what happens when it refuses, and
 * arranging that against a real object store means breaking it.
 */
const ready = hasIntegrationEnv()

/**
 * Loaded in beforeAll rather than at the top of the file, and as a type here:
 * orphans.ts imports storage.ts, which imports env.ts, which validates and
 * throws at import time on an incomplete environment. A top-level import runs
 * before `hasIntegrationEnv()` has decided anything — before it has even had
 * the chance to load the repository's .env — so it turned "this suite is
 * skipped" and "this suite is configured" alike into "this file failed to
 * load". `pnpm test` failed on a machine with a perfectly valid .env.
 *
 * `typeof import(...)` is a type, so nothing here reaches the module until the
 * suite that needs it runs. Same reasoning, and the same shape, as the storage
 * module in routes.test.ts.
 */
let orphansModule: typeof import('./orphans.ts')

const log = { info: vi.fn(), warn: vi.fn() }

describe.skipIf(!ready)('objects with no row', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    orphansModule = await import('./orphans.ts')
    scratch = await createScratchDatabase('orphans')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /*
   * Each of these asserts on what the whole list contains, so a leftover from
   * the test before it would be read as this test's own leak. Cleared through
   * the same function the sweep uses rather than by truncating the table,
   * since that is the one a passing test is allowed to depend on.
   */
  beforeEach(async () => {
    for (const orphan of await listOrphans(db)) await forgetOrphan(db, orphan.storageKey)
  })

  afterEach(() => {
    log.info.mockClear()
    log.warn.mockClear()
  })

  /** A row naming two objects, the way an upload leaves one. */
  async function asset(name: string): Promise<MediaRow> {
    return createMedia(db, {
      storageKey: `media/${name}.avif`,
      mimeType: 'image/avif',
      byteSize: 10,
      width: 4,
      height: 4,
      alt: {},
      meta: {
        renditions: {
          avif: { key: `media/${name}.avif`, contentType: 'image/avif', byteSize: 10 },
          webp: { key: `media/${name}.webp`, contentType: 'image/webp', byteSize: 12 },
        },
      },
      uploadedById: null,
    })
  }

  const keysOf = async () => (await listOrphans(db)).map((orphan) => orphan.storageKey).sort()

  it('lists every object a deleted row owned', async () => {
    const row = await asset('listed')

    await deleteMedia(db, row.id)

    expect(await keysOf()).toEqual(['media/listed.avif', 'media/listed.webp'])
  })

  it('forgets them once the store has actually removed them', async () => {
    const row = await asset('removed')
    await deleteMedia(db, row.id)

    const removed = await orphansModule.sweepOrphans(db, log, async () => {})

    expect(removed).toBe(2)
    expect(await keysOf()).toEqual([])
  })

  /*
   * The point of writing the record at all: a store that refuses keeps the
   * bytes listed, so the next pass tries again rather than the leak becoming
   * permanent and unseen.
   */
  it('keeps them, and says why, when the store refuses', async () => {
    const row = await asset('stubborn')
    await deleteMedia(db, row.id)

    const removed = await orphansModule.sweepOrphans(db, log, async () => {
      throw new Error('the bucket is unreachable')
    })

    expect(removed).toBe(0)

    const orphans = await listOrphans(db)
    expect(orphans).toHaveLength(2)
    expect(orphans[0]?.attempts).toBe(1)
    expect(orphans[0]?.lastError).toContain('unreachable')
  })

  it('tries again on the next pass, and counts the attempts', async () => {
    const row = await asset('retried')
    await deleteMedia(db, row.id)

    const failing = async () => {
      throw new Error('still unreachable')
    }
    await orphansModule.sweepOrphans(db, log, failing)
    await orphansModule.sweepOrphans(db, log, failing)

    expect((await listOrphans(db))[0]?.attempts).toBe(2)

    await orphansModule.sweepOrphans(db, log, async () => {})
    expect(await keysOf()).toEqual([])
  })

  /*
   * One unreachable object must not hold the rest hostage. A batch delete
   * would be fewer round trips and would leave the whole batch listed as
   * failed because of one key.
   */
  it('makes partial progress when one object refuses', async () => {
    const row = await asset('partial')
    await deleteMedia(db, row.id)

    const removed = await orphansModule.sweepOrphans(db, log, async ([key]) => {
      if (key?.endsWith('.webp')) throw new Error('that one is stuck')
    })

    expect(removed).toBe(1)
    expect(await keysOf()).toEqual(['media/partial.webp'])
  })
})

describe.skipIf(!ready)('objects with no row yet', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    orphansModule = await import('./orphans.ts')
    scratch = await createScratchDatabase('abandoned')
    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /*
   * An upload writes its objects before the row that names them, so a failed
   * insert leaves bytes nothing will ever reference. Undoing it immediately is
   * the cheap path; the record is what makes the expensive one possible.
   */
  it('removes what an abandoned upload wrote, and lists nothing afterwards', async () => {
    const removed: string[][] = []

    await orphansModule.abandonObjects(
      db,
      crypto.randomUUID(),
      ['media/a.avif', 'media/a.webp'],
      log,
      async (keys) => {
        removed.push([...keys])
      },
    )

    expect(removed).toEqual([['media/a.avif', 'media/a.webp']])
    expect(await listOrphans(db)).toEqual([])
  })

  it('leaves them listed when the store cannot be reached', async () => {
    await orphansModule.abandonObjects(db, crypto.randomUUID(), ['media/b.avif'], log, async () => {
      throw new Error('unreachable')
    })

    expect((await listOrphans(db)).map((orphan) => orphan.storageKey)).toEqual(['media/b.avif'])
  })

  it('does nothing at all when there is nothing to abandon', async () => {
    await expect(
      orphansModule.abandonObjects(db, crypto.randomUUID(), [], log),
    ).resolves.toBeUndefined()
  })
})
