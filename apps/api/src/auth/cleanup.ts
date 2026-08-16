import type { FastifyBaseLogger } from 'fastify'

/**
 * The periodic sweep of expired sessions.
 *
 * `deleteExpiredSessions` existed and nothing called it, so the table grew for
 * the life of the installation. The rows granted nothing — every lookup
 * filters on expiry — but a record of who was signed in and when is not
 * something to keep by accident.
 *
 * A timer in the API process rather than a scheduled job, because there is no
 * job runner in the stack and introducing one to run a single DELETE would be
 * the wrong trade. Several instances sweeping the same rows is harmless: the
 * statement is idempotent and the losers delete nothing.
 *
 * It takes the sweep as a function rather than a database handle. That keeps
 * this module a scheduler with no persistence in it, and makes the properties
 * worth asserting — that it runs at once, survives a failure, stops when told
 * and never overlaps itself — testable without a database.
 */
export const SESSION_SWEEP_INTERVAL_MS = 60 * 60 * 1000

export interface SessionSweeper {
  stop: () => void
}

export interface SessionSweepOptions {
  /** Returns how many rows went, for the log. */
  readonly sweep: () => Promise<number>
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>
  readonly intervalMs?: number
}

export function startSessionSweep({
  sweep,
  log,
  intervalMs = SESSION_SWEEP_INTERVAL_MS,
}: SessionSweepOptions): SessionSweeper {
  /*
   * One sweep at a time. setInterval does not wait for an async callback, so a
   * sweep slower than the interval would otherwise have a second one started
   * on top of it — and a delete that is already struggling is the last thing
   * to run twice at once.
   */
  let running = false

  const run = async () => {
    if (running) return
    running = true

    try {
      const removed = await sweep()
      if (removed > 0) log.info({ removed }, 'swept expired sessions')
    } catch (error) {
      // A failed sweep is not a reason to take the API down, and the next one
      // collects whatever this one left.
      log.warn({ error }, 'could not sweep expired sessions')
    } finally {
      running = false
    }
  }

  // Once at boot, so an instance that restarts more often than the interval
  // still clears anything that expired while it was down.
  void run()

  const timer = setInterval(() => void run(), intervalMs)
  // Without this the timer alone keeps the process alive, and a container that
  // will not exit is a deploy that hangs.
  timer.unref()

  return { stop: () => clearInterval(timer) }
}
