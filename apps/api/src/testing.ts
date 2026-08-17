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
