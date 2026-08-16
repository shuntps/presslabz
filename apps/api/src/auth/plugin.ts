import { type Capability, capabilitiesFor, isRole, type Role } from '@presslabz/core'
import { type Database, extendSession, findValidSession, type UserRow } from '@presslabz/db'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
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
  locale: string
  themePreference: string
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

export function toAuthenticatedUser(row: UserRow): AuthenticatedUser {
  // A role that is no longer declared degrades to the least privilege
  // available rather than crashing or, worse, being treated as valid.
  const role: Role = isRole(row.role) ? row.role : 'subscriber'

  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role,
    locale: row.locale,
    themePreference: row.themePreference,
    capabilities: capabilitiesFor(role),
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
