import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createScratchDatabase,
  databaseExists,
  hasIntegrationEnv,
  isScratchDatabaseName,
  SCRATCH_PREFIX,
} from './testing.ts'

/*
 * The scratch helper's own contract: a failure after CREATE DATABASE must not
 * leave the database behind.
 *
 * The window is real. The handle carrying `drop` is the last thing
 * `createScratchDatabase` does, so a caller whose creation failed mid-way has
 * nothing to clean up with — every leaked database in that window is the
 * helper's, and until #46 the helper leaked it: a failing migration closed
 * its clients and walked away from the database it had just created, leaving
 * it for the hourly sweep. A migration that refuses on purpose, like 0010
 * over rows outside the vocabularies, makes this an ordinary path rather than
 * a corner.
 */
const ready = hasIntegrationEnv()

/**
 * A migrations folder whose single migration fails after doing real work.
 * Built from scratch in a temporary directory so the real folder is never
 * involved.
 */
async function brokenMigrations(): Promise<{ folder: string; discard: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), 'presslabz-broken-migrations-'))
  const discard = () => rm(folder, { recursive: true, force: true })

  // The caller only receives `discard` if this returns; until then the folder
  // is this function's, including when its own preparation fails.
  try {
    await writeFile(
      join(folder, '0000_boom.sql'),
      '-- Real work first, so the failure lands on a database that is no longer empty.\n' +
        'CREATE TABLE boom (id integer);--> statement-breakpoint\n' +
        'SELECT 1 / 0;\n',
    )
    await mkdir(join(folder, 'meta'))
    await writeFile(
      join(folder, 'meta', '_journal.json'),
      JSON.stringify({
        version: '7',
        dialect: 'postgresql',
        entries: [
          { idx: 0, version: '7', when: 1787400000000, tag: '0000_boom', breakpoints: true },
        ],
      }),
    )
  } catch (preparationFailure) {
    const failures: unknown[] = [preparationFailure]
    await discard().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw preparationFailure
    throw new AggregateError(
      failures,
      'preparing the broken migrations failed, and so did removing them',
    )
  }

  return { folder, discard }
}

describe.skipIf(!ready)('the scratch database helper', () => {
  it('does not leave the database behind when its migration fails', async () => {
    /*
     * Pid **and** six random hex characters — a fixed length, unlike an
     * unpadded base-36 value: two machines sharing one PostgreSQL, a reused
     * pid, and two separate runs can all collide on a pid alone. What the
     * assertions check is honestly a **prefix**, not an exact name — the
     * helper appends its own suffix and never returns it on rejection — but
     * a prefix nothing else on this server has ever created, so "empty"
     * means "this attempt left nothing" and cannot mean anything else. Short
     * enough (well under the 63-byte identifier cap, suffix included) that
     * the generated name is never truncated into a different prefix.
     */
    const label = `doomed${process.pid.toString(36)}${randomUUID().slice(0, 6)}`
    const prefix = `${SCRATCH_PREFIX}${label}_`
    const { folder, discard } = await brokenMigrations()

    /*
     * The assertions run first and the safety net second, in separate
     * failure slots: removing the helper's cleanup must turn this test red
     * on the assertion — observed **before** the net sweeps the evidence —
     * and the red run must still leave no database for the hourly sweep. A
     * net that also fails is kept beside the assertion failure, never in
     * front of it.
     */
    const failures: unknown[] = []

    try {
      const attempt = createScratchDatabase(label, { migrationsFolder: folder })

      /*
       * The migration failure itself, with its identity intact: the cleanup
       * succeeded, so nothing was added in front of it.
       */
      await expect(attempt).rejects.toThrow(/division by zero|1 \/ 0/)

      const leftovers = await scratchDatabasesMatching(prefix)
      expect(leftovers).toEqual([])
    } catch (error) {
      failures.push(error)
    }

    try {
      for (const leftover of await scratchDatabasesMatching(prefix)) {
        await dropByExactName(leftover)
      }
    } catch (error) {
      failures.push(error)
    }
    try {
      await discard()
    } catch (error) {
      failures.push(error)
    }

    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'the test failed, and its own cleanup failed too')
    }
  }, 60_000)

  it('matches its prefix literally, never as a LIKE pattern', async () => {
    /*
     * `presslabz_scratch_` is full of `_`, which in a LIKE pattern matches
     * any character — so a LIKE-based listing would also select names that
     * only rhyme with the prefix, and the listing feeds a destructive net.
     * One real database proves the comparison is literal: a prefix that
     * differs from its name only where a LIKE `_` would have matched must
     * select nothing.
     *
     * The label carries the same per-attempt uniqueness as the test above —
     * a fixed literal `0` at a controlled position, then pid and six random
     * hex characters — so two runs sharing one PostgreSQL cannot see each
     * other's database and fail this test without a defect. Both prefixes
     * below keep the unique component identical; only the `0` differs.
     */
    const unique = `${process.pid.toString(36)}${randomUUID().slice(0, 6)}`
    const scratch = await createScratchDatabase(`wild0${unique}`)
    const failures: unknown[] = []

    try {
      // The literal prefix finds exactly this attempt's database...
      expect(await scratchDatabasesMatching(`${SCRATCH_PREFIX}wild0${unique}_`)).toEqual([
        scratch.name,
      ])
      // ...and the same prefix with `_` where the name has `0` — a match for
      // LIKE, not for a literal comparison — finds nothing.
      expect(await scratchDatabasesMatching(`${SCRATCH_PREFIX}wild_${unique}_`)).toEqual([])
    } catch (error) {
      failures.push(error)
    }

    try {
      await scratch.drop()
    } catch (error) {
      failures.push(error)
    }

    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) {
      throw new AggregateError(failures, 'the test failed, and its own cleanup failed too')
    }
  }, 60_000)

  it('still hands over a working database when nothing fails', async () => {
    // The counterpart that keeps the first test honest: same helper, same
    // call shape, real migrations — and the drop leaves nothing either.
    const scratch = await createScratchDatabase('helper-roundtrip')
    try {
      expect(await databaseExists(scratch.name)).toBe(true)
    } finally {
      await scratch.drop()
    }
    expect(await databaseExists(scratch.name)).toBe(false)
  }, 60_000)
})

