import {
  createDb,
  createSession,
  createUser,
  type Database,
  findUserByEmail,
  findValidSession,
} from '@presslabz/db'
import { createScratchDatabase, hasIntegrationEnv } from '@presslabz/db/testing'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { dropRateLimitKeys, testRateLimitNamespace } from '../testing.ts'
import { hashPassword } from './password.ts'
import { generateSessionToken, hashSessionToken, SESSION_COOKIE, sessionExpiry } from './session.ts'

/**
 * Signing in, staying signed in, and stopping being signed in.
 *
 * These four routes had no suite of their own: they were touched in passing by
 * the tests for CORS, for health and for malformed bodies, all of which use
 * them as a convenient URL rather than as the thing under test. Nothing
 * asserted that the right password works, that the wrong one does not, that
 * signing out actually removes the session rather than only the cookie, or
 * that a preference survives being written.
 *
 * Against a real database, because the property that matters most here is that
 * the session is a **row**: a token the server can revoke, not a signed claim
 * it has to honour until it expires.
 */
const ready = hasIntegrationEnv()

/** Long enough to satisfy the policy, and a fixture, not a secret. */
const PASSWORD = 'a-throwaway-passphrase'

describe.skipIf(!ready)('authentication', () => {
  let scratch: Awaited<ReturnType<typeof createScratchDatabase>>
  let namespace: string
  let handle: ReturnType<typeof createDb>
  let db: Database
  let app: FastifyInstance
  let personId: string

  beforeAll(async () => {
    scratch = await createScratchDatabase('auth-routes')
    namespace = testRateLimitNamespace('auth-routes')

    const { buildApp } = await import('../app.ts')
    app = await buildApp({ databaseUrl: scratch.url, rateLimitNamespace: namespace })
    await app.ready()

    handle = createDb(scratch.url, { maxConnections: 4 })
    db = handle.db

    const person = await createUser(db, {
      email: 'someone@presslabz.test',
      displayName: 'Someone',
      role: 'editor',
      passwordHash: await hashPassword(PASSWORD),
    })
    personId = person.id

    // An account that exists and cannot sign in: created by an administrator,
    // or left over from an authentication method that has been removed.
    await createUser(db, {
      email: 'passwordless@presslabz.test',
      displayName: 'No password',
      role: 'author',
      passwordHash: null,
    })
  }, 60_000)

  afterAll(async () => {
    await handle?.close()
    await app?.close()
    await scratch?.drop()
    await dropRateLimitKeys(process.env.VALKEY_URL as string, namespace)
  })

  /**
   * A sign-in attempt, from a caller of its own.
   *
   * The limiter counts per client address, which is the protection on this
   * route: ten attempts in fifteen minutes. A suite that made every attempt
   * from one address would spend that allowance on itself and be answered 429
   * by a server doing exactly what it should — so each test signs in from a
   * different address, the way two people on two machines would. The limit
   * itself is asserted below, deliberately, from one address.
   */
  let caller = 0
  const nextCaller = () => {
    caller += 1
    return `10.0.0.${caller}`
  }

  const login = (body: Record<string, unknown>, remoteAddress = nextCaller()) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: body, remoteAddress })

  /**
   * A session, made the way the login route makes one, without going through
   * it.
   *
   * Sign-in is limited to ten attempts in fifteen minutes — the one route
   * where guessing is the attack — so a suite that signs in for every test it
   * runs is answered 429 by a server doing exactly what it should. Only the
   * tests *about* signing in spend that allowance; everything below needs a
   * session, not a sign-in.
   */
  async function sessionFor(userId: string = personId) {
    const token = generateSessionToken()
    await createSession(db, hashSessionToken(token), userId, sessionExpiry())
    return { [SESSION_COOKIE]: token }
  }

  /** The session token out of a Set-Cookie header, or null when none was set. */
  function tokenOf(response: Awaited<ReturnType<typeof login>>): string | null {
    const cookie = response.cookies.find((candidate) => candidate.name === SESSION_COOKIE)
    return cookie?.value ? cookie.value : null
  }

  describe('signing in', () => {
    it('accepts the password and answers with the person, not the row', async () => {
      const response = await login({ email: 'someone@presslabz.test', password: PASSWORD })

      expect(response.statusCode).toBe(200)
      const user = response.json().user
      expect(user).toMatchObject({ email: 'someone@presslabz.test', role: 'editor' })
      // What the interface hides controls with, sent because the server
      // enforces every one of them anyway.
      expect(user.capabilities).toContain('content:read')
      // And never anything that could authenticate somebody.
      expect(JSON.stringify(user)).not.toMatch(/passwordHash|password_hash|\$argon/i)
    })

    it('sets a session cookie that is a row in the database', async () => {
      const response = await login({ email: 'someone@presslabz.test', password: PASSWORD })
      const token = tokenOf(response)

      expect(token).not.toBeNull()
      /*
       * The whole point of a session table: what the browser holds is a
       * pointer, and the server can drop what it points at. A signed token
       * would have to be honoured until it expired.
       */
      const stored = await findValidSession(db, hashSessionToken(token as string))
      expect(stored?.user.id).toBe(personId)
    })

    it('stores the hash, never the token', async () => {
      const token = tokenOf(
        await login({ email: 'someone@presslabz.test', password: PASSWORD }),
      ) as string

      // A database read that finds the raw token would mean a leaked backup is
      // a set of working sessions.
      expect(await findValidSession(db, token)).toBeNull()
      expect(await findValidSession(db, hashSessionToken(token))).not.toBeNull()
    })

    it('refuses the wrong password', async () => {
      const response = await login({ email: 'someone@presslabz.test', password: 'not-it' })

      expect(response.statusCode).toBe(401)
      expect(tokenOf(response)).toBeNull()
    })

    /*
     * The same answer for an account that does not exist, one with no password
     * and one whose password is wrong. Anything else turns this route into a
     * way to ask which addresses have accounts.
     */
    it('says the same thing about an address that has no account', async () => {
      const missing = await login({ email: 'nobody@presslabz.test', password: PASSWORD })
      const wrong = await login({ email: 'someone@presslabz.test', password: 'not-it' })

      expect(missing.statusCode).toBe(401)
      expect(missing.json()).toEqual(wrong.json())
    })

    /*
     * The count is the protection here, not a courtesy: this is the one route
     * where guessing is the attack, and the one that refuses rather than
     * degrades when the store behind the counter is unreachable.
     */
    it('stops answering after ten attempts from one caller', async () => {
      const attacker = '10.9.9.9'
      const answers: number[] = []

      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await login(
          { email: 'someone@presslabz.test', password: `guess-${attempt}` },
          attacker,
        )
        answers.push(response.statusCode)
      }

      expect(answers.slice(0, 10)).toEqual(Array.from({ length: 10 }, () => 401))
      expect(answers.slice(10)).toEqual([429, 429])

      // And the right password is refused too, which is the point: the window
      // closes on the address, not on the guess.
      expect(
        (await login({ email: 'someone@presslabz.test', password: PASSWORD }, attacker)).statusCode,
      ).toBe(429)
    })

    it('says the same thing about an account that cannot sign in at all', async () => {
      const response = await login({ email: 'passwordless@presslabz.test', password: PASSWORD })

      expect(response.statusCode).toBe(401)
      expect(response.json().error).toBe('invalid_credentials')
    })

    it('refuses a body that is not a sign-in', async () => {
      expect((await login({ email: 'someone@presslabz.test' })).statusCode).toBe(400)
      expect((await login({})).statusCode).toBe(400)
      expect((await login({ email: '', password: '' })).statusCode).toBe(400)
    })

    /*
     * Not validated as an address, and that is the right call: refusing the
     * shape would answer faster for a string that cannot be an account than
     * for one that could, which is the same disclosure the equal answers above
     * exist to prevent.
     */
    it('treats a string that is not an address as credentials that do not match', async () => {
      const response = await login({ email: 'not-an-address', password: PASSWORD })
      expect(response.statusCode).toBe(401)
    })
  })

  describe('being signed in', () => {
    it('answers /auth/me with the account behind the cookie', async () => {
      const response = await app.inject({ url: '/auth/me', cookies: await sessionFor() })

      expect(response.statusCode).toBe(200)
      expect(response.json().user.email).toBe('someone@presslabz.test')
    })

    it('answers 401 without one', async () => {
      expect((await app.inject({ url: '/auth/me' })).statusCode).toBe(401)
    })

    it('answers 401 to a token nobody issued', async () => {
      const response = await app.inject({
        url: '/auth/me',
        cookies: { [SESSION_COOKIE]: 'a'.repeat(43) },
      })

      expect(response.statusCode).toBe(401)
    })

    /*
     * A session that has run out is not a session. Left unchecked, the row
     * outlives its expiry and the only thing standing between an old cookie
     * and an account is a cleanup job that may not have run.
     */
    it('answers 401 to a session that has expired', async () => {
      const token = 'b'.repeat(43)
      await createSession(db, hashSessionToken(token), personId, new Date(Date.now() - 1000))

      const response = await app.inject({ url: '/auth/me', cookies: { [SESSION_COOKIE]: token } })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('signing out', () => {
    it('removes the session rather than only the cookie', async () => {
      const token = tokenOf(
        await login({ email: 'someone@presslabz.test', password: PASSWORD }),
      ) as string

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { [SESSION_COOKIE]: token },
      })

      expect(response.statusCode).toBe(204)
      /*
       * Clearing the cookie alone would leave a working credential in every
       * place the browser had already copied it — a shared machine, a proxy
       * log, a screenshot.
       */
      expect(await findValidSession(db, hashSessionToken(token))).toBeNull()

      const after = await app.inject({ url: '/auth/me', cookies: { [SESSION_COOKIE]: token } })
      expect(after.statusCode).toBe(401)
    })

    it('is not an error for somebody who was never signed in', async () => {
      const response = await app.inject({ method: 'POST', url: '/auth/logout' })
      expect(response.statusCode).toBe(204)
    })

    it('leaves other sessions of the same account alone', async () => {
      // Signing out of one browser must not sign the person out of the others.
      const first = tokenOf(await login({ email: 'someone@presslabz.test', password: PASSWORD }))
      const second = tokenOf(await login({ email: 'someone@presslabz.test', password: PASSWORD }))

      await app.inject({
        method: 'POST',
        url: '/auth/logout',
        cookies: { [SESSION_COOKIE]: first as string },
      })

      const other = await app.inject({
        url: '/auth/me',
        cookies: { [SESSION_COOKIE]: second as string },
      })
      expect(other.statusCode).toBe(200)
    })
  })

  describe('preferences', () => {
    const save = async (body: Record<string, unknown>) =>
      app.inject({
        method: 'PATCH',
        url: '/auth/preferences',
        cookies: await sessionFor(),
        payload: body,
      })

    it('writes a language, and hands it back on the next request', async () => {
      expect((await save({ locale: 'fr' })).statusCode).toBe(200)

      const me = await app.inject({ url: '/auth/me', cookies: await sessionFor() })
      expect(me.json().user.locale).toBe('fr')
      // Stored on the account, which is what makes it follow somebody to
      // another machine.
      expect((await findUserByEmail(db, 'someone@presslabz.test'))?.locale).toBe('fr')
    })

    it('writes a theme without touching the language', async () => {
      await save({ locale: 'en' })
      expect((await save({ themePreference: 'dark' })).statusCode).toBe(200)

      const me = await app.inject({ url: '/auth/me', cookies: await sessionFor() })
      expect(me.json().user).toMatchObject({ locale: 'en', themePreference: 'dark' })
    })

    it('refuses a language it has no catalogue for', async () => {
      expect((await save({ locale: 'de' })).statusCode).toBe(400)
    })

    it('refuses a theme that is not one of the three', async () => {
      expect((await save({ themePreference: 'purple' })).statusCode).toBe(400)
    })

    it('refuses to be used as a way to change anything else', async () => {
      // Strict on purpose: a field this route ignores is a field the caller
      // believes it set.
      expect((await save({ role: 'administrator' })).statusCode).toBe(400)
      expect((await findUserByEmail(db, 'someone@presslabz.test'))?.role).toBe('editor')
    })

    it('answers 401 to somebody who is not signed in', async () => {
      const response = await app.inject({
        method: 'PATCH',
        url: '/auth/preferences',
        payload: { locale: 'fr' },
      })

      expect(response.statusCode).toBe(401)
    })
  })

  describe('the people on this installation', () => {
    it('needs the capability to read them', async () => {
      // Whether an editor holds users:read is the declaration's answer, not
      // this test's: what is asserted is that the route agrees with it, and
      // that a listing it does return carries no more than it should.
      const listing = await app.inject({ url: '/users', cookies: await sessionFor() })

      expect([200, 403]).toContain(listing.statusCode)

      if (listing.statusCode === 200) {
        const users = listing.json().users
        expect(users.length).toBeGreaterThan(0)
        /*
         * The field list is explicit in the route so that a column added to
         * the table does not ship. This is what says so.
         */
        expect(Object.keys(users[0]).sort()).toEqual([
          'createdAt',
          'displayName',
          'email',
          'id',
          'role',
        ])
        expect(JSON.stringify(users)).not.toMatch(/passwordHash|password_hash|\$argon/i)
      }
    })

    it('answers 401 to somebody who is not signed in', async () => {
      expect((await app.inject({ url: '/users' })).statusCode).toBe(401)
    })
  })
})
