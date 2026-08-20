import { createDb } from '@presslabz/db'
import { env } from './env.ts'

/**
 * One connection pool per process.
 *
 * Stashed on globalThis because Astro's dev server re-evaluates a module every
 * time something it imports changes: without this, an afternoon of editing
 * opens a new pool per save until Postgres refuses the next one. The built
 * server imports it once and never sees the branch.
 */
const HANDLE = Symbol.for('presslabz.web.database')

interface Global {
  [HANDLE]?: ReturnType<typeof createDb>
}

const store = globalThis as Global

function open(): ReturnType<typeof createDb> {
  const handle = createDb(env.DATABASE_URL, { maxConnections: 10 })

  // A rendering process that is asked to stop should let its queries finish
  // rather than dropping the socket mid-response.
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, () => {
      void handle.close()
    })
  }

  return handle
}

const handle = store[HANDLE] ?? open()
store[HANDLE] = handle

export const db = handle.db
