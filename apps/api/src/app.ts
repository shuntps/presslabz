import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit, { normalizeIP } from '@fastify/rate-limit'
import { createBuiltinRegistry } from '@presslabz/core'
import { createDb, deleteExpiredSessions } from '@presslabz/db'
import { negotiateLocale } from '@presslabz/i18n'
import Fastify from 'fastify'
import { Valkey } from 'iovalkey'
import { startSessionSweep } from './auth/cleanup.ts'
import authPlugin from './auth/plugin.ts'
import { authRoutes } from './auth/routes.ts'
import { contentRoutes } from './content/routes.ts'
import { env } from './env.ts'
import { createProbe } from './health/probe.ts'
import { summarizeHealth } from './health/status.ts'
import clientIpPlugin, { type ClientIpOptions, trustProxyFor } from './http/client-ip.ts'
import { corsOptions } from './http/cors.ts'
import { REDACTED_LOG_PATHS, registerErrorHandling } from './http/errors.ts'
import { mediaRoutes } from './media/routes.ts'
import { ensureBucket } from './media/storage.ts'
import { createValkeyStore, StoreHealth } from './rate-limit/valkey-store.ts'
import { userRoutes } from './users/routes.ts'

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved before any content lookup — every query is locale-scoped. */
    locale: string
  }
}

export interface BuildAppOptions {
  /**
   * Overrides the configured database.
   *
   * It exists so a suite can stand the whole API up against a scratch database
   * it drops afterwards, rather than writing users, sessions and media into
   * whatever `DATABASE_URL` points at and leaving them there. Same reasoning as
   * `startSessionSweep` taking its sweep as a function: the seam is small, and
   * without it the only alternative is a test that mutates the environment
   * before importing this module.
   */
  readonly databaseUrl?: string
  /**
   * Overrides the rate-limit key prefix.
   *
   * The limiter's counters live in Valkey now, so they outlive a process and
   * are shared by every instance — which is the point, and which also means a
   * suite that used the configured prefix would spend the real quota and
   * collide with the next run. Each suite takes its own prefix and deletes the
   * keys it created.
   */
  readonly rateLimitNamespace?: string
  /**
   * Overrides where the limiter's own client connects.
   *
   * Only the limiter's: the health client keeps pointing at the configured
   * Valkey. That asymmetry is the point — it is what lets a suite observe a
   * store outage while the cache itself is up, which is the state `/health`
   * used to report as `ok`. Stopping Valkey outright would take both down and
   * prove nothing about the difference.
   */
  readonly rateLimitValkeyUrl?: string
}

