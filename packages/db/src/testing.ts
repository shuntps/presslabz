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
