import { sql } from 'drizzle-orm'
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './shared.ts'

/**
 * Roles are a placeholder until phase 1 introduces the capability model.
 * Capabilities, not roles, will be what the rest of the system checks.
 */
export const users = pgTable(
  'users',
  {
    id: uuid().primaryKey().defaultRandom(),
    email: text().notNull(),
    passwordHash: text(),
    displayName: text().notNull(),
    role: text().notNull().default('subscriber'),
    /** Admin interface language. Content locale is a separate concept. */
    locale: text().notNull().default('en'),
    /** 'light' | 'dark' | 'system' — resolved by packages/tokens. */
    themePreference: text().notNull().default('system'),
    ...timestamps,
  },
  (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)],
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
