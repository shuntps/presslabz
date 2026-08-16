import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
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
import { mediaRoutes } from './media/routes.ts'
import { ensureBucket } from './media/storage.ts'
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
  /*
   * credentials must be allowed: the admin is served from a different origin
   * in development and authenticates with a cookie.
   *
   * The method list is explicit because the default is GET, HEAD and POST —
   * every PATCH and DELETE this API serves would be refused by the browser
   * before it left the page, while curl and app.inject() both sail through
   * because neither performs a preflight. A test asserts the list.
   */
  await app.register(cors, {
    origin: env.ADMIN_ORIGIN,
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  })
  await app.register(cookie)

  /*
   * A POST or DELETE that carries no body but still says it is JSON is a
   * normal thing for a client to send, and Fastify answers 400 for it. Sign
   * out was doing exactly that. Treating an empty body as absent is what a
   * caller means, and it keeps the failure from reaching anyone who writes a
   * client against this API later.
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (body === '') return done(null, undefined)
      try {
        done(null, JSON.parse(body))
      } catch {
        // Fastify's own parser marks this 400. Handing back a bare SyntaxError
        // instead makes malformed input from a client look like a server
        // fault, which is both wrong and the sort of thing that gets paged on.
        const invalid = Object.assign(new Error('Body is not valid JSON'), {
          statusCode: 400,
          code: 'FST_ERR_CTP_INVALID_JSON_BODY',
        })
        done(invalid, undefined)
      }
    },
  )
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
  await app.register(multipart)
  await app.register(mediaRoutes, { db })

  /*
   * A fresh clone plus `pnpm services:up` should leave a working installation.
   * Without this the first upload fails on a bucket nobody was told to create,
   * which is a fine error to read and a poor one to hit.
   */
  await ensureBucket().catch((error) => {
    app.log.warn({ error }, 'media bucket is not reachable; uploads will fail')
  })

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
