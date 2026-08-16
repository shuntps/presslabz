import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { createBuiltinRegistry } from '@presslabz/core'
import { createDb } from '@presslabz/db'
import { negotiateLocale } from '@presslabz/i18n'
import Fastify from 'fastify'
import { Valkey } from 'iovalkey'
import authPlugin from './auth/plugin.ts'
import { authRoutes } from './auth/routes.ts'
import { contentRoutes } from './content/routes.ts'
import { env } from './env.ts'
import { userRoutes } from './users/routes.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved before any content lookup — every query is locale-scoped. */
    locale: string
  }
}

export async function buildApp() {
  const isProduction = env.NODE_ENV === 'production'

  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
    trustProxy: true,
  })

  const { db, ping: pingDb, close: closeDb } = createDb(env.DATABASE_URL)
  const valkey = new Valkey(env.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 2 })

  await app.register(helmet, { contentSecurityPolicy: false })
  // credentials must be allowed: the admin is served from a different origin
  // in development and authenticates with a cookie.
  await app.register(cors, { origin: env.ADMIN_ORIGIN, credentials: true })
  await app.register(cookie)
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })

  app.addHook('onRequest', async (request) => {
    request.locale = negotiateLocale(request.headers['accept-language'])
  })

  await app.register(authPlugin, { db, isProduction })
  await app.register(authRoutes, { db, isProduction })
  await app.register(userRoutes, { db })
  // Declared in code, so the registry is built once at boot and passed in
  // rather than reached for from a module.
  await app.register(contentRoutes, { db, registry: createBuiltinRegistry() })

  app.addHook('onClose', async () => {
    await closeDb()
    valkey.disconnect()
  })

  app.get('/health', async (_request, reply) => {
    const checks = await Promise.allSettled([
      pingDb(),
      valkey.status === 'ready' ? valkey.ping() : valkey.connect().then(() => valkey.ping()),
    ])

    const [database, cache] = checks.map((c) => (c.status === 'fulfilled' ? 'up' : 'down'))
    const healthy = database === 'up' && cache === 'up'

    return reply.code(healthy ? 200 : 503).send({
      status: healthy ? 'ok' : 'degraded',
      services: { database, cache },
    })
  })

  return app
}
