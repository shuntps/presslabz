import { isRole } from '@presslabz/core'
import { isLocale, type Locale } from '@presslabz/i18n'
import { isThemePreference, type ThemePreference } from '@presslabz/tokens/preferences'
import { eq, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { users } from '../schema/users.ts'

export type UserRow = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

/** The three columns whose values come from a closed vocabulary. */
export type VocabularyField = 'role' | 'locale' | 'themePreference'

/**
 * A value outside the vocabulary its column is allowed to hold.
 *
 * The database refuses the same values — `users_role_known` and its two
 * siblings — so this class is not what protects the table. It is what turns
 * the refusal into something a caller can act on: a named field, before the
 * statement is built, instead of a driver error naming a constraint.
 */
export class UserVocabularyError extends Error {
  readonly field: VocabularyField
  /** Bounded: enough to recognise the value, not enough to be a payload. */
  readonly value: string

  constructor(field: VocabularyField, value: string) {
    const bounded = value.length > 40 ? `${value.slice(0, 40)}…` : value
    super(`${field} is not a value this build declares: ${JSON.stringify(bounded)}`)
    this.name = 'UserVocabularyError'
    this.field = field
    this.value = bounded
  }
}

/**
 * Refuses an unknown role, locale or theme preference before the insert.
 *
 * The types already say this much, and the CHECK constraints say it again at
 * the other end. This is for the callers types cannot reach: a JSON body, a
 * seed script, a fixture written in a hurry. `undefined` passes — it means the
 * column keeps its default — while `null` does not, because these columns are
 * NOT NULL and a caller that meant to clear one is mistaken about the column.
 */
export function assertKnownVocabulary(values: {
  role?: unknown
  locale?: unknown
  themePreference?: unknown
}): void {
  if (values.role !== undefined && !isRole(values.role)) {
    throw new UserVocabularyError('role', String(values.role))
  }
  if (values.locale !== undefined && !isLocale(values.locale)) {
    throw new UserVocabularyError('locale', String(values.locale))
  }
  if (values.themePreference !== undefined && !isThemePreference(values.themePreference)) {
    throw new UserVocabularyError('themePreference', String(values.themePreference))
  }
}

/**
 * Email lookup is case-insensitive, matching the `users_email_lower_uq`
 * index. Comparing raw values here would let two accounts share an address
 * that the database considers identical.
 */
export async function findUserByEmail(db: Database, email: string): Promise<UserRow | null> {
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`)
    .limit(1)

  return rows[0] ?? null
}

export async function findUserById(db: Database, id: string): Promise<UserRow | null> {
  const rows = await db.select().from(users).where(eq(users.id, id)).limit(1)
  return rows[0] ?? null
}

export async function createUser(db: Database, user: NewUser): Promise<UserRow> {
  assertKnownVocabulary(user)

  const rows = await db.insert(users).values(user).returning()
  const created = rows[0]
  if (!created) throw new Error('Insert returned no row')
  return created
}

export async function listUsers(db: Database, limit = 50): Promise<UserRow[]> {
  return db.select().from(users).orderBy(users.createdAt).limit(limit)
}

export async function countUsers(db: Database): Promise<number> {
  const rows = await db.select({ count: sql<number>`count(*)::int` }).from(users)
  return rows[0]?.count ?? 0
}

export async function updateUserPreferences(
  db: Database,
  id: string,
  preferences: { locale?: Locale | undefined; themePreference?: ThemePreference | undefined },
): Promise<void> {
  assertKnownVocabulary(preferences)

  await db
    .update(users)
    .set({ ...preferences, updatedAt: new Date() })
    .where(eq(users.id, id))
}

/**
 * A Postgres advisory lock key. Arbitrary but fixed: two processes bootstrapping
 * at once must pick the same number or the lock protects nothing.
 */
const BOOTSTRAP_LOCK = 8_315_002_026n

export interface BootstrapResult {
  readonly created: UserRow | null
  /** How many users already existed. Zero only when this call created the first. */
  readonly existing: number
}

/**
 * Creates the first administrator, or refuses because there already is one.
 *
 * The check and the insert are one transaction behind an advisory lock. A
 * plain `count() === 0` followed by an insert is a race: at READ COMMITTED two
 * processes both read an empty table before either commits, and a fresh
 * installation ends up with two initial administrators — the account that is
 * least likely to be noticed and most costly to have twice. `INSERT ... WHERE
 * NOT EXISTS` does not close it either, because the subquery reads the same
 * pre-commit snapshot. A lock does: the second transaction waits, then sees
 * the first one's row and declines.
 *
 * The lock is transaction-scoped, so it is released by commit or rollback and
 * cannot be leaked by a process that dies mid-bootstrap.
 */
export async function createInitialAdministrator(
  db: Database,
  /*
   * The role is not among these. A caller cannot ask this function for a
   * subscriber: the one account it exists to create is the administrator, and
   * a parameter that could say otherwise is a signature that lies about what
   * the code below does.
   */
  user: Omit<NewUser, 'role'>,
): Promise<BootstrapResult> {
  // The role is this function's to choose; the other two still arrive from a
  // caller, and the advisory lock below is a poor place to discover one is bad.
  assertKnownVocabulary(user)

  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${BOOTSTRAP_LOCK})`)

    const counted = await tx.select({ count: sql<number>`count(*)::int` }).from(users)
    const existing = counted[0]?.count ?? 0
    if (existing > 0) return { created: null, existing }

    const rows = await tx
      .insert(users)
      .values({ ...user, role: 'administrator' })
      .returning()
    const created = rows[0]
    if (!created) throw new Error('Insert returned no row')
    return { created, existing: 0 }
  })
}
