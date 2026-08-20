import {
  type Database,
  forgetOrphan,
  listOrphans,
  recordOrphanFailure,
  recordOrphans,
} from '@presslabz/db'
import type { FastifyBaseLogger } from 'fastify'
import { deleteObjects } from './storage.ts'

/**
 * Finishing what a request could not.
 *
 * Media lives in two systems that cannot share a transaction, so every delete
 * and every failed upload can leave bytes with no row. That was survivable and
 * invisible: nothing listed the leak and nothing would ever try again. An
 * orphan row is written where it is atomic — inside the transaction that
 * removes the media row, or immediately after an upload gives up — and removed
 * once the object is actually gone.
 *
 * A failure here is never the caller's problem. By the time it runs, the thing
 * the person asked for has already happened.
 */

/** How many objects one pass will try. Small: this is background work. */
const ORPHAN_BATCH = 50

export interface OrphanSweeper {
  stop: () => void
}

export interface OrphanSweepOptions {
  readonly db: Database
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>
  readonly intervalMs?: number
  /** Overridable so a test can make the store fail without touching S3. */
  readonly remove?: (keys: readonly string[]) => Promise<void>
}

/**
 * Removes the objects an upload wrote and then could not claim.
 *
 * Tried immediately, because the keys are in hand and the store is right
 * there; recorded as orphans first, because "tried" is not "done" and the
 * record is what makes the difference recoverable.
 */
export async function abandonObjects(
  db: Database,
  mediaId: string,
  keys: readonly string[],
  log: Pick<FastifyBaseLogger, 'warn'>,
  remove: (keys: readonly string[]) => Promise<void> = deleteObjects,
): Promise<void> {
  if (keys.length === 0) return

  try {
    await recordOrphans(db, mediaId, keys)
  } catch (error) {
    // The one case with nothing left to fall back on: the bytes are written,
    // the row is not, and the note saying so could not be taken either.
    log.warn({ err: error, keys }, 'could not record abandoned media objects')
  }

  try {
    await remove(keys)
    for (const key of keys) await forgetOrphan(db, key)
  } catch (error) {
    log.warn({ err: error, keys }, 'left media objects for the sweep')
  }
}

export async function sweepOrphans(
  db: Database,
  log: Pick<FastifyBaseLogger, 'info' | 'warn'>,
  remove: (keys: readonly string[]) => Promise<void> = deleteObjects,
): Promise<number> {
  const orphans = await listOrphans(db, ORPHAN_BATCH)
  if (orphans.length === 0) return 0

  let removed = 0

  /*
   * One at a time, and one failure does not stop the rest. A batch delete
   * would be fewer round trips and would also mean a single unreachable key
   * leaves the whole batch listed as failed — for background work that runs
   * every few minutes, being able to make partial progress is worth more.
   */
  for (const orphan of orphans) {
    try {
      await remove([orphan.storageKey])
      await forgetOrphan(db, orphan.storageKey)
      removed += 1
    } catch (error) {
      await recordOrphanFailure(db, orphan.storageKey, String(error))
    }
  }

  if (removed > 0) log.info({ removed }, 'removed orphaned media objects')

  return removed
}

/** Ten minutes: nothing here is urgent, and a leak that waits is still fixed. */
const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60 * 1000

export function startOrphanSweep({
  db,
  log,
  intervalMs = ORPHAN_SWEEP_INTERVAL_MS,
  remove,
}: OrphanSweepOptions): OrphanSweeper {
  let running = false

  const run = async () => {
    if (running) return
    running = true

    try {
      await sweepOrphans(db, log, remove)
    } catch (error) {
      log.warn({ err: error }, 'could not sweep orphaned media objects')
    } finally {
      running = false
    }
  }

  void run()

  const timer = setInterval(() => void run(), intervalMs)
  timer.unref?.()

  return { stop: () => clearInterval(timer) }
}
