import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { ROLES } from '@presslabz/core'
import { LOCALES } from '@presslabz/i18n'
import { THEME_PREFERENCES } from '@presslabz/tokens/preferences'
import { sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createDb, type Database } from '../client.ts'
import {
  createScratchDatabase,
  hasIntegrationEnv,
  SCRATCH_TEARDOWN_TIMEOUT_MS,
} from '../testing.ts'
import {
  countUsers,
  createInitialAdministrator,
  createUser,
  findUserById,
  UserVocabularyError,
  updateUserPreferences,
} from './users.ts'

/*
 * Three closed vocabularies, guarded in two places on purpose.
 *
 * The repository refuses first, so a caller gets a named field instead of a
 * driver error. The CHECK constraints refuse last, and they are the ones that
 * matter: psql, a restore, a future repository, and the migration that runs
 * before any of this code is loaded all reach the table without passing
 * through the functions above.
 */

const ready = hasIntegrationEnv()

/** The migration that added the three constraints, as it will actually run. */
const MIGRATION = resolve(import.meta.dirname, '../../drizzle/0010_user_vocabulary_constraints.sql')

const CONSTRAINTS = {
  users_role_known: ROLES,
  users_locale_known: LOCALES,
  users_theme_preference_known: THEME_PREFERENCES,
} as const

