import type { SessionUser } from '@presslabz/core'
import {
  createSession,
  type Database,
  deleteSession,
  findUserByEmail,
  updateUserPreferences,
} from '@presslabz/db'
import { LOCALES } from '@presslabz/i18n'
import { THEME_PREFERENCES } from '@presslabz/tokens/preferences'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { equalizeTiming, verifyPassword } from './password.ts'
import { type AuthenticatedUser, reportSessionCorrections, toAuthenticatedUser } from './plugin.ts'
import {
  generateSessionToken,
  hashSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionExpiry,
} from './session.ts'

const loginBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
})

/*
 * `z.enum` over the constants rather than `z.string().refine(isLocale)`: both
 * refuse the same bodies, but only the enum carries the literal union out the
 * other side, so the repository's typed signature is checked here instead of
 * being satisfied by a `string` that happens to be right.
 */
const preferencesBody = z
  .object({
    locale: z.enum(LOCALES).optional(),
    themePreference: z.enum(THEME_PREFERENCES).optional(),
  })
  .refine((body) => body.locale !== undefined || body.themePreference !== undefined, {
    message: 'Provide at least one preference',
  })

interface AuthRoutesOptions {
  db: Database
  isProduction: boolean
}

export const authRoutes: FastifyPluginAsync<AuthRoutesOptions> = async (
  app,
  { db, isProduction },
) => {
  app.post(
    '/auth/login',
    {
      /*
       * Far stricter than the global limit: this is the one route where
       * guessing is the attack.
       *
       * And the one route that refuses rather than degrades. The global limit
       * keeps serving when the store is unreachable, because losing a courtesy
       * count beats an outage. Here the count *is* the protection: opening it
       * during a store failure hands an attacker the window they would create
       * on purpose if they could. Existing sessions live in Postgres and keep
       * working, so what stops is signing in, not being signed in.
       */
      config: { rateLimit: { max: 10, timeWindow: '15 minutes', skipOnError: false } },
    },
    async (request, reply) => {
      const parsed = loginBody.safeParse(request.body)
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_request' })
      }

      const { email, password } = parsed.data
      const user = await findUserByEmail(db, email)

      // Same work and the same answer whether the account exists, the
      // password is wrong, or the account has no password set.
      if (!user?.passwordHash) {
        await equalizeTiming(password)
        return reply.code(401).send({ error: 'invalid_credentials' })
      }

      if (!(await verifyPassword(user.passwordHash, password))) {
        return reply.code(401).send({ error: 'invalid_credentials' })
      }

      const token = generateSessionToken()
      await createSession(db, hashSessionToken(token), user.id, sessionExpiry())
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(isProduction))

      const authenticated = toAuthenticatedUser(user)
      // Signing in does not go through the onRequest hook — there is no
      // session yet — so this is the second and last place that reports.
      reportSessionCorrections(request.log, user)
      return reply.send({ user: serializeUser(authenticated) })
    },
  )

  app.post('/auth/logout', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (token) {
      await deleteSession(db, hashSessionToken(token))
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' })
    return reply.code(204).send()
  })

  app.get('/auth/me', { onRequest: [app.requireAuth] }, async (request, reply) => {
    // requireAuth has already answered 401 when there is no user.
    if (!request.user) return

    return reply.send({ user: serializeUser(request.user) })
  })

  app.patch('/auth/preferences', { onRequest: [app.requireAuth] }, async (request, reply) => {
    if (!request.user) return

    const parsed = preferencesBody.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_request' })
    }

    await updateUserPreferences(db, request.user.id, parsed.data)
    return reply.send({ ...parsed.data })
  })
}

/**
 * The account as the two session routes answer it.
 *
 * Typed `SessionUser` — the type inferred from the schema the admin parses
 * these responses with — rather than an object literal that happens to match.
 * The parameter used to widen every domain field to `string` and the
 * capabilities to `ReadonlySet<string>`, which meant the compiler would have
 * accepted a role the contract refuses and left the disagreement to be found
 * at runtime by a browser. Both ends now describe the same thing, and the
 * return type is checked against the contract rather than inferred from what
 * this function happens to build.
 *
 * The explicit field list stays: a column added to `users` must not ship
 * because somebody spread a row.
 */
function serializeUser(user: AuthenticatedUser): SessionUser {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    locale: user.locale,
    themePreference: user.themePreference,
    // Sent so the admin can hide what the user cannot do. The server still
    // enforces every one of these on its own; this is presentation only.
    capabilities: [...user.capabilities],
  }
}