export async function buildApp(options: BuildAppOptions = {}) {
  const isProduction = env.NODE_ENV === 'production'
  const clientIp: ClientIpOptions = {
    source: env.CLIENT_IP_SOURCE,
    trustedProxies: env.TRUSTED_PROXIES,
    headerName: env.CLIENT_IP_HEADER,
  }

  const app = Fastify({
    logger: {
      level: env.NODE_ENV === 'development' ? 'info' : 'warn',
      // Guaranteed for the structured fields we own. An error's own message is
      // free-form text from an arbitrary library, which no generic filter can
      // be trusted to clear of secrets; it is logged whole on purpose, and the
      // logs are handled accordingly — see the note in http/errors.ts.
      redact: REDACTED_LOG_PATHS,
    },
    /*
     * Never `true`. With it, anyone reaching the API directly chose their own
     * address — and their own rate-limit bucket — by sending a header.
     * `forwarded` mode hands Fastify an explicit list to walk; the other modes
     * trust nothing and leave request.ip as the immediate peer.
     */
    trustProxy: trustProxyFor(clientIp),
    /*
     * Three different stalls, three different timeouts, measured rather than
     * assumed: incomplete headers and silent connections answer 408 through
     * requestTimeout/headersTimeout, while a socket that stops moving is
     * reaped by connectionTimeout. handlerTimeout is separate and off by
     * default — see env.ts.
     */
    connectionTimeout: env.HTTP_SOCKET_IDLE_TIMEOUT_MS,
    requestTimeout: env.HTTP_REQUEST_TIMEOUT_MS,
    handlerTimeout: env.HTTP_HANDLER_TIMEOUT_MS,
    http: {
      headersTimeout: env.HTTP_HEADERS_TIMEOUT_MS,
      /*
       * Internal, not a policy: Node enforces requestTimeout on a sweep, and
       * at the 30s default a request timeout of a few seconds is applied up to
       * half a minute late. Measured; documented; not offered as a setting.
       */
      connectionsCheckingInterval: 5_000,
    },
  })

  registerErrorHandling(app)

  const { db, ping: pingDb, close: closeDb } = createDb(options.databaseUrl ?? env.DATABASE_URL)
  const valkey = new Valkey(env.VALKEY_URL, { lazyConnect: true, maxRetriesPerRequest: 2 })
  valkey.on('error', () => {
    // Without a listener iovalkey prints the stack to console.error, outside
    // the logger entirely. /health is what reports this one.
  })

  /*
   * A second client, for the rate limiter alone. Its needs are the opposite of
   * the health client's: a quota check must fail in milliseconds, not wait out
   * a connection. With iovalkey's defaults a single command against an
   * unreachable server took 10 to 42 seconds to give up — `skipOnError` would
   * never have got the chance, and "fail open" would have been a full outage.
   *
   * What bounds the wait is `maxRetriesPerRequest: 0` together with a short
   * `commandTimeout`: measured, a command against an unreachable server gives
   * up in 1 to 400 ms. The offline queue stays enabled — disabling it makes
   * the very first command fail even when Valkey is up and reachable, because
   * with a lazy connection there is nothing to hold it while the socket opens.
   * The retry strategy is persistent and bounded, so Valkey coming back is
   * picked up on its own; stopping retries would make the failure permanent.
   */
  const rateLimitValkey = new Valkey(options.rateLimitValkeyUrl ?? env.VALKEY_URL, {
    lazyConnect: true,
    connectTimeout: 500,
    commandTimeout: 500,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt: number) => Math.min(attempt * 200, 5_000),
  })
  const storeHealth = new StoreHealth(app.log)
  rateLimitValkey.on('error', (error) => {
    // Routed through the bounded transition logger rather than iovalkey's own
    // console.error, which would write a stack per reconnection attempt.
    storeHealth.recordFailure(error)
  })
  /*
   * Bound here, and only here. The plugin constructs the store itself, so the
   * client, the namespace and the health state travel inside the class it is
   * handed rather than through a module-level handle two concurrent builds
   * would overwrite for each other.
   */
  const rateLimitStore = createValkeyStore({
    valkey: rateLimitValkey,
    namespace: options.rateLimitNamespace ?? env.RATE_LIMIT_NAMESPACE,
    health: storeHealth,
  })

  await app.register(helmet, { contentSecurityPolicy: false })
  // Exact origins, credentials allowed, methods named — all three decided in
  // http/cors.ts, where the reasoning and the failure each one closes live.
  await app.register(cors, corsOptions(env.ADMIN_ORIGIN))
  await app.register(cookie)

  /*
   * Fastify's own JSON parser, deliberately not replaced.
   *
   * A hand-rolled one stood here so that a client announcing JSON and sending
   * nothing got a 200 — sign out did exactly that. The admin no longer does:
   * apiFetch names the content type only for a body it serialised. Meanwhile
   * the replacement had quietly dropped what the built-in parser gives for
   * free, and `__proto__` and `constructor` were being accepted where Fastify
   * rejects them. An empty JSON body is a 400 again, which is Fastify 5's own
   * deliberate behaviour.
   */

  /*
   * Before the rate limiter: its onRequest hook is added at registration and
   * hooks run in that order, and its key generator reads request.clientIp.
   */
  await app.register(clientIpPlugin, clientIp)

  await app.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    store: rateLimitStore,
    /*
     * The key is not the address. The default generator maps IPv4-mapped
     * addresses and masks IPv6 to a prefix; handing it the full address would
     * hand a visitor with a /64 an unbounded supply of buckets.
     */
    keyGenerator: (request) => normalizeIP(request.clientIp, env.IPV6_RATE_LIMIT_PREFIX),
    /*
     * Global posture: keep serving if the store is unreachable. This limit is
     * a courtesy against accidental hammering, and losing the count for a few
     * minutes beats refusing every request. /auth/login overrides it — see
     * auth/routes.ts, where guessing is the attack.
     */
    skipOnError: true,
  })

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

  const sweeper = startSessionSweep({ sweep: () => deleteExpiredSessions(db), log: app.log })

  app.addHook('onClose', async () => {
    sweeper.stop()
    await closeDb()
    valkey.disconnect()
    /*
     * disconnect(), never quit(). Measured: on a client with no connection
     * quit() never returns, so it would hang shutdown at exactly the moment
     * Valkey is unreachable. Left open, the reconnection timer keeps the
     * process alive indefinitely.
     */
    rateLimitValkey.disconnect()
  })

  /*
   * One probe per dependency, at most one operation in flight for each.
   *
   * A bound on the response is not enough on its own: a liveness check calling
   * every few seconds while the database is wedged would stack a query per
   * call, all still running, and turn one stuck dependency into an exhausted
   * pool. Concurrent callers share the operation already running.
   */
  const databaseProbe = createProbe({
    check: pingDb,
    timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  })
  const cacheProbe = createProbe({
    check: () =>
      valkey.status === 'ready' ? valkey.ping() : valkey.connect().then(() => valkey.ping()),
    timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  })

  /*
   * Rate limited like everything else. It reaches two dependencies, so leaving
   * it open would be an unmetered way to make the API work — the single-flight
   * above bounds the cost of concurrent calls, not of sequential ones.
   */
  app.get('/health', async (_request, reply) => {
    const [database, cache] = await Promise.all([databaseProbe.run(), cacheProbe.run()])
    /*
     * The limiter's store counts towards the verdict, not just towards the
     * detail: login fails closed while it is unreachable, so an instance in
     * that state cannot authenticate anybody and must not answer 200.
     */
    const { statusCode, body } = summarizeHealth({
      database,
      cache,
      rateLimitDegraded: storeHealth.degraded,
    })

    return reply.code(statusCode).send(body)
  })

  return app
}
