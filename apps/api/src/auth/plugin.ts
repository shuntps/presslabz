import { type Capability, capabilitiesFor, DEFAULT_ROLE, isRole, type Role } from '@presslabz/core'
import { type Database, extendSession, findValidSession, type UserRow } from '@presslabz/db'
import { DEFAULT_LOCALE, isLocale, type Locale } from '@presslabz/i18n'
import { isThemePreference, type ThemePreference } from '@presslabz/tokens/preferences'
import type { FastifyBaseLogger, FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'
import {
  hashSessionToken,
  SESSION_COOKIE,
  sessionCookieOptions,
  sessionExpiry,
  shouldRenew,
} from './session.ts'

export interface AuthenticatedUser {
  id: string
  email: string
  displayName: string
  role: Role
  /*
   * The domain types, not `string`. `toAuthenticatedUser` proves each of these
   * is inside its vocabulary and the two widest fields threw that proof away
   * on the next line — so anything downstream received a `string` again and had
   * to re-establish what had just been established, or not bother.
   */
  locale: Locale
  themePreference: ThemePreference
  capabilities: ReadonlySet<Capability>
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Null for anonymous requests. Never throws — guards decide the response. */
    user: AuthenticatedUser | null
  }
  interface FastifyInstance {
    requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>
    requireCapability: (
      capability: Capability,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>
  }
}

/**
 * The stored row, brought back inside the domains it is supposed to hold.
 *
 * The database refuses these values now, so a row outside them means a
 * restore, a hand-edit, or a database older than the constraints. This is the
 * defence against that, and it is **only** a defence: it never writes anything
 * back, because silently repairing a row is how a wrong value becomes
 * permanent and unexplained.
 *
 * Least privilege for a role, the product's default language for a locale,
 * `system` for a theme. Nothing here throws: a person whose row is odd must
 * still be able to sign in, if only to fix it.
 */
export function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  const role: Role = isRole(row.role) ? row.role : DEFAULT_ROLE
  const locale = isLocale(row.locale) ? row.locale : DEFAULT_LOCALE
  const themePreference = isThemePreference(row.themePreference) ? row.themePreference : 'system'

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role,
    locale,
    themePreference,
    capabilities: capabilitiesFor(role),
  }
}

/** A field whose stored value is not one the product declares. */
export interface SessionCorrection {
  readonly field: 'role' | 'locale' | 'themePreference'
  /** Bounded, because the point is to recognise it, not to reproduce it. */
  readonly stored: string
}

/**
 * What `toAuthenticatedUser` had to correct, for the log.
 *
 * Separate from the normalisation on purpose: that function answers what the
 * request should see, and a function that also writes to a log cannot be
 * called from a test, a script, or a second endpoint without writing to a log.
 * What is done with the answer is `reportSessionCorrections`'s decision.
 */
export function sessionCorrections(row: UserRow): readonly SessionCorrection[] {
  const found: SessionCorrection[] = []
  const bound = (value: string) => (value.length > 40 ? `${value.slice(0, 40)}…` : value)

  if (!isRole(row.role)) found.push({ field: 'role', stored: bound(row.role) })
  if (!isLocale(row.locale)) found.push({ field: 'locale', stored: bound(row.locale) })
  if (!isThemePreference(row.themePreference)) {
    found.push({ field: 'themePreference', stored: bound(row.themePreference) })
  }

  return found
}

/**
 * How many account-and-field pairs the deduplication remembers at once.
 *
 * A bound, not a guess at how many bad rows there will be. The first version
 * of this was an unbounded Set, which is a memory leak with a polite name: it
 * never spams the log, and it never gives anything back either — one entry per
 * distinct pair, kept until the process died, its size decided by data rather
 * than by this file. Five hundred is far more than any installation should
 * ever have, and small enough that the worst case is a few tens of kilobytes.
 */
export const CORRECTION_MEMORY_LIMIT = 500

export interface CorrectionMemory {
  /** True the first time a key is seen, false while it is still remembered. */
  remember(key: string): boolean
  /** How many keys are held. Never above the capacity it was built with. */
  readonly size: number
}

