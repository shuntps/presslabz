import { createDb, createInitialAdministrator, findUserByEmail } from '@presslabz/db'
import { hashPassword } from '../../src/auth/password.ts'
import { env } from '../../src/env.ts'

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
  /*
   * The password is hashed before the lock is taken. Argon2id at the OWASP
   * baseline is deliberately slow, and holding a database lock across it would
   * make two concurrent runs wait on work neither of them needs.
   */
  const passwordHash = await hashPassword(password)

  const { created, existing } = await createInitialAdministrator(db, {
    email,
    displayName,
    passwordHash,
  })

  if (created) {
    console.warn(`Created administrator ${created.email} (${created.id})`)
  } else {
    /*
     * Refusing here is what stops the seed variables reintroducing an account
     * on a live installation: they may stay in the environment after install,
     * and running this again must never be a way back in.
     */
    const known = await findUserByEmail(db, email)
    console.warn(
      known
        ? `A user with ${email} already exists. Nothing to do.`
        : `${existing} user(s) already exist. Refusing to seed an administrator.`,
    )
    process.exitCode = known ? 0 : 1
  }
} finally {
  await close()
}
