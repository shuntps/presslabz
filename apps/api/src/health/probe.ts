/**
 * Bounded, non-accumulating dependency probes.
 *
 * `/health` asks PostgreSQL and Valkey whether they answer. Two things have to
 * be true about that, and neither was:
 *
 * 1. It has to come back. Nothing bounded those calls — the database client is
 *    built with no connect or statement timeout — so a wedged dependency left
 *    the request hanging. `requestTimeout` does not help: it bounds receiving
 *    the request, not waiting on a dependency, and the handler timeout is
 *    deliberately off.
 *
 * 2. Losing the race must not start another one. A probe that times out and is
 *    called again every few seconds by a liveness check would pile a new query
 *    on the connection pool each time, all of them still running. The bound
 *    would have turned one stuck dependency into an exhausted pool.
 *
 * So each dependency has at most one probe in flight per instance. Concurrent
 * callers await the one already running rather than starting another, and the
 * slot is released when the underlying operation finally settles — which is
 * what lets a later probe genuinely observe recovery rather than being told
 * about a result from the outage.
 *
 * What this does NOT do is cancel anything. The query that lost the race runs
 * to completion inside the database. Postgres.js can cancel a query in
 * progress, but its own documentation warns that cancellation opens a new
 * connection, is not guaranteed, and can race into cancelling a different
 * query — so it is not used here. Bounding the HTTP response and refusing to
 * pile up work is the guarantee on offer; cancelling the work is not, and is
 * not claimed.
 */
export interface ProbeResult {
  status: 'up' | 'down'
  /** Present when the probe did not answer inside its budget. */
  timedOut?: boolean
}

export interface SingleFlightProbe {
  run: () => Promise<ProbeResult>
  /** True while an operation from an earlier call is still outstanding. */
  readonly inFlight: boolean
  /** How many operations this probe has actually started. */
  readonly started: number
}

export interface ProbeOptions {
  readonly check: () => Promise<unknown>
  readonly timeoutMs: number
}

export function createProbe({ check, timeoutMs }: ProbeOptions): SingleFlightProbe {
  let pending: Promise<'up' | 'down'> | null = null
  let started = 0

  const begin = (): Promise<'up' | 'down'> => {
    started++
    const attempt = check().then(
      () => 'up' as const,
      /*
       * Settled here rather than left to reject. A late rejection whose only
       * consumer has already timed out would otherwise be an unhandled
       * rejection — which in Node terminates the process by default, turning a
       * dependency blip into an outage of the API itself.
       */
      () => 'down' as const,
    )

    pending = attempt
    // The slot is freed whenever the work ends, however long that takes, so
    // the next probe starts a real operation and can see a recovery.
    void attempt.finally(() => {
      if (pending === attempt) pending = null
    })

    return attempt
  }

  return {
    get inFlight() {
      return pending !== null
    },
    get started() {
      return started
    },
    run: async (): Promise<ProbeResult> => {
      // An operation already running is awaited, never duplicated. That is the
      // single-flight guarantee: concurrent /health calls cost one query.
      const attempt = pending ?? begin()

      let timer: NodeJS.Timeout | undefined
      const budget = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
        // A pending probe must not be what keeps the process alive at exit.
        timer.unref?.()
      })

      try {
        const outcome = await Promise.race([attempt, budget])
        if (outcome === 'timeout') return { status: 'down', timedOut: true }
        return { status: outcome }
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
  }
}
