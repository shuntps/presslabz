import { execFileSync } from 'node:child_process'
import { Valkey } from 'iovalkey'
import postgres from 'postgres'
import {
  databaseUrl,
  E2E_ADMIN,
  E2E_DATABASE,
  E2E_DATABASE_URL,
  E2E_RATE_LIMIT_NAMESPACE,
  REPOSITORY_ROOT,
} from './database.ts'

/**
 * A database of its own, built from nothing, before the browser starts.
 *
 * These tests type into a real editor and press a real save, so they must not
 * run against the database somebody is working in: the first thing this suite
 * does to a document is change it. It builds `presslabz_e2e` instead — dropped
 * and recreated on every run, so a failed run leaves nothing to explain the
 * next one's failure — and the servers under test are pointed at it by
 * `playwright.config.ts`.
 *
 * The name is fixed rather than unique per run. Playwright's `webServer` is
 * declared statically, so the servers cannot be told about a name this script
 * invented; a fixed one needs no channel between the two processes. The cost
 * is that two runs on one machine collide, which is the same cost `pnpm dev`
 * already has.
 *
 * Everything here goes through the paths an installation goes through:
 * drizzle-kit for the schema, the API's own seed for the first administrator,
 * the demo seed for a translated pair. Inserting rows directly would be faster
 * and would test a database this product cannot actually produce.
 */

/** Runs a workspace script with the scratch database in its environment. */
function run(args: string[], env: Record<string, string> = {}): void {
  execFileSync('pnpm', args, {
    cwd: REPOSITORY_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: E2E_DATABASE_URL, ...env },
  })
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('The browser tests drop and rebuild a database, and refuse to run in production')
}

// `postgres` as the maintenance database: a connection cannot drop the
// database it is connected to.
const maintenance = postgres(databaseUrl('postgres'), { max: 1 })

try {
  // FORCE, because a previous run's server may still hold a connection and a
  // suite that cannot clean up after itself is one that fails tomorrow for
  // yesterday's reason.
  await maintenance.unsafe(`drop database if exists "${E2E_DATABASE}" with (force)`)
  await maintenance.unsafe(`create database "${E2E_DATABASE}"`)
  console.warn(`Rebuilt ${E2E_DATABASE}.`)
} finally {
  await maintenance.end({ timeout: 5 })
}

run(['--filter', '@presslabz/db', 'migrate'])

run(['--filter', '@presslabz/api', 'seed'], {
  SEED_ADMIN_EMAIL: E2E_ADMIN.email,
  SEED_ADMIN_PASSWORD: E2E_ADMIN.password,
  SEED_ADMIN_NAME: E2E_ADMIN.name,
})

// Hello world and Bonjour le monde: one piece of work in two languages, which
// is what the navigation these tests exist for moves between.
run(['--filter', '@presslabz/api', 'seed:demo'], { SEED_ADMIN_EMAIL: E2E_ADMIN.email })

/*
 * Two images, through the real pipeline and into the real bucket, and
 * deliberately without alt text: an undescribed asset is what left the picker
 * with buttons a screen reader could not tell apart, so the accessibility scan
 * needs some. No posts — this seed's job here is the library.
 */
run(['--filter', '@presslabz/api', 'seed:bulk'], {
  SEED_ADMIN_EMAIL: E2E_ADMIN.email,
  SEED_POSTS: '0',
  SEED_IMAGES: '2',
})

/*
 * And then take the descriptions away. The seed writes alt text because a
 * fixture should be exemplary; the accessibility scan needs the ordinary case,
 * where nobody wrote any — which is what left the picker with a grid of
 * buttons a screen reader could not tell apart.
 */
const scratch = postgres(E2E_DATABASE_URL, { max: 1 })
try {
  await scratch.unsafe(`update media set alt = '{}'::jsonb`)
} finally {
  await scratch.end({ timeout: 5 })
}

/*
 * The counters go with the database, because they are as much this run's state
 * as the rows are. Sign-in is limited to ten attempts in fifteen minutes —
 * a rule worth keeping, and one that answered 429 to the third run of the
 * afternoon until this ran. Only keys under this run's own prefix are removed:
 * never a FLUSHDB, which would delete what belongs to somebody else.
 */
const valkey = new Valkey(process.env.VALKEY_URL ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: 1,
})
valkey.on('error', () => {})

try {
  let cursor = '0'
  let removed = 0

  do {
    const [next, keys] = await valkey.scan(
      cursor,
      'MATCH',
      `${E2E_RATE_LIMIT_NAMESPACE}*`,
      'COUNT',
      200,
    )
    cursor = next
    if (keys.length > 0) removed += await valkey.del(...keys)
  } while (cursor !== '0')

  if (removed > 0) console.warn(`Cleared ${removed} rate-limit keys from a previous run.`)
} finally {
  valkey.disconnect()
}
