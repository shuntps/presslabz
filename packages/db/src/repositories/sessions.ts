import { and, eq, gt, lt } from 'drizzle-orm'
import type { Database } from '../client.ts'
import { sessions, users } from '../schema/users.ts'
import type { UserRow } from './users.ts'

export interface SessionWithUser {
  sessionId: string
  expiresAt: Date
  user: UserRow
}

/**
 * `id` is the hash of the session token, never the token itself. Read access
 * to this table therefore does not let anyone impersonate a session.
 */
export async function createSession(
  db: Database,
  tokenHash: string,
  userId: string,
  expiresAt: Date,
): Promise<void> {
  await db.insert(sessions).values({ id: tokenHash, userId, expiresAt })
}

export async function findValidSession(
  db: Database,
  tokenHash: string,
): Promise<SessionWithUser | null> {
  const rows = await db
    .select({ id: sessions.id, expiresAt: sessions.expiresAt, user: users })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, tokenHash), gt(sessions.expiresAt, new Date())))
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return { sessionId: row.id, expiresAt: row.expiresAt, user: row.user }
}

export async function extendSession(
  db: Database,
  tokenHash: string,
  expiresAt: Date,
): Promise<void> {
  await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, tokenHash))
}

export async function deleteSession(db: Database, tokenHash: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, tokenHash))
}

/** Signing out everywhere, and the only correct response to a password change. */
export async function deleteSessionsForUser(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId))
}

/**
 * Removes every session whose lifetime is over.
 *
 * Retention is the session's own TTL plus at most one sweep interval: the
 * sweep is periodic, so a row that expires a minute after one runs waits for
 * the next. An expired session grants nothing in the meantime — every lookup
 * filters on expiry — but a record of who was signed in and when is not
 * something to keep for longer than it takes to notice.
 * `sessions_expires_idx` is what makes the sweep a range scan rather than a
 * table scan.
 *
 * Returns how many went, so a caller can say whether it did anything.
 */
export async function deleteExpiredSessions(db: Database, now: Date = new Date()): Promise<number> {
  const removed = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id })

  return removed.length
}
