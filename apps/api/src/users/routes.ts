import { type Database, listUsers } from '@presslabz/db'
import type { FastifyPluginAsync } from 'fastify'

interface UserRoutesOptions {
  db: Database
}

export const userRoutes: FastifyPluginAsync<UserRoutesOptions> = async (app, { db }) => {
  app.get(
    '/users',
    { onRequest: [app.requireCapability('users:read')] },
    async (_request, reply) => {
      const rows = await listUsers(db)

      // Explicit field list, never the row. A `select *` here would ship
      // passwordHash to the client the first time someone adds a column.
      return reply.send({
        users: rows.map((row) => ({
          id: row.id,
          email: row.email,
          displayName: row.displayName,
          role: row.role,
          createdAt: row.createdAt,
        })),
      })
    },
  )
}
