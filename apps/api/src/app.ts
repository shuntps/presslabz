import cookie from '@fastify/cookie'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit, { normalizeIP } from '@fastify/rate-limit'
import { contentEventOf, createBuiltinRegistry, transitionsFor } from '@presslabz/core'
import {
  createDb,
  deleteExpiredSessions,
  publishDueContent,
  readMediaReferenceSyncState,
} from '@presslabz/db'
import { negotiateLocale } from '@presslabz/i18n'
import type { Module } from '@presslabz/modules'
import Fastify from 'fastify'
import { Valkey } from 'iovalkey'
import { startSessionSweep } from './auth/cleanup.ts'
import authPlugin from './auth/plugin.ts'
import { authRoutes } from './auth/routes.ts'
import { createApiPageCache } from './cache/purge.ts'
import { contentRoutes } from './content/routes.ts'
import { startScheduler } from './content/scheduler.ts'
import { env } from './env.ts'
import { createProbe, type ProbeResult } from './health/probe.ts'
import { summarizeHealth } from './health/status.ts'
import { reportChanges } from './health/transitions.ts'
import { createApiHooks } from './hooks.ts'
import clientIpPlugin, { type ClientIpOptions, trustProxyFor } from './http/client-ip.ts'
import { corsOptions } from './http/cors.ts'
import { ClientFacingError, REDACTED_LOG_PATHS, registerErrorHandling } from './http/errors.ts'
import { type Admission, createAdmission } from './media/admission.ts'
import { startOrphanSweep } from './media/orphans.ts'
import { mediaRoutes } from './media/routes.ts'
import {
  type BucketState,
  bucketState,
  checkDelivery,
  type DeliveryOutcome,
  deliveryCheckUrl,
  deliveryFailureMessage,
} from './media/storage.ts'
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
   * The gate that bounds concurrent uploads, and how many may wait.
   *
   * Built here by default, one per application, so two instances in one
   * process neither share counters nor block one another — which a
   * module-level queue did. Injectable rather than exposed as a decoration:
   * a suite that needs to read `active` and `waiting` builds the gate itself
   * and keeps the reference, and nothing about a running server has to grow a
   * public surface for the benefit of a test.
   */
  readonly admission?: Admission
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
  /**
   * Overrides the page cache's key prefix.
   *
   * Same reasoning as the rate limiter's: a suite that purged under the
   * configured namespace would empty the cache of whatever else is running
   * against this Valkey — a developer's own site, another run. It is also what
   * lets a test observe a purge without inventing one.
   */
  readonly pageCacheNamespace?: string
  /**
   * Extra hook modules. A suite installs one to observe what the core
   * announces, which is the only way to assert that it announces anything at
   * all without reaching inside the routes.
   */
  readonly modules?: readonly Module[]
}

/**
 * The diagnostic word behind a storage verdict.
 *
 * It is what the log says, and — since a cause is part of what makes a
 * transition — it is also what decides whether a state that has not changed is
 * still worth a line. A store that goes from *missing* to *denied* is news;
 * two thousand consecutive *denied* are not.
 *
 * A `degraded` verdict whose recorded outcome still reads `ok` means the probe
 * lost its race rather than getting an answer: the closure never ran to
 * completion, so nothing overwrote it. That is an unreachable base.
 */
