import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { promisify } from 'node:util'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../src/client.ts'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '../src/testing.ts'

/*
 * What an operator sees when a migration refuses.
 *
 * This script exists for exactly one reason: the `drizzle-kit migrate` this
 * repository pins printed a spinner, exited 1 and said nothing at all when
 * `0010` raised on purpose — no message, no DETAIL, no file. Replacing it
 * means depending on something drizzle documents nowhere, that the driver's
 * error is reachable at `.cause` of the error the migrator throws. Both are
 * observations about a version, not contracts, so the behaviour is asserted
 * here rather than assumed: the script is run as a process, against a real
 * database, and its output is read the way a deployment log would be.
 *
 * A behaviour test, not a unit one. Mocking the migrator would assert that
 * this file handles the error shape it was written for, which is the one thing
 * that is not in doubt.
 */

const ready = hasIntegrationEnv()
const run = promisify(execFile)
const SCRIPT = resolve(import.meta.dirname, './migrate.ts')

const CONSTRAINTS = ['users_role_known', 'users_locale_known', 'users_theme_preference_known']

describe.skipIf(!ready)('running the migrations', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database

  beforeAll(async () => {
    scratch = await createScratchDatabase('migrate')
    handle = createDb(scratch.url, { maxConnections: 3 })
    db = handle.db
  }, 60_000)

  /*
   * Explicit, like the initialisation's, and for the same reason: dropping a
   * database is at the mercy of every backend still attached to it, and the
   * default ten seconds is exactly the flakiness #47 describes — a teardown
   * that usually fits and occasionally does not.
   */
  afterAll(async () => {
    await handle?.close()
    await scratch?.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  /** The script, as a process, with nothing but the database in its way. */
  async function migrate(databaseUrl: string) {
    try {
      const { stdout, stderr } = await run(process.execPath, [SCRIPT], {
        env: { ...process.env, DATABASE_URL: databaseUrl },
      })
      return { code: 0, stdout, stderr }
    } catch (error) {
      const failure = error as { code?: number; stdout?: string; stderr?: string }
      return { code: failure.code ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' }
    }
  }

  /**
   * Puts the database back to just before `0010`: the constraints gone and the
   * journal row with them, so the migrator has the file left to apply.
   */
  async function rewindToBeforeTheConstraints() {
    for (const name of CONSTRAINTS) {
      await db.execute(sql.raw(`alter table users drop constraint if exists "${name}"`))
    }
    await db.execute(sql`
      delete from drizzle.__drizzle_migrations
       where id = (select max(id) from drizzle.__drizzle_migrations)
    `)
  }

  it('succeeds quietly against a database that is already up to date', async () => {
    const result = await migrate(scratch.url)

    expect(result.code).toBe(0)
    expect(result.stderr).not.toMatch(/Migration failed/)
  }, 60_000)

  it('applies what is missing', async () => {
    await rewindToBeforeTheConstraints()

    expect((await migrate(scratch.url)).code).toBe(0)

    const present = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
       where conrelid = 'users'::regclass and conname = 'users_role_known'
    `)
    expect(present).toHaveLength(1)
  }, 60_000)

  /*
   * The regression this script was written for. Every part of it matters to
   * somebody standing in front of a failed deployment: the reason, the rows to
   * go and correct, and what to do next.
   */
  it('tells the operator why a migration refused, and which rows', async () => {
    await rewindToBeforeTheConstraints()

    const inserted = await db.execute<{ id: string }>(sql`
      insert into users (email, display_name, role)
      values ('migrate-report@presslabz.test', 'Legacy', 'wizard')
      returning id
    `)
    const id = String(inserted[0]?.id)

    const journalBefore = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `)
    const journalRowsBeforeTheRefusal = journalBefore[0]?.count

    const result = await migrate(scratch.url)

    expect(result.code).not.toBe(0)
    // The message the migration raises...
    expect(result.stderr).toContain('outside the known vocabularies')
    // ...the DETAIL, which is the only place the rows are named...
    expect(result.stderr).toContain(id)
    expect(result.stderr).toContain('wizard')
    // ...and the HINT, which is the only place the next step is.
    expect(result.stderr).toMatch(/run this migration again/i)

    /*
     * Nothing was half-applied: the offending row is exactly as it was, none
     * of the three constraints arrived without the others, and the journal
     * does not claim `0010` ran. The migration is one transaction, so a
     * partial state here would mean the migrator stopped wrapping it in one —
     * which is precisely the kind of regression this suite exists to catch.
     */
    const after = await db.execute<{ role: string }>(sql`select role from users where id = ${id}`)
    expect(after[0]?.role).toBe('wizard')

    const constraints = await db.execute<{ conname: string }>(sql`
      select conname from pg_constraint
       where conrelid = 'users'::regclass and contype = 'c'
    `)
    expect(constraints).toHaveLength(0)

    const journalAfter = await db.execute<{ count: number }>(sql`
      select count(*)::int as count from drizzle.__drizzle_migrations
    `)
    expect(journalAfter[0]?.count).toBe(journalRowsBeforeTheRefusal)

    await db.execute(sql`delete from users where id = ${id}`)
    expect((await migrate(scratch.url)).code).toBe(0)
  }, 60_000)

  it('says what is missing rather than failing obscurely without a database', async () => {
    const result = await migrate('')

    // Both halves matter on their own: the diagnosis for the person reading,
    // and the non-zero exit for the `&&` in `db:upgrade`, which must not
    // carry on to the reconciliation as if the schema were in place.
    expect(result.code).not.toBe(0)
    expect(`${result.stdout}${result.stderr}`).toMatch(/DATABASE_URL is not set/)
  }, 60_000)
})
