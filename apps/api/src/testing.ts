import { randomUUID } from 'node:crypto'

/**
 * Rate-limit counters live in Valkey now, which is the point — one quota
 * across every instance — and also a problem for tests: they outlive the
 * process and are shared with whatever else is running. A suite using the
 * configured prefix would spend the real allowance and collide with the next
 * run, and the failure would look like a flaky test rather than a shared
 * counter.
 *
 * So each suite takes a prefix of its own and removes exactly the keys it
 * created. Never a FLUSHDB: that would delete what belongs to somebody else.
 */
export function testRateLimitNamespace(label: string): string {
  return `presslabz:rl:test:${label}:${randomUUID()}:`
}

/**
 * Deletes every key under a namespace, in batches, using SCAN rather than
 * KEYS — the latter blocks the server for the length of the keyspace, which is
 * a poor habit to build even against a development instance.
 */
export async function dropRateLimitKeys(url: string, namespace: string): Promise<number> {
  const { Valkey } = await import('iovalkey')
  const client = new Valkey(url, { maxRetriesPerRequest: 1 })
  client.on('error', () => {})

  let cursor = '0'
  let removed = 0

  try {
    do {
      const [next, keys] = await client.scan(cursor, 'MATCH', `${namespace}*`, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) {
        removed += await client.del(...keys)
      }
    } while (cursor !== '0')
  } finally {
    client.disconnect()
  }

  return removed
}

/**
 * Runs every teardown step, then puts the environment back — in that order,
 * once, and whatever happens in between.
 *
 * Not two `afterAll` hooks. Vitest runs them in `stack` order by default, so
 * the one declared *second* runs *first*: a suite that closed its resources in
 * one and restored the environment in the next was restoring the environment
 * before anything had closed, while its comment claimed the opposite. Measured,
 * not assumed — a third hook declared last observed the other two had not run.
 *
 * Every step is attempted even when an earlier one throws, because a step that
 * did not run is a connection nobody closed. Nothing is swallowed: a single
 * failure is raised as itself, several as an `AggregateError`, which is the
 * policy this repository already uses where a body and its cleanup can both
 * fail.
 */
export async function closeThenRestore(
  steps: readonly (() => unknown | Promise<unknown>)[],
  restoreEnvironment: () => void,
): Promise<void> {
  const failures: unknown[] = []

  for (const step of steps) {
    try {
      await step()
    } catch (error) {
      failures.push(error)
    }
  }

  // Last, and unconditionally: a close that failed must not leave the process
  // holding values this suite substituted.
  try {
    restoreEnvironment()
  } catch (error) {
    failures.push(error)
  }

  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'the suite failed to clean up')
}

/**
 * Runs a body, then cleans up whatever happened — the same policy as
 * `closeThenRestore`, with the body's own failure kept in front of it.
 *
 * The shape a scenario needs when it stands up a second application: the
 * protection has to begin the moment the instance exists, before `ready()`,
 * or a failure there leaves an app nobody closed and a namespace nobody
 * swept. A plain `try`/`finally` does not do it either — a `close()` that
 * throws would skip every step after it, so the environment stays substituted
 * and the keys stay behind.
 *
 * The body's error is the one worth reading, so it comes first; a cleanup
 * that failed as well travels beside it rather than replacing it.
 */
export async function withCleanup<T>(
  body: () => Promise<T>,
  steps: readonly (() => unknown | Promise<unknown>)[],
  restoreEnvironment: () => void,
): Promise<T> {
  let result: T | undefined
  let bodyError: unknown
  let bodyThrew = false

  try {
    result = await body()
  } catch (error) {
    bodyError = error
    bodyThrew = true
  }

  let cleanupError: unknown
  let cleanupThrew = false
  try {
    await closeThenRestore(steps, restoreEnvironment)
  } catch (error) {
    cleanupError = error
    cleanupThrew = true
  }

  if (bodyThrew && cleanupThrew) {
    const beside = cleanupError instanceof AggregateError ? cleanupError.errors : [cleanupError]
    throw new AggregateError([bodyError, ...beside], 'the scenario failed, and so did its cleanup')
  }
  if (bodyThrew) throw bodyError
  if (cleanupThrew) throw cleanupError

  // Only reachable when the body returned, so the assignment above happened.
  return result as T
}