/**
 * Drops one database by exact name — the safety net's tool, so a red run of
 * the test above does not leave its witness sitting for the hourly sweep.
 * Guarded by the same validation the helper and the sweeper use — one
 * invariant, not a diverging copy — because an identifier cannot be
 * parameterised.
 */
async function dropByExactName(name: string): Promise<void> {
  if (!isScratchDatabaseName(name)) {
    throw new Error(`Refusing to drop "${name}": not a scratch database name`)
  }

  const source = process.env.DATABASE_URL as string
  const adminUrl = new URL(source)
  adminUrl.pathname = '/postgres'

  const { default: postgres } = await import('postgres')
  const admin = postgres(adminUrl.toString(), { max: 1 })

  const failures: unknown[] = []
  try {
    await admin.unsafe(`drop database if exists ${name} with (force)`)
  } catch (error) {
    failures.push(error)
  }
  try {
    await admin.end({ timeout: 5 })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, `dropping ${name} failed, and so did closing the connection`)
  }
}

/** Every scratch database whose name starts with exactly this prefix. */
async function scratchDatabasesMatching(prefix: string): Promise<string[]> {
  const source = process.env.DATABASE_URL as string
  const adminUrl = new URL(source)
  adminUrl.pathname = '/postgres'

  const { default: postgres } = await import('postgres')
  const admin = postgres(adminUrl.toString(), { max: 1 })

  // Both failures kept, like every admin helper here: a failing end() must
  // not replace the query's own error.
  const failures: unknown[] = []
  let names: string[] = []
  try {
    /*
     * starts_with, never LIKE: in a LIKE pattern `_` matches any single
     * character, and this prefix is full of underscores — so the raw prefix
     * as a pattern would also select names that merely rhyme with it, and
     * this function feeds a destructive safety net. starts_with compares
     * literally.
     */
    const rows = await admin`
      select datname from pg_database where starts_with(datname, ${prefix})
    `
    names = rows.map((row) => String(row.datname))
  } catch (error) {
    failures.push(error)
  }
  try {
    await admin.end({ timeout: 5 })
  } catch (error) {
    failures.push(error)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      'listing scratch databases failed, and so did closing the connection',
    )
  }
  return names
}
