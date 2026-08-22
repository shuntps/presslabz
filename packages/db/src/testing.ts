import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { Sql } from 'postgres'
import type { Database } from './client.ts'
import { contents } from './schema/contents.ts'

/**
 * Whether the integration environment is present, and a refusal to pretend it
 * is optional when it should not be.
 *
 * The suites that use this assert things nothing else can: a lock that
 * serializes two writers, a constraint that holds when a check loses a race, a
 * rollback that takes its revision with it, an object store that refuses bytes
 * it cannot decode. Skipping them on a laptop with no Docker running is a
 * convenience. Skipping them in CI is a green build that tested none of it —
 * which is exactly what happened: Turbo runs in strict env mode and passed
 * neither DATABASE_URL nor VALKEY_URL through, so 45 tests quietly vanished
 * and nobody was told.
 *
 * So: skip when a person runs them, throw when a machine does.
 */
export function hasIntegrationEnv(): boolean {
  if (!process.env.DATABASE_URL) {
    try {
      // vitest runs with the package as its working directory, and every
      // workspace sits two levels under the root.
      process.loadEnvFile(resolve(process.cwd(), '../../.env'))
    } catch {
      // No .env either. Decided below.
    }
  }

  const ready = Boolean(process.env.DATABASE_URL && process.env.VALKEY_URL)

  if (!ready && process.env.CI) {
    throw new Error(
      'Integration tests need DATABASE_URL and VALKEY_URL, and CI has neither.\n' +
        'Declare them on the test task in turbo.json — Turbo runs in strict env\n' +
        'mode, so a variable the workflow sets is still not one the task sees.',
    )
  }

  return ready
}

/**
 * A scratch database, created empty and migrated, for suites that need to
 * observe the system with no rows in it.
 *
 * Bootstrap is the case that forces this: "creates at most one initial
 * administrator" cannot be asserted against a database that already has users,
 * because the function correctly refuses before the race it is being tested
 * for can happen. Deleting the developer's own rows to make room would be a
 * test that costs more than it proves.
 *
 * The name is unique per call. A fixed one plus `drop database ... with
 * (force)` is a suite that terminates another run's connections and deletes
 * the database out from under it — two developers, or a developer and CI
 * against the same server, and one of them fails for reasons that have nothing
 * to do with the code. FORCE stays, because it is what makes the teardown
 * reliable against a connection this suite itself left open; what changes is
 * that it can only ever reach a database this call created.
 *
 * A run that dies before its teardown leaves one behind — a killed process, a
 * failing `afterAll`, a laptop closing. They are swept on the next call rather
 * than left for somebody to notice: an hour is long enough that no live suite
 * is touched and short enough that a developer's server does not accumulate
 * them for a month. "Leaves the database clean" is a property of the suite,
 * not of whoever remembers to look.
 */
export const SCRATCH_PREFIX = 'presslabz_scratch_'

/** Postgres identifiers cap at 63 bytes, so the suffix stays short. */
function scratchName(label: string): string {
  const unique = `${process.pid.toString(36)}${Math.floor(Math.random() * 1e9).toString(36)}`
  const name = `${SCRATCH_PREFIX}${label}_${unique}`.toLowerCase().replace(/[^a-z0-9_]/g, '')
  return name.slice(0, 63)
}

/** How long a scratch database may sit before it is treated as abandoned. */
export const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000

/**
 * Drops scratch databases old enough that no run could still be using them.
 *
 * Best effort on purpose: this is housekeeping, and a failure here must not
 * turn into a test failure about something else entirely. Postgres has no
 * creation timestamp for a database, so the age comes from the directory the
 * cluster wrote for it — which is what "when was this created" means here.
 */
async function sweepAbandonedScratchDatabases(admin: Sql): Promise<void> {
  try {
    const rows = await admin.unsafe<{ datname: string; age: number }[]>(
      `select datname,
              extract(epoch from (now() - (pg_stat_file('base/' || oid || '/PG_VERSION')).modification)) * 1000 as age
         from pg_database
        where datname like '${SCRATCH_PREFIX}%'`,
    )

    for (const row of rows) {
      if (Number(row.age) < SCRATCH_MAX_AGE_MS) continue
      // The name came from pg_database and matched the prefix; still checked,
      // because an identifier cannot be parameterised.
      if (!new RegExp(`^${SCRATCH_PREFIX}[a-z0-9_]{1,40}$`).test(row.datname)) continue
      await admin.unsafe(`drop database if exists ${row.datname} with (force)`)
    }
  } catch {
    // No permission to read the data directory, or a database that vanished
    // between the query and the drop. Neither is this caller's problem.
  }
}

