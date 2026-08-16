import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import { createDb } from '@presslabz/db'
import { negotiateLocale } from '@presslabz/i18n'
import Fastify from 'fastify'
import { Valkey } from 'iovalkey'
import { env } from './env.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved before any content lookup — every query is locale-scoped. */
    locale: string
  }
}

export async function buildApp() {
  const app = Fastify({
    logger: { level: env.NODE_ENV === 'development' ? 'info' : 'warn' },
    trustProxy: true,
  })

  const { ping: pingDb, close: closeDb } = createDb(env.DATABASE_URL)
  const valkey = new Valkey(env.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 2 })

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, { origin: env.NODE_ENV === 'development' })
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' })

  app.addHook('onRequest', async (request) => {
    request.locale = negotiateLocale(request.headers['accept-language'])
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
