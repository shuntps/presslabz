import { sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema/index.ts'

export interface DbOptions {
  /** Maximum pooled connections. Keep low in serverless-style deployments. */
  maxConnections?: number
}

/**
 * Creates a database handle. The caller owns the lifetime and must call
 * `close()` on shutdown — Fastify does this from its onClose hook.
 */
export function createDb(url: string, options: DbOptions = {}) {
  const client = postgres(url, { max: options.maxConnections ?? 10 })
  const db = drizzle(client, { schema, casing: 'snake_case' })

  return {
    db,
    /**
     * Liveness probe. Lives here so that callers never need to import drizzle
     * to ask a trivial question — query building stays inside this package.
     */
    ping: async (): Promise<void> => {
      await db.execute(sql`select 1`)
    },
    close: () => client.end({ timeout: 5 }),
  }
}

export type Database = ReturnType<typeof createDb>['db']

export * from './schema/index.ts'
export { schema }
