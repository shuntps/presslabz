import { resolve } from 'node:path'
import { eq, sql } from 'drizzle-orm'
import type { Sql } from 'postgres'
import type { Database } from './client.ts'
import { mediaReferenceSync } from './schema/content-media.ts'
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

/**
 * Whether this is a name the scratch machinery would itself produce and
 * accept. The single guard shared by the creation helper, the sweeper and the
 * test-side safety net, so no destructive path can accept a name another
 * would have refused.
 */
export function isScratchDatabaseName(name: string): boolean {
  return new RegExp(`^${SCRATCH_PREFIX}[a-z0-9_]{1,40}$`).test(name)
}

/**
 * The explicit timeout for every afterAll that drops a scratch database —
 * 24 teardowns sharing one finite policy.
 *
 * Twenty-two of them were living on Vitest's implicit 10-second default
 * while their setups declared 60 seconds or more — most 60, pagination 120,
 * web 180; the other two already carried a literal 60 of their own.
 * Measured under the full-repository run, concurrent drops wait on the
 * PostgreSQL checkpointer (`IPC/CheckpointStart` → `CheckpointDone` in
 * pg_stat_activity) — a normal wait under contention, not a stuck lock —
 * and the queue crosses ten seconds exactly when everything runs at once.
 *
 * The longer budget does not turn `DROP … WITH (FORCE)` into proof of a
 * clean shutdown. Every suite remains responsible for closing its own
 * resources before the drop, and a forgotten connection stays a distinct
 * defect to diagnose — only the delivery suite asserts zero backends
 * explicitly — never something this timeout is allowed to hide.
 */
export const SCRATCH_TEARDOWN_TIMEOUT_MS = 60_000

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
      if (!isScratchDatabaseName(row.datname)) continue
      await admin.unsafe(`drop database if exists ${row.datname} with (force)`)
    }
  } catch {
    // No permission to read the data directory, or a database that vanished
    // between the query and the drop. Neither is this caller's problem.
  }
}

/** One failure keeps its identity; several are all kept, none masking another. */
function rethrowAdminFailures(failures: unknown[], summary: string): void {
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, summary)
}

/**
 * Opens a short-lived connection to the maintenance database, runs one piece
 * of work, and closes it — keeping **both** failures when the work and the
 * close both fail. A plain try/finally here would let a failing `end()`
 * replace the query's own error, which for a failed DROP is the diagnosis an
 * operator needed.
 */
async function withAdminConnection<T>(adminUrl: URL, work: (admin: Sql) => Promise<T>): Promise<T> {
  const { default: postgres } = await import('postgres')
  const admin = postgres(adminUrl.toString(), { max: 1 })

  const failures: unknown[] = []
  let result: T | undefined

  try {
    result = await work(admin)
  } catch (error) {
    failures.push(error)
  }
  try {
    await admin.end({ timeout: 5 })
  } catch (error) {
    failures.push(error)
  }

  rethrowAdminFailures(failures, 'the work failed, and closing the admin connection failed too')
  return result as T
}

/**
 * Drops the named scratch database over a connection of its own, so a client
 * that broke earlier in a teardown cannot stop the drop from being tried.
 */
function dropScratchDatabase(adminUrl: URL, name: string): Promise<void> {
  return withAdminConnection(adminUrl, async (admin) => {
    await admin.unsafe(`drop database if exists ${name} with (force)`)
  })
}

