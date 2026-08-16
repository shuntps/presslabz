import { eq, sql } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { users } from '../schema/users.ts'

export type UserRow = typeof users.$inferSelect
export type NewUser = typeof users.$inferInsert

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
  preferences: { locale?: string | undefined; themePreference?: string | undefined },
): Promise<void> {
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
