import { ROLES, type Role } from '@presslabz/core'
import { LOCALES, type Locale } from '@presslabz/i18n'
import { THEME_PREFERENCES, type ThemePreference } from '@presslabz/tokens/preferences'
import { sql } from 'drizzle-orm'
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './shared.ts'

/**
 * A CHECK over a text column rather than a Postgres enum.
 *
 * Measured on the PostgreSQL this project runs, 18.6, rather than recalled:
 * `ALTER TYPE ... ADD VALUE` *does* run inside a transaction block and *is*
 * undone by a rollback. What it cannot do is be used before that transaction
 * commits — `select 'grand'::mood` in the transaction that added `grand`
 * fails with "unsafe use of new value" — so widening a vocabulary and
 * backfilling rows to the new value cannot be one migration. And there is no
 * way back: `ALTER TYPE ... DROP VALUE` answers "dropping an enum value is not
 * implemented", so a member added by mistake is permanent short of recreating
 * the type and every column that uses it. A named CHECK is one ordinary
 * statement in each direction.
 *
 * The list is built from the constant, so a role added in `@presslabz/core`
 * and not reflected here shows up as snapshot drift the next `generate`
 * reports, rather than as a value the database silently keeps refusing.
 *
 * `sql.raw` and not a parameter: drizzle-kit serialises a check into DDL,
 * where `${'a'}` becomes the literal text `$1` — measured, not assumed. What
 * makes it safe is not the escaping below but the source: these are string
 * literals from three `as const` arrays in this repository, never a value that
 * arrived from outside. A member that could need escaping is a mistake in the
 * vocabulary, so it stops the build instead of being quietly quoted.
 */
function oneOf(column: unknown, values: readonly string[]) {
  const list = values
    .map((value) => {
      if (!/^[a-z][a-z0-9-]*$/.test(value)) {
        throw new Error(`Vocabulary member is not a plain identifier: ${JSON.stringify(value)}`)
      }
      return `'${value}'`
    })
    .join(', ')

  return sql`${column} in (${sql.raw(list)})`
}

/**
 * The role is a stored label; what the system checks is the capability bundle
 * `capabilitiesFor` derives from it. No code outside
 * `packages/core/src/capabilities.ts` branches on the role itself.
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    passwordHash: text(),
    displayName: text().notNull(),
    role: text().$type<Role>().notNull().default('subscriber'),
    /** Admin interface language. Content locale is a separate concept. */
    locale: text().$type<Locale>().notNull().default('en'),
    /** 'light' | 'dark' | 'system' — resolved by packages/tokens. */
    themePreference: text().$type<ThemePreference>().notNull().default('system'),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`),
    check('users_role_known', oneOf(t.role, ROLES)),
    check('users_locale_known', oneOf(t.locale, LOCALES)),
    check('users_theme_preference_known', oneOf(t.themePreference, THEME_PREFERENCES)),
  ],
)

export const sessions = pgTable(
  'sessions',
  {
    /** Hash of the session token. The token itself is never stored. */
    id: text().primaryKey(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expires_idx').on(t.expiresAt)],
)