export async function createScratchDatabase(
  label = 'db',
  /*
   * The override exists for exactly one caller: the test that proves a
   * failing migration does not leave the database it was migrating behind.
   * Nothing else should ever point a scratch database at other migrations.
   */
  options: { migrationsFolder?: string } = {},
): Promise<{
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
  if (!isScratchDatabaseName(name)) {
    throw new Error(`Refusing to create "${name}": not a scratch database name`)
  }

  const admin = postgres(adminUrl.toString(), { max: 1 })
  // Best effort by design; it never throws.
  await sweepAbandonedScratchDatabases(admin)

  try {
    await admin.unsafe(`create database ${name}`)
  } catch (creationFailure) {
    /*
     * Ambiguous, not absent: a network or protocol failure can arrive after
     * the server already executed the statement, so a rejected CREATE may
     * still have created the database. The name is unique to this call and
     * came from nowhere else, so dropping it by exact name is safe in either
     * outcome — `if exists` makes the never-created case a no-op. The
     * creation failure stays first; a close or cleanup that also fails is
     * kept beside it, never in front of it.
     */
    const failures: unknown[] = [creationFailure]
    try {
      await admin.end({ timeout: 5 })
    } catch (error) {
      failures.push(error)
    }
    try {
      await dropScratchDatabase(adminUrl, name)
    } catch (error) {
      failures.push(error)
    }

    if (failures.length === 1) throw creationFailure
    throw new AggregateError(
      failures,
      `Creating scratch database ${name} failed, and cleaning up after it failed too`,
    )
  }

  /*
   * From here until the handle is returned, the database exists and the
   * caller has no way to drop it — the handle carrying `drop` is the last
   * thing this function does. Any failure inside this window is therefore
   * this function's to clean up: close whatever client is open, drop the
   * database, and rethrow with the primary failure first. Migration is the
   * likely failure — a refusing migration like 0010 refuses on scratch
   * databases holding bad fixtures too — but the window covers every step,
   * including a client that will not close.
   */
  const scratchUrl = new URL(source)
  scratchUrl.pathname = `/${name}`
  const url = scratchUrl.toString()

  let client: ReturnType<typeof postgres> | null = null
  let adminEnded = false
  let clientEnded = false

  try {
    await admin.end({ timeout: 5 })
    adminEnded = true

    client = postgres(url, { max: 1 })
    await migrate(drizzle(client), {
      migrationsFolder: options.migrationsFolder ?? resolve(import.meta.dirname, '../drizzle'),
    })

    await client.end({ timeout: 5 })
    clientEnded = true
  } catch (primary) {
    const failures: unknown[] = [primary]

    // Every step is attempted; every failure is kept beside the primary,
    // never in front of it.
    if (!adminEnded) {
      await admin.end({ timeout: 5 }).then(
        () => {},
        (error: unknown) => failures.push(error),
      )
    }
    if (client && !clientEnded) {
      await client.end({ timeout: 5 }).then(
        () => {},
        (error: unknown) => failures.push(error),
      )
    }
    try {
      await dropScratchDatabase(adminUrl, name)
    } catch (dropFailure) {
      failures.push(dropFailure)
    }

    if (failures.length === 1) throw primary
    throw new AggregateError(
      failures,
      `Setting up scratch database ${name} failed after it was created, and cleaning it up failed too`,
    )
  }

  return {
    url,
    name,
    drop: () => dropScratchDatabase(adminUrl, name),
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

/**
 * Forces the media reference marker, for the suites that are about what
 * happens on either side of it.
 *
 * Here rather than in those suites because setting it means reaching for
 * drizzle and the schema, and the API's tests have neither — the same reason
 * `holdContentRow` lives here.
 */
export async function setMediaReferenceSyncState(
  db: Database,
  state: 'pending' | 'ready',
): Promise<void> {
  await db.update(mediaReferenceSync).set({ state }).where(eq(mediaReferenceSync.id, true))
}

/**
 * How many backends are connected to this database.
 *
 * For the suites that assert a failure path let go of what it had opened. A
 * refusal that throws while holding its pool leaks one backend per attempt,
 * and the attempts happen at boot, in front of somebody restarting the process
 * to see whether it takes this time.
 */
export async function openBackends(db: Database): Promise<number> {
  const rows = await db.execute(sql`
    select count(*)::int as open
      from pg_stat_activity
     where datname = current_database()
  `)

  return Number((rows as unknown as { open: number }[])[0]?.open ?? 0)
}

/**
 * Runs something against a user row the current schema would refuse.
 *
 * A restore from a database older than `0010`, or a value somebody wrote in
 * psql before the constraints existed. The API normalises such a row rather
 * than failing on it, and that defence cannot be tested against a table that
 * makes the row impossible.
 *
 * The three constraints are dropped, the row is inserted, and both are undone
 * afterwards — the constraints from `pg_get_constraintdef`, which is the
 * database describing itself, so this helper holds no second copy of the
 * vocabularies. The row goes first, because a constraint cannot come back over
 * a row that violates it.
 *
 * Here rather than in the API's suite for the reason `holdContentRow` is: this
 * needs drizzle and the schema, and nothing outside this package has either.
 */
export async function withUserFromBeforeTheConstraints<T>(
  db: Database,
  values: {
    email: string
    displayName: string
    role?: string
    locale?: string
    themePreference?: string
    /** For the case that has to be able to sign in, not only to be read. */
    passwordHash?: string
  },
  run: (userId: string) => Promise<T>,
): Promise<T> {
  const constraints = (await db.execute(sql`
    select conname, pg_get_constraintdef(oid) as definition
      from pg_constraint
     where conrelid = 'users'::regclass
       and contype = 'c'
       and conname in ('users_role_known', 'users_locale_known', 'users_theme_preference_known')
  `)) as unknown as { conname: string; definition: string }[]

  for (const constraint of constraints) {
    await db.execute(sql.raw(`alter table users drop constraint "${constraint.conname}"`))
  }

  const inserted = (await db.execute(sql`
    insert into users (email, display_name, role, locale, theme_preference, password_hash)
    values (
      ${values.email},
      ${values.displayName},
      ${values.role ?? 'subscriber'},
      ${values.locale ?? 'en'},
      ${values.themePreference ?? 'system'},
      ${values.passwordHash ?? null}
    )
    returning id
  `)) as unknown as { id: string }[]

  const userId = String(inserted[0]?.id)

  try {
    return await run(userId)
  } finally {
    await db.execute(sql`delete from users where id = ${userId}`)
    for (const constraint of constraints) {
      await db.execute(
        sql.raw(
          `alter table users add constraint "${constraint.conname}" ${constraint.definition}`,
        ),
      )
    }
  }
}

/**
 * How many backends are attached to the named database, asked from the
 * maintenance database — for a suite that wants to prove its own scratch
 * database has no connection left before it drops it. By exact name, never by
 * prefix: other packages create and drop their own scratch databases
 * concurrently, and a prefix would count theirs.
 */
export function backendsOn(name: string): Promise<number> {
  const source = process.env.DATABASE_URL
  if (!source) throw new Error('DATABASE_URL is required to count backends')

  const adminUrl = new URL(source)
  adminUrl.pathname = '/postgres'

  return withAdminConnection(adminUrl, async (admin) => {
    const rows = await admin`
      select count(*)::int as open from pg_stat_activity where datname = ${name}
    `
    return Number(rows[0]?.open ?? 0)
  })
}

/** Whether a database of exactly this name exists. Same scoping rule as above. */
export function databaseExists(name: string): Promise<boolean> {
  const source = process.env.DATABASE_URL
  if (!source) throw new Error('DATABASE_URL is required to look for a database')

  const adminUrl = new URL(source)
  adminUrl.pathname = '/postgres'

  return withAdminConnection(adminUrl, async (admin) => {
    const rows = await admin`select 1 as found from pg_database where datname = ${name}`
    return rows.length > 0
  })
}
