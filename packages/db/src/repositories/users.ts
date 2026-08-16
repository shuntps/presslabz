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
