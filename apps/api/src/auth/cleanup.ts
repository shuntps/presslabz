import { type Database, deleteExpiredSessions } from '@presslabz/db'
import type { FastifyBaseLogger } from 'fastify'

/**
 * Expired sessions were never swept: `deleteExpiredSessions` existed and
 * nothing called it, so the table grew for the life of the installation. The
 * rows granted nothing — every lookup filters on expiry — but a table of who
 * was signed in and when is not something to keep by accident.
 *
 * A timer in the API process rather than a scheduler, because there is no job
 * runner in the stack and introducing one to run a single DELETE would be the
 * wrong trade. Several instances sweeping the same rows is harmless: the
 * statement is idempotent and the losers simply delete nothing.
 */
export const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface SessionSweeper {
  stop: () => void
}

export function startSessionSweep(
  db: Database,
  log: FastifyBaseLogger,
  intervalMs: number = SESSION_SWEEP_INTERVAL_MS,
): SessionSweeper {
  const sweep = async () => {
    try {
      const removed = await deleteExpiredSessions(db)
      if (removed > 0) log.info({ removed }, 'swept expired sessions')
    } catch (error) {
      // A failed sweep is not a reason to take the API down; the next one
      // will collect whatever this one left.
      log.warn({ error }, 'could not sweep expired sessions')
    }
  }

  void sweep()

  const timer = setInterval(sweep, intervalMs)
  // Without this the timer alone keeps the process alive, and a container
  // that will not exit is a deploy that hangs.
  timer.unref()

  return { stop: () => clearInterval(timer) }
}
