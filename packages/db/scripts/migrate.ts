/**
 * Applies the migrations, and says why when one refuses.
 *
 * `drizzle-kit migrate` was doing this until a migration started refusing on
 * purpose. Measured with the drizzle-kit this repository pins, against 0010
 * and a row outside the vocabularies: the CLI printed a spinner, exited 1,
 * and said nothing at all — no message, no detail, no file name. An
 * observation about that version and that migration, not a verdict on every
 * drizzle-kit — but a migration that names the rows an operator has to
 * correct is worth nothing if the naming never reaches them, and this script
 * is tested for exactly that.
 *
 * The migrator underneath is drizzle's own, reading the same folder and the
 * same journal, so this is a different way of running the same thing rather
 * than a second implementation of it. `drizzle-kit generate` still writes the
 * files.
 *
 * What this file leans on and drizzle does not promise is the *shape* of the
 * error it throws — that the driver's error is reachable at `.cause`. That is
 * an observation about a version, not an API, so `scripts/migrate.test.ts`
 * runs this script against a database that makes a migration refuse and reads
 * what an operator would read. If a drizzle upgrade rewraps its errors, that
 * test fails here rather than in somebody's deployment.
 */
import { resolve } from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import postgres from 'postgres'

const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set. Copy .env.example to .env at the repository root.')
  process.exit(1)
}

/** What a Postgres error carries beyond its message. */
interface DatabaseError {
  message: string
  detail?: string
  hint?: string
  where?: string
}

/**
 * The driver error under drizzle's wrapper, if it is still where it was.
 *
 * The wrapper's own message is the SQL that failed and its parameters — which
 * for a migration that raises deliberately means the operator is shown the
 * whole statement and none of the reason. What was raised sits on `cause` in
 * the version this repository pins; the fallback below is what happens when
 * it does not, and printing the outer error is still better than printing
 * nothing.
 */
function databaseError(error: unknown): DatabaseError | null {
  const cause = (error as { cause?: unknown })?.cause
  if (typeof cause === 'object' && cause !== null && 'message' in cause) {
    return cause as DatabaseError
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return error as DatabaseError
  }
  return null
}

const client = postgres(url, { max: 1 })

try {
  await migrate(drizzle(client), { migrationsFolder: resolve(import.meta.dirname, '../drizzle') })
  // Nothing to say when it worked; the exit code is the answer.
} catch (error) {
  /*
   * DETAIL and HINT are where a refusing migration puts the part an operator
   * acts on — which rows, and what to do about them. Node prints neither for
   * an uncaught error, so they are printed here by name.
   */
  const reported = databaseError(error)
  if (reported) {
    console.error(`Migration failed: ${reported.message}`)
    if (reported.detail) console.error(reported.detail)
    if (reported.hint) console.error(`Hint: ${reported.hint}`)
  } else {
    console.error(error)
  }
  process.exitCode = 1
} finally {
  await client.end({ timeout: 5 })
}
