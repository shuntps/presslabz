import { resolve } from 'node:path'

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
 * The name is fixed and the database is dropped and recreated each run, so a
 * suite that crashed halfway leaves nothing for the next one to trip over.
 */
export async function createScratchDatabase(name = 'presslabz_scratch'): Promise<{
  url: string
  drop: () => Promise<void>
}> {
  const source = process.env.DATABASE_URL
  if (!source) throw new Error('DATABASE_URL is required to create a scratch database')

  const { default: postgres } = await import('postgres')
  const { drizzle } = await import('drizzle-orm/postgres-js')
  const { migrate } = await import('drizzle-orm/postgres-js/migrator')

  const adminUrl = new URL(source)
  adminUrl.pathname = '/postgres'

  const admin = postgres(adminUrl.toString(), { max: 1 })
  try {
    // Identifiers cannot be parameterised, so the name is restricted instead.
    if (!/^[a-z][a-z0-9_]{0,62}$/.test(name)) throw new Error(`Unsafe database name "${name}"`)
    await admin.unsafe(`drop database if exists ${name} with (force)`)
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