function storageCauseOf(
  verdict: 'up' | 'down' | 'degraded',
  bucket: ProbeResult,
  bucketCause: BucketState,
  delivery: DeliveryOutcome,
): string {
  if (verdict === 'down') return bucket.timedOut ? 'timed out' : bucketCause
  if (verdict === 'degraded') return delivery.ok ? 'unreachable' : delivery.cause
  return 'ok'
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

  /*
   * Before a single other resource exists.
   *
   * The mirror is only a guarantee once something has built it, and applying a
   * migration and building it are two events: an installation that ran the
   * first without the second would enforce nothing while looking exactly like
   * one that had. One row, read once — not a scan, which is the entire point
   * of writing the answer down.
   *
   * Checked here rather than beside the routes because a refusal further down
   * would already have opened two Valkey connections, registered a rate-limit
   * store and started three background timers, and thrown while holding all of
   * them. The one resource that does exist by now is closed on the way out.
   */
  try {
    const referenceState = await readMediaReferenceSyncState(db)
    if (referenceState !== 'ready') {
      throw new Error(
        'Media references have not been reconciled with the database yet. Run ' +
          '`pnpm db:upgrade` — or `pnpm db:reconcile` if the migrations are already ' +
          'applied — and start this again once it reports success.',
      )
    }
  } catch (error) {
    await closeDb()
    throw error
  }
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
    /*
     * The plugin's own 429 error carries no code, so the error handler cannot
     * tell it from a dependency that happens to throw a 4xx — and unrecognised
     * 4xx are redacted. Building it here says the message is ours and meant to
     * be read; the wording and the Retry-After header are unchanged.
     */
    errorResponseBuilder: (_request, context) =>
      new ClientFacingError(
        context.statusCode ?? 429,
        `Rate limit exceeded, retry in ${context.after}`,
      ),
  })

  app.addHook('onRequest', async (request) => {
    request.locale = negotiateLocale(request.headers['accept-language'])
  })

  await app.register(authPlugin, { db, isProduction })
  await app.register(authRoutes, { db, isProduction })
  await app.register(userRoutes, { db })
  // Declared in code, so the registry is built once at boot and passed in
  // rather than reached for from a module.
  /*
   * The cache shares the health client. Purging runs after a write has already
   * landed, so it is allowed to be slow and is not allowed to fail the
   * request; a dedicated connection would buy nothing and cost one more thing
   * to keep alive.
   */
  const pageCacheNamespace = options.pageCacheNamespace ?? env.PAGE_CACHE_NAMESPACE

  const { hooks, uninstall } = createApiHooks({
    cache: createApiPageCache({
      client: valkey,
      ...(pageCacheNamespace === undefined ? {} : { namespace: pageCacheNamespace }),
      ...(env.PAGE_CACHE_TTL_SECONDS === undefined
        ? {}
        : { ttlSeconds: env.PAGE_CACHE_TTL_SECONDS }),
    }),
    logger: app.log,
    ...(options.modules === undefined ? {} : { modules: options.modules }),
  })

  app.addHook('onClose', () => {
    uninstall()
  })

  /*
   * What makes `scheduled` mean anything. It announces each publication
   * through the same hook a manual one uses, so the cache purge and every
   * other handler treat a scheduled post exactly like one somebody pressed a
   * button for — which is the point of routing invalidation through the hook
   * API rather than calling it from the routes.
   */
  const scheduler =
    env.SCHEDULER_INTERVAL_MS > 0
      ? startScheduler({
          publishDue: () => publishDueContent(db),
          announce: async (row) => {
            /*
             * The same announcements a manual publication makes, decided by
             * the same function, so that a handler cannot tell the two apart —
             * which is the whole reason invalidation went through the hook API
             * rather than staying in the write routes.
             */
            const context = { locale: row.locale, actorId: null }
            for (const announcement of transitionsFor('scheduled', contentEventOf(row))) {
              await hooks.emit(announcement.name, announcement.payload, context)
            }
          },
          log: app.log,
          intervalMs: env.SCHEDULER_INTERVAL_MS,
        })
      : null

  app.addHook('onClose', () => {
    scheduler?.stop()
  })

  await app.register(contentRoutes, { db, registry: createBuiltinRegistry(), hooks })
  await app.register(multipart)
  await app.register(mediaRoutes, {
    db,
    hooks,
    admission: options.admission ?? createAdmission(),
  })

  /*
   * Media lives in two systems that cannot share a transaction, so a failed
   * delete or an abandoned upload leaves bytes with no row. They are recorded
   * where that is atomic; this is what eventually removes them, and what makes
   * the difference between a leak that is survivable and one that is
   * recoverable.
   */
  const orphanSweep = startOrphanSweep({ db, log: app.log })

  app.addHook('onClose', () => {
    orphanSweep.stop()
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
   * Whether the bucket is there and answers this credential.
   *
   * What it is **not** is evidence that an upload will work. `HeadBucket` and
   * `PutObject` are different permissions on every store worth the name, and a
   * credential that passes the first and fails the second is a real and
   * ordinary configuration — so `up` here means "the store answered", and
   * nothing in this file claims more than that.
   *
   * The cause is kept here rather than put in the response. `/health` is
   * unauthenticated and says only `down`; whether the bucket was missing,
   * refused, erroring or unreachable goes to the log, where the operator is.
   */
  let storageCause: BucketState = 'present'
  const storageProbe = createProbe({
    check: async () => {
      const state = await bucketState()
      storageCause = state
      if (state !== 'present') throw new Error(`object store is ${state}`)
    },
    timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  })

  /*
   * And the half a credentialed call cannot answer: whether a reader can
   * actually fetch an object, over the URL a reader actually uses.
   *
   * In both delivery modes. `deliveryCheckUrl()` is `MEDIA_BASE_URL` when one
   * is set and the store's own endpoint otherwise, so this asks the question
   * readers ask either way — and an external base answering 403, 404 or
   * nothing at all is exactly as broken as a bucket that does. Skipping the
   * check because a CDN is somebody else's to run was a way to answer 200
   * while every image on the site failed.
   */
  let deliveryOutcome: DeliveryOutcome = { ok: true }
  const deliveryProbe = createProbe({
    check: async () => {
      const url = deliveryCheckUrl()
      deliveryOutcome = await checkDelivery(url, env.HEALTH_CHECK_TIMEOUT_MS)
      if (!deliveryOutcome.ok) throw new Error(deliveryOutcome.cause)
    },
    timeoutMs: env.HEALTH_CHECK_TIMEOUT_MS,
  })

  const reportStorage = reportChanges(app.log, 'storage')

  /**
   * What this installation serves, for a client that has to draw it.
   *
   * Unauthenticated on purpose: the sign-in screen offers a language switcher
   * and has no session to ask with, and none of this is a secret — the public
   * site announces the same languages in its `hreflang` links.
   *
   * It exists because `SUPPORTED_LOCALES` was configuration nothing consulted.
   * The admin listed the whole message catalogue, so an installation serving
   * one language still offered to write documents in the other, and the API
   * accepted them: content nobody could reach, in a language the site does not
   * route.
   */
  app.get('/config', async (_request, reply) =>
    reply.send({
      locales: env.SUPPORTED_LOCALES,
      defaultLocale: env.DEFAULT_LOCALE,
    }),
  )

  /*
   * Rate limited like everything else. It reaches two dependencies, so leaving
   * it open would be an unmetered way to make the API work — the single-flight
   * above bounds the cost of concurrent calls, not of sequential ones.
   */
  app.get('/health', async (_request, reply) => {
    const [database, cache, storage, mediaDeliveryResult] = await Promise.all([
      databaseProbe.run(),
      cacheProbe.run(),
      storageProbe.run(),
      deliveryProbe.run(),
    ])
    /*
     * The limiter's store counts towards the verdict, not just towards the
     * detail: login fails closed while it is unreachable, so an instance in
     * that state cannot authenticate anybody and must not answer 200.
     */
    const { statusCode, body } = summarizeHealth({
      database,
      cache,
      storage,
      mediaDelivery: mediaDeliveryResult,
      rateLimitDegraded: storeHealth.degraded,
    })

    /*
     * Named here and nowhere else. The body carries a verdict; this carries
     * the reason — and the reason is part of what makes a transition, so a
     * store that goes from missing to refusing says so instead of being
     * suppressed as "still down".
     */
    const verdict = body.services.storage
    const cause = storageCauseOf(verdict, storage, storageCause, deliveryOutcome)

    reportStorage(
      verdict,
      String(cause),
      verdict === 'down'
        ? `the object store did not answer this instance: ${cause}`
        : verdict === 'degraded'
          ? deliveryFailureMessage(deliveryCheckUrl(), deliveryOutcome)
          : 'the object store answers, and media is readable over its public URL',
    )

    return reply.code(statusCode).send(body)
  })

  return app
}