export async function createScratchDatabase(label = 'db'): Promise<{
  url: string
  name: string
  drop: () => Promise<void>
}> {
  const source = process.env.DATABASE_URL
  if (!source) throw new Error('DATABASE_URL is required to create a scratch database')

  const name = scratchName(label)

  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')

  const adminUrl = new URL(source)
  adminUrl.pathname = '/postgres'

  // Identifiers cannot be parameterised, so the name is restricted instead.
  if (!new RegExp(`^${SCRATCH_PREFIX}[a-z0-9_]{1,40}$`).test(name)) {
    throw new Error(`Refusing to create "${name}": not a scratch database name`)
  }

  const admin = postgres(adminUrl.toString(), { max: 1 })
  try {
    await sweepAbandonedScratchDatabases(admin)
    await admin.unsafe(`create database ${name}`)
  } finally {
    await admin.end({ timeout: 5 })
  }

  const scratchUrl = new URL(source)
  scratchUrl.pathname = `/${name}`
  const url = scratchUrl.toString()

  const client = postgres(url, { max: 1 })
  try {
    await migrate(drizzle(client), {
      migrationsFolder: resolve(import.meta.dirname, '../drizzle'),
    })
  } finally {
    await client.end({ timeout: 5 })
  }

  return {
    url,
    name,
    drop: async () => {
      const cleanup = postgres(adminUrl.toString(), { max: 1 })
      try {
        await cleanup.unsafe(`drop database if exists ${name} with (force)`)
      } finally {
        await cleanup.end({ timeout: 5 })
      }
    },
  }
}

/**
 * Support for the suites that assert what happens *between* two transactions.
 *
 * They all have the same shape: hold one transaction open at a chosen point,
 * start a second operation, prove it is blocked rather than reading past the
 * lock, then release and assert on the outcome. The three helpers below were
 * written twice, once per suite; they live here now so a third suite does not
 * write them a third time.
 */

/** Lets a test hold a transaction open at a chosen point. */
export function gate(): { open: () => void; opened: Promise<void> } {
  let open: () => void = () => {}
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  return { open, opened }
}

/**
 * Long enough for a blocked query to have run if it were going to.
 *
 * There is no event for "this statement is waiting on a lock", so the only
 * available proof is that it had time and did nothing.
 */
export const settle = (): Promise<unknown> => new Promise((resolve) => setTimeout(resolve, 250))

/**
 * Keeps a promise's rejection from counting as unhandled while the test is
 * still setting up.
 *
 * These suites deliberately start an operation and only assert on it several
 * statements later, after releasing the transaction that was blocking it. If
 * it rejects in between — which is exactly what the refusal tests expect it to
 * do — Node reports an unhandled rejection, and Vitest fails the whole run
 * while every test in it passes. That is not hypothetical: it turned a
 * documentation-only pull request red, and it was green on a re-run, because
 * the window is a matter of scheduling.
 *
 * Attaching a handler at creation closes the window and changes nothing else:
 * the promise keeps its rejection, so `await expect(p).rejects` still sees it,
 * and a rejection the test did not expect still fails the assertion rather
 * than being swallowed.
 */
export function held<T>(promise: Promise<T>): Promise<T> {
  promise.catch(() => {})
  return promise
}

/**
 * Takes a row lock on one document and keeps it until the caller lets go.
 *
 * For the suites that have to prove something *waited*. `Promise.all` on two
 * callers proves nothing on its own — the first can finish before the second
 * starts, and the test passes without anything having overlapped. Holding the
 * row first makes the overlap a fact rather than a hope.
 *
 * It lives here rather than in the suites because taking a lock means reaching
 * for drizzle and the schema, and the API's tests have neither: this package
 * is where both already are.
 *
 * The returned function releases the lock and waits for the holding
 * transaction to finish, so a test can be sure the row is free before it
 * asserts on what happened next. Call it in a `finally` — a failed expectation
 * must never leave a lock nobody drops.
 */
export async function holdContentRow(db: Database, id: string): Promise<() => Promise<void>> {
  const holding = gate()
  const release = gate()

  const holder = held(
    db.transaction(async (tx) => {
      await tx.select().from(contents).where(eq(contents.id, id)).limit(1).for('update')
      holding.open()
      await release.opened
    }),
  )

  await holding.opened

  return async () => {
    release.open()
    await holder
  }
}

/**
 * How many backends on this database are currently blocked on a lock.
 *
 * The direct evidence that something is *waiting*, rather than the indirect
 * kind — "it had time and did nothing" — which is also true of work that never
 * started. It matters wherever the thing under test is fire-and-forget and the
 * suite cannot await it: a scheduler's pass at boot, for one.
 *
 * Scoped to the current database, which in these suites is a scratch one
 * nothing else connects to.
 */
export async function backendsWaitingOnLocks(db: Database): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as waiting
      from pg_stat_activity
     where datname = current_database()
       and wait_event_type = 'Lock'
  `)

  return Number((rows as unknown as { waiting: number }[])[0]?.waiting ?? 0)
}
