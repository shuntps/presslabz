import type { FastifyBaseLogger } from 'fastify'

/**
 * Says something when a dependency's state changes, and nothing while it stays
 * the same.
 *
 * `/health` is what a load balancer calls every few seconds. A probe that
 * logged its own result would write the same line thousands of times an hour,
 * and a line that appears in every run is a line nobody reads — which is how
 * the ones that matter get missed. The rate limiter's store already reports
 * this way; the object store now does too.
 *
 * What is suppressed is counted, so a recovery can say how long the outage
 * actually lasted in checks rather than leaving it to be guessed.
 *
 * **The cause is part of the state.** Keying on `down` alone would have made a
 * store that went from *missing* to *refusing our credentials* look like the
 * same outage continuing, and that second sentence is the one an operator
 * needs: the first says run the installation command, the second says the key
 * is wrong. Two different jobs, one suppressed line.
 */
export function reportChanges(
  log: Pick<FastifyBaseLogger, 'warn' | 'info'>,
  subject: string,
): (state: string, cause: string, message: string) => void {
  let previous: string | undefined
  let repeated = 0

  return (state, cause, message) => {
    const key = `${state}/${cause}`

    if (key === previous) {
      repeated++
      return
    }

    const from = previous
    const suppressed = repeated
    previous = key
    repeated = 0

    // A healthy start is not news; a recovery is.
    if (from === undefined && state === 'up') return

    if (state === 'up') {
      log.info({ subject, from, suppressed }, message)
      return
    }

    log.warn({ subject, from, cause, suppressed }, message)
  }
}
