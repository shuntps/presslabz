import type { ContentRow } from '@presslabz/db'
import type { FastifyBaseLogger } from 'fastify'

/**
 * The thing that makes `scheduled` mean anything.
 *
 * The status has existed since the content model did — the domain refuses one
 * without a date, the editor offers it, the public read withholds it — and
 * nothing ever moved a document out of it. An author who scheduled a post for
 * Tuesday found it still unpublished on Wednesday, with no error anywhere to
 * explain why. A visible feature that does nothing is worse than a missing
 * one, because nobody goes looking for the missing one.
 *
 * A timer in the API process rather than a job runner, for the same reason the
 * session sweep is one: there is no scheduler in this stack, and introducing
 * one to run a single UPDATE would be the wrong trade. Several instances
 * running it at once is safe because the claim is a single statement — see
 * `publishDueContent` — so a document is published once and announced once
 * however many processes are awake.
 *
 * It takes its work as functions rather than a database handle and a hook
 * registry, which keeps this module a scheduler with no persistence in it and
 * makes the properties worth asserting — that it runs at once, survives a
 * failure, never overlaps itself, and announces what it published — testable
 * without either.
 */
export const SCHEDULER_INTERVAL_MS = 60_000

export interface Scheduler {
  stop: () => void
}

export interface SchedulerOptions {
  /** Claims everything due and returns what it claimed. */
  readonly publishDue: () => Promise<ContentRow[]>
  /**
   * Told about each document that went live, one by one.
   *
   * Separate from the claim so that a handler failing cannot roll back a
   * publication that has already happened: the document is on the site, and an
   * integration that did not hear about it is a smaller problem than a post
   * that unpublishes itself because a webhook was down.
   */
  readonly announce: (row: ContentRow) => Promise<void>
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn'>
  readonly intervalMs?: number
}

export function startScheduler({
  publishDue,
  announce,
  log,
  intervalMs = SCHEDULER_INTERVAL_MS,
}: SchedulerOptions): Scheduler {
  /*
   * One pass at a time. setInterval does not wait for an async callback, so a
   * pass slower than the interval would have a second one started on top of
   * it — and while the claim itself is safe to run twice, the announcements
   * are not: a handler would hear about the same publication from two passes.
   */
  let running = false

  const run = async () => {
    if (running) return
    running = true

    try {
      const published = await publishDue()
      if (published.length === 0) return

      log.info(
        { count: published.length, ids: published.map((row) => row.id) },
        'published scheduled content',
      )

      for (const row of published) {
        try {
          await announce(row)
        } catch (error) {
          // The document is live either way. Announcing is best effort, and
          // the next pass will not repeat it, so this is the only chance the
          // log has to say a handler missed it.
          log.warn({ error, id: row.id }, 'could not announce a scheduled publication')
        }
      }
    } catch (error) {
      // A failed pass is not a reason to take the API down, and the next one
      // claims whatever this one left — including anything that came due in
      // between.
      log.warn({ error }, 'could not publish scheduled content')
    } finally {
      running = false
    }
  }

  // At once, then on the interval: an instance starting after downtime should
  // not wait a full period to publish what came due while it was gone.
  void run()

  const timer = setInterval(() => void run(), intervalMs)
  // Never the reason the process stays alive.
  timer.unref?.()

  return {
    stop: () => clearInterval(timer),
  }
}
