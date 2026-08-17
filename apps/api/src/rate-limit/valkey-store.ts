import type { FastifyBaseLogger } from 'fastify'
import type { Valkey } from 'iovalkey'

/**
 * A rate-limit store backed by Valkey.
 *
 * `@fastify/rate-limit` ships a Redis store behind its `redis` option, and its
 * documentation says that option requires `ioredis`. This project runs
 * `iovalkey`, so rather than pass one client where another is documented — and
 * depend on a compatibility nobody maintains — it uses the plugin's public
 * `store` extension point, which exists precisely so an application can bring
 * its own. The Lua below is ours; so is the contract with iovalkey.
 *
 * In memory the quota is per process, which behind a load balancer means every
 * instance grants the full allowance. Valkey is what makes one quota one
 * quota.
 */

/**
 * Increment and report. Atomic because it is one script: the counter and its
 * expiry cannot be set by two connections interleaving, which is exactly what
 * a rate limiter must not allow.
 */
const INCR_LUA = `
  local key = KEYS[1]
  local timeWindow = tonumber(ARGV[1])
  local current = redis.call('INCR', key)
  if current == 1 then
    redis.call('PEXPIRE', key, timeWindow)
  else
    timeWindow = redis.call('PTTL', key)
  end
  return {current, timeWindow}
`

/** The same reading, without moving the counter. */
const READ_LUA = `
  local key = KEYS[1]
  local current = redis.call('GET', key)
  if not current then
    return {0, 0}
  end
  local ttl = redis.call('PTTL', key)
  if ttl < 0 then
    ttl = 0
  end
  return {tonumber(current), ttl}
`

export interface RateLimitReading {
  current: number
  ttl: number
}

/** The shape @fastify/rate-limit hands a store and expects back. */
type Callback = (error: Error | null, result?: RateLimitReading | undefined) => void

/** iovalkey's own callback shape for a scripted command. */
type ScriptCallback = (error: Error | null, result?: [number, number]) => void

/**
 * Raised when the store itself cannot answer.
 *
 * It carries 503 so the error handler can keep that status rather than
 * flattening it to 500: a quota that cannot be checked is a dependency being
 * unavailable, not the request being wrong. The message never reaches the
 * client — without this the raw driver text does, and iovalkey's is
 * "Stream isn't writeable and enableOfflineQueue options is false".
 */
export class RateLimitStoreUnavailableError extends Error {
  readonly statusCode = 503

  constructor(cause: unknown) {
    super('Rate limit store unavailable')
    this.name = 'RateLimitStoreUnavailableError'
    this.cause = cause
  }
}

/**
 * One line when it breaks, one when it comes back.
 *
 * The plugin swallows store errors when `skipOnError` is true, so nothing is
 * logged unless the store logs it — and a line per request would write one
 * line per request for the whole outage. Transitions are what an operator
 * needs: it started, it stopped, and how much was hidden in between.
 *
 * Both lines are `warn`, not `info`, because the API runs at `warn` outside
 * development: a recovery logged at `info` would be invisible exactly where it
 * matters.
 */
export class StoreHealth {
  private healthy = true
  private suppressed = 0
  private readonly log: Pick<FastifyBaseLogger, 'warn'>

  /**
   * Assigned in the body rather than declared as a constructor parameter
   * property. Node 24 strips types rather than compiling them, and a parameter
   * property is the one piece of TypeScript that needs real emit — `tsc
   * --noEmit` accepts it, vitest accepts it, and the API then fails to load
   * the module at runtime with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
   */
  constructor(log: Pick<FastifyBaseLogger, 'warn'>) {
    this.log = log
  }

  get degraded(): boolean {
    return !this.healthy
  }

  recordFailure(error: unknown): void {
    if (this.healthy) {
      this.healthy = false
      this.suppressed = 0
      this.log.warn({ err: error }, 'rate limit store unavailable; global limits are not enforced')
      return
    }
    this.suppressed++
  }

  recordSuccess(): void {
    if (this.healthy) return
    const suppressed = this.suppressed
    this.healthy = true
    this.suppressed = 0
    this.log.warn({ suppressed }, 'rate limit store recovered')
  }
}

export interface ValkeyStoreDeps {
  readonly valkey: Valkey
  readonly namespace: string
  readonly health: StoreHealth
}

