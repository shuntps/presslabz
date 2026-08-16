import { countUsers, createDb, createUser, findUserByEmail } from '@presslabz/db'
import { hashPassword } from './auth/password.ts'
import { env } from './env.ts'

/**
 * Creates the first administrator. Refuses to run once any user exists, so it
 * can never be used to add a privileged account to a live installation.
 */
const email = process.env.SEED_ADMIN_EMAIL
const password = process.env.SEED_ADMIN_PASSWORD
const displayName = process.env.SEED_ADMIN_NAME ?? 'Administrator'

if (!email || !password) {
  throw new Error('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set')
}

if (password.length < 12) {
  throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters')
}

const { db, close } = createDb(env.DATABASE_URL, { maxConnections: 1 })

try {
  const existing = await countUsers(db)
  if (existing > 0) {
    const known = await findUserByEmail(db, email)
    console.warn(
      known
        ? `A user with ${email} already exists. Nothing to do.`
        : `${existing} user(s) already exist. Refusing to seed an administrator.`,
    )
    process.exitCode = existing > 0 && !known ? 1 : 0
  } else {
    const user = await createUser(db, {
      email,
      displayName,
      role: 'administrator',
      passwordHash: await hashPassword(password),
    })
    console.warn(`Created administrator ${user.email} (${user.id})`)
  }
} finally {
  await close()
}