/**
 * Bounded, insertion-ordered, oldest evicted first.
 *
 * A `Map` iterates in insertion order, so "the oldest key" is `keys().next()`
 * and eviction needs no bookkeeping of its own. Deliberately FIFO rather than
 * LRU — both hold the memory bound equally well; where they differ is in what
 * they keep. An LRU renews a key each time it is seen, so the handful of rows
 * that are polled all day would hold their slots indefinitely and stay silent
 * for the life of the process. Under FIFO every key ages out, so a
 * long-standing bad row is re-reported about once per `capacity` distinct
 * pairs — a bound on the silence as well as on the memory, which for a
 * warning is the right way round.
 */
export function createCorrectionMemory(capacity: number): CorrectionMemory {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError(`A correction memory needs a capacity of at least 1, got ${capacity}`)
  }

  const keys = new Map<string, true>()

  return {
    remember(key) {
      if (keys.has(key)) return false

      keys.set(key, true)
      /*
       * The capacity is fixed at construction, so a single insert can only
       * ever leave the map one over it and `if` would do. `while` states the
       * invariant instead of the arithmetic that happens to reach it, and
       * costs nothing when one pass is enough.
       */
      while (keys.size > capacity) {
        const oldest = keys.keys().next()
        if (oldest.done) break
        keys.delete(oldest.value)
      }

      return true
    },
    get size() {
      return keys.size
    },
  }
}

/*
 * One line per account and field while the pair is remembered — which, at five
 * hundred slots evicted oldest-first, is effectively always, and a rare
 * repeat under churn is a reminder rather than a defect. A row nobody repairs
 * is polled by every open tab every minute, and the second identical line is
 * already noise.
 */
const reported = createCorrectionMemory(CORRECTION_MEMORY_LIMIT)

export function reportSessionCorrections(
  log: Pick<FastifyBaseLogger, 'warn'>,
  row: UserRow,
  /* Injectable so its bound can be proven at a size a test can exhaust. */
  memory: CorrectionMemory = reported,
): void {
  for (const correction of sessionCorrections(row)) {
    if (!memory.remember(`${row.id}:${correction.field}`)) continue

    log.warn(
      { userId: row.id, field: correction.field, stored: correction.stored },
      'a stored preference is not a value this build declares; using the default instead',
    )
  }
}

interface AuthPluginOptions {
  db: Database
  isProduction: boolean
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (app, { db, isProduction }) => {
  app.decorateRequest('user', null)

  app.addHook('onRequest', async (request, reply) => {
    const token = request.cookies[SESSION_COOKIE]
    if (!token) return

    const tokenHash = hashSessionToken(token)
    const found = await findValidSession(db, tokenHash)

    if (!found) {
      // Expired or revoked: clear it so the browser stops sending it.
      reply.clearCookie(SESSION_COOKIE, { path: '/' })
      return
    }

    request.user = toAuthenticatedUser(found.user)

    /*
     * Reported from here, where the row is already in hand — reading it again
     * on the two endpoints that return a payload would put a query on a call
     * the interface polls every minute per open tab.
     *
     * What keeps this from being the naive version is the deduplication: one
     * line per user and field while the memory holds the pair, instead of one
     * per authenticated request — a volume that buries the thing it is trying
     * to report.
     */
    reportSessionCorrections(request.log, found.user)

    if (shouldRenew(found.expiresAt)) {
      const next = sessionExpiry()
      await extendSession(db, tokenHash, next)
      reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(isProduction))
    }
  })

  app.decorate('requireAuth', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!request.user) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })

  app.decorate(
    'requireCapability',
    (capability: Capability) => async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.user) {
        await reply.code(401).send({ error: 'unauthorized' })
        return
      }
      if (!request.user.capabilities.has(capability)) {
        // 403, not 404: the caller is authenticated, and hiding the route
        // from them would only make the admin harder to debug.
        await reply.code(403).send({ error: 'forbidden', required: capability })
      }
    },
  )
}

export default fp(authPlugin, { name: 'presslabz-auth', dependencies: ['@fastify/cookie'] })