/** Idempotent: a client handed to two registrations defines its scripts once. */
function defineScripts(valkey: Valkey): void {
  const client = valkey as Valkey & Record<string, unknown>

  if (typeof client.plRateLimit !== 'function') {
    valkey.defineCommand('plRateLimit', { numberOfKeys: 1, lua: INCR_LUA })
  }
  if (typeof client.plRateLimitRead !== 'function') {
    valkey.defineCommand('plRateLimitRead', { numberOfKeys: 1, lua: READ_LUA })
  }
}

/** What `@fastify/rate-limit` is given: a class it instantiates itself. */
export type RateLimitStoreConstructor = new (params?: unknown) => ValkeyRateLimitStore

/**
 * A store class bound to one client, one namespace and one health state.
 *
 * The plugin builds the store itself — `new Store(globalParams)` — so the
 * dependencies cannot be passed as arguments. A module-level "last
 * configuration wins" handle stood here instead, and two applications built
 * concurrently in one process would silently share whichever configured last:
 * measured, an application's counters landed under the other's namespace,
 * against the other's client. Binding them into the class the plugin receives
 * removes the shared slot rather than making the race less likely.
 */
export function createValkeyStore(deps: ValkeyStoreDeps): RateLimitStoreConstructor {
  defineScripts(deps.valkey)

  return class BoundValkeyRateLimitStore extends ValkeyRateLimitStore {
    constructor() {
      super(deps, deps.namespace)
    }
  }
}

type ScriptedClient = Valkey & {
  plRateLimit: (key: string, timeWindow: number, cb: ScriptCallback) => void
  plRateLimitRead: (key: string, cb: ScriptCallback) => void
}

/**
 * The shape `@fastify/rate-limit` uses: `incr`, `read` and `child` on an
 * instance it constructed. `child` is what gives each route its own counter,
 * so the login limit and the global limit never share a key.
 *
 * Constructed through `createValkeyStore`, which is what supplies the
 * dependencies the plugin has no way to pass.
 */
export class ValkeyRateLimitStore {
  private readonly prefix: string
  private readonly bound: ValkeyStoreDeps

  /**
   * Assigned in the body rather than declared as constructor parameter
   * properties, for the reason given on `StoreHealth`: Node strips types, it
   * does not compile them, and a parameter property is real emit.
   */
  constructor(bound: ValkeyStoreDeps, prefix: string) {
    this.bound = bound
    this.prefix = prefix
  }

  incr(key: string, cb: Callback, timeWindow: number): void {
    const { valkey, health } = this.bound
    const client = valkey as ScriptedClient

    client.plRateLimit(this.prefix + key, timeWindow, (error, result) => {
      if (error || !result) {
        health.recordFailure(error)
        cb(new RateLimitStoreUnavailableError(error))
        return
      }
      health.recordSuccess()
      cb(null, { current: result[0], ttl: result[1] })
    })
  }

  read(key: string, cb: Callback): void {
    const { valkey, health } = this.bound
    const client = valkey as ScriptedClient

    client.plRateLimitRead(this.prefix + key, (error, result) => {
      if (error || !result) {
        health.recordFailure(error)
        cb(new RateLimitStoreUnavailableError(error))
        return
      }
      health.recordSuccess()
      cb(null, { current: result[0], ttl: result[1] })
    })
  }

  /**
   * A store of its own per route, so the login limit and the global limit
   * never share a counter. The method and path are what separate them, the
   * same way the plugin's own Redis store does it.
   *
   * Both shapes are read because the plugin's published types and its
   * implementation disagree: the declaration says the argument is
   * `RouteOptions & { path, prefix }`, while the code passes an object
   * carrying `routeInfo` — which is what its own Redis store reads. Taking
   * whichever is present keeps this correct under either, rather than
   * compiling against the declaration and failing at runtime.
   */
  child(routeOptions: {
    path?: string
    prefix?: string
    method?: string | string[]
    routeInfo?: { method: string; url: string }
  }): ValkeyRateLimitStore {
    const method = routeOptions.routeInfo?.method ?? String(routeOptions.method ?? '')
    const url = routeOptions.routeInfo?.url ?? routeOptions.path ?? ''
    // The same dependencies, never a fresh lookup: a child that resolved them
    // again would be the shared slot returning by the back door.
    return new ValkeyRateLimitStore(this.bound, `${this.prefix}${method}${url}-`)
  }
}