describe.skipIf(!ready)('the user vocabularies', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let handle: ReturnType<typeof createDb>
  let db: Database
  let migration: string[]

  beforeAll(async () => {
    scratch = await createScratchDatabase('users')
    handle = createDb(scratch.url, { maxConnections: 5 })
    db = handle.db

    const file = await readFile(MIGRATION, 'utf8')
    migration = file
      .split('--> statement-breakpoint')
      .map((statement) => statement.trim())
      .filter((statement) => statement.length > 0)
  }, 60_000)

  afterAll(async () => {
    await handle.close()
    await scratch.drop()
  }, SCRATCH_TEARDOWN_TIMEOUT_MS)

  let seed = 0
  function uniqueEmail() {
    seed += 1
    return `vocab-${seed}@presslabz.test`
  }

  describe('the repository, before the database', () => {
    it.each(ROLES)('creates a user with the role %s', async (role) => {
      const created = await createUser(db, {
        email: uniqueEmail(),
        displayName: role,
        role,
        passwordHash: null,
      })
      expect(created.role).toBe(role)
    })

    it.each(LOCALES)('creates a user with the interface language %s', async (locale) => {
      const created = await createUser(db, {
        email: uniqueEmail(),
        displayName: locale,
        locale,
        passwordHash: null,
      })
      expect(created.locale).toBe(locale)
    })

    it.each(THEME_PREFERENCES)('creates a user preferring %s', async (themePreference) => {
      const created = await createUser(db, {
        email: uniqueEmail(),
        displayName: themePreference,
        themePreference,
        passwordHash: null,
      })
      expect(created.themePreference).toBe(themePreference)
    })

    /*
     * `as never` because the types already refuse this. That is the point: the
     * guard exists for the callers types cannot reach — a JSON body, a seed
     * script, a fixture — and a test that only proved the compiler refuses it
     * would prove nothing about them.
     */
    it('refuses an unknown role and writes nothing', async () => {
      const before = await countUsers(db)
      const email = uniqueEmail()

      await expect(
        createUser(db, {
          email,
          displayName: 'Nobody',
          role: 'superuser' as never,
          passwordHash: null,
        }),
      ).rejects.toThrow(UserVocabularyError)

      expect(await countUsers(db)).toBe(before)
    })

    it('names the field it refused over', async () => {
      const failure = await createUser(db, {
        email: uniqueEmail(),
        displayName: 'Nobody',
        locale: 'de' as never,
        passwordHash: null,
      }).catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(UserVocabularyError)
      expect((failure as UserVocabularyError).field).toBe('locale')
      expect((failure as UserVocabularyError).value).toBe('de')
    })

    it('bounds the value it reports', async () => {
      const failure = await createUser(db, {
        email: uniqueEmail(),
        displayName: 'Nobody',
        themePreference: 'x'.repeat(500) as never,
        passwordHash: null,
      }).catch((error: unknown) => error)

      const reported = (failure as UserVocabularyError).value
      expect(reported.length).toBeLessThanOrEqual(41)
      expect(reported.endsWith('…')).toBe(true)
    })

    it('refuses an unknown preference and leaves the stored one alone', async () => {
      const user = await createUser(db, {
        email: uniqueEmail(),
        displayName: 'Keeper',
        locale: 'fr',
        passwordHash: null,
      })

      await expect(updateUserPreferences(db, user.id, { locale: 'de' as never })).rejects.toThrow(
        UserVocabularyError,
      )

      expect((await findUserById(db, user.id))?.locale).toBe('fr')
    })

    it('accepts a preference change to a declared value', async () => {
      const user = await createUser(db, {
        email: uniqueEmail(),
        displayName: 'Changer',
        passwordHash: null,
      })

      await updateUserPreferences(db, user.id, { locale: 'fr', themePreference: 'dark' })

      const stored = await findUserById(db, user.id)
      expect(stored?.locale).toBe('fr')
      expect(stored?.themePreference).toBe('dark')
    })

    /*
     * The bootstrap chooses the role itself, so the only values a caller can
     * get wrong are the other two — and it must be told before the advisory
     * lock, not inside a transaction that then has to roll back.
     */
    it('refuses an unknown locale when bootstrapping', async () => {
      await expect(
        createInitialAdministrator(db, {
          email: uniqueEmail(),
          displayName: 'First',
          locale: 'de' as never,
          passwordHash: null,
        }),
      ).rejects.toThrow(UserVocabularyError)
    })
  })

  /**
   * Which constraint refused, from a driver error drizzle has wrapped.
   *
   * The wrapper's message is the failed query and its parameters, so a test
   * asserting on the message would pass for any failure at all — including a
   * typo in the statement it is asserting about. The constraint name lives on
   * the postgres error underneath.
   */
  async function violated(work: Promise<unknown>): Promise<string | undefined> {
    try {
      await work
      return undefined
    } catch (error) {
      const cause = (error as { cause?: { constraint_name?: string } }).cause
      return cause?.constraint_name
    }
  }

  describe('the constraints, against direct SQL', () => {
    /** What the repository cannot see: a write that never passes through it. */
    const insertDirectly = (values: Record<string, string>) =>
      db.execute(sql`
        insert into users (email, display_name, role, locale, theme_preference)
        values (
          ${uniqueEmail()},
          'Direct',
          ${values.role ?? 'subscriber'},
          ${values.locale ?? 'en'},
          ${values.themePreference ?? 'system'}
        )
      `)

    it.each(ROLES)('accepts the role %s', async (role) => {
      await expect(insertDirectly({ role })).resolves.toBeDefined()
    })

    it.each(LOCALES)('accepts the interface language %s', async (locale) => {
      await expect(insertDirectly({ locale })).resolves.toBeDefined()
    })

    it.each(THEME_PREFERENCES)('accepts the theme preference %s', async (themePreference) => {
      await expect(insertDirectly({ themePreference })).resolves.toBeDefined()
    })

    it.each([
      ['role', 'superuser', 'users_role_known'],
      ['locale', 'de', 'users_locale_known'],
      ['themePreference', 'auto', 'users_theme_preference_known'],
    ])('refuses %s = %s by %s', async (field, value, constraint) => {
      expect(await violated(insertDirectly({ [field]: value }))).toBe(constraint)
    })

    it('refuses an update that moves a row out of the vocabulary', async () => {
      const user = await createUser(db, {
        email: uniqueEmail(),
        displayName: 'Direct update',
        passwordHash: null,
      })

      expect(
        await violated(db.execute(sql`update users set role = 'root' where id = ${user.id}`)),
      ).toBe('users_role_known')

      expect((await findUserById(db, user.id))?.role).toBe('subscriber')
    })
  })

  /*
   * The lists in the code and the lists in the database are two copies of one
   * decision, written in two languages, and nothing but this test connects
   * them. A role added to `ROLES` without a migration is a value the product
   * offers and the database refuses — which reads as a bug in the interface.
   */
  describe('coherence between the code and the constraints', () => {
    it.each(Object.entries(CONSTRAINTS))(
      '%s allows exactly the declared values',
      async (name, declared) => {
        const rows = await db.execute<{ definition: string }>(sql`
          select pg_get_constraintdef(oid) as definition
          from pg_constraint
          where conrelid = 'users'::regclass and conname = ${name}
        `)

        const definition = rows[0]?.definition
        expect(definition, `${name} is not on the table`).toBeDefined()

        const allowed = [...String(definition).matchAll(/'([^']*)'/g)].map((match) => match[1])
        expect(new Set(allowed)).toEqual(new Set(declared))
      },
    )
  })

  describe('the migration', () => {
    /**
     * Puts the table back the way it was before 0010 ran, so the migration can
     * be applied again — against rows it has never seen.
     */
    async function withoutConstraints<T>(run: () => Promise<T>): Promise<T> {
      for (const name of Object.keys(CONSTRAINTS)) {
        await db.execute(sql.raw(`alter table users drop constraint if exists "${name}"`))
      }
      try {
        return await run()
      } finally {
        // Dropped again first: a test whose body applied the migration
        // successfully has already put them back, and ADD CONSTRAINT is not
        // idempotent.
        for (const name of Object.keys(CONSTRAINTS)) {
          await db.execute(sql.raw(`alter table users drop constraint if exists "${name}"`))
        }
        for (const statement of migration) {
          await db.execute(sql.raw(statement))
        }
      }
    }

    const apply = () =>
      db.transaction(async (tx) => {
        for (const statement of migration) await tx.execute(sql.raw(statement))
      })

    it('applies to data that is already inside the vocabularies', async () => {
      await withoutConstraints(async () => {
        await expect(apply()).resolves.toBeUndefined()
      })
    })

    it('refuses rather than repairing, and names the row and the field', async () => {
      let id = ''

      await withoutConstraints(async () => {
        const inserted = await db.execute<{ id: string }>(sql`
          insert into users (email, display_name, role, locale)
          values (${uniqueEmail()}, 'Legacy', 'superuser', 'de')
          returning id
        `)
        id = String(inserted[0]?.id)

        const failure = await apply().catch((error: unknown) => error)
        const message = `${(failure as Error).message} ${JSON.stringify(failure)}`

        // Both offending fields of the row, and the row itself.
        expect(message).toContain(id)
        expect(message).toContain('role')
        expect(message).toContain('locale')
        expect(message).toContain('superuser')

        // Not repaired, not deleted, not defaulted.
        const after = await db.execute<{ role: string; locale: string }>(
          sql`select role, locale from users where id = ${id}`,
        )
        expect(after[0]?.role).toBe('superuser')
        expect(after[0]?.locale).toBe('de')

        // And the constraints are not half-applied either.
        const present = await db.execute<{ conname: string }>(sql`
          select conname from pg_constraint
          where conrelid = 'users'::regclass and contype = 'c'
        `)
        expect(present.map((row) => row.conname)).toHaveLength(0)

        await db.execute(sql`delete from users where id = ${id}`)
      })
    })

    it('bounds a stored value it reports on', async () => {
      await withoutConstraints(async () => {
        const long = 'z'.repeat(300)
        await db.execute(sql`
          insert into users (email, display_name, role)
          values (${uniqueEmail()}, 'Verbose', ${long})
        `)

        const failure = await apply().catch((error: unknown) => error)
        const message = `${(failure as Error).message} ${JSON.stringify(failure)}`
        expect(message).toContain('z'.repeat(40))
        expect(message).not.toContain('z'.repeat(41))

        await db.execute(sql`delete from users where role = ${long}`)
      })
    })

    it('leaves the constraints in place and validated, never NOT VALID', async () => {
      const rows = await db.execute<{ conname: string; convalidated: boolean }>(sql`
        select conname, convalidated from pg_constraint
        where conrelid = 'users'::regclass and contype = 'c'
      `)

      expect(rows.map((row) => row.conname).sort()).toEqual(Object.keys(CONSTRAINTS).sort())
      expect(rows.every((row) => row.convalidated)).toBe(true)
    })
  })
})
