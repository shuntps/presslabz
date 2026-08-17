import { isIP } from 'node:net'
import { compile } from '@fastify/proxy-addr'
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify'
import fp from 'fastify-plugin'

/**
 * Who the client is, decided once per request.
 *
 * Every mechanism that needs a network identity — the rate limiter's bucket,
 * the log line — reads this one value. Two definitions of "the client address"
 * is how an interface ends up limiting one thing and logging another.
 *
 * There is no boolean and no hop count in the configuration behind it. A
 * boolean `trustProxy: true` is what let a directly-connected client pick its
 * own address, and with it its own quota, simply by sending a header. A hop
 * count is forgeable the moment a topology has paths of different lengths.
 * What is left is the honest question: which peers are proxies, named.
 */

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The client's address: full, validated, and never guessed. Used for
     * logging and for trust decisions. The rate-limit key is derived from it
     * separately — see the limiter's key generator, which groups IPv6.
     */
    clientIp: string
  }
}

/**
 * An IPv4-mapped IPv6 address and its plain form are the same client. Leaving
 * both shapes in play means one visitor holding two rate-limit buckets, and a
 * peer that slips past a CIDR list written in one notation.
 */
export function normalizeAddress(address: string | undefined): string {
  if (!address) return ''
  const trimmed = address.trim()
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed)
  return mapped?.[1] ?? trimmed
}

/** A single address, or nothing. Rejects lists, ports, ranges and prose. */
export function parseSingleAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const candidate = normalizeAddress(value)
  return isIP(candidate) === 0 ? null : candidate
}

/**
 * The policy, as options rather than as something this module reads from the
 * environment. Same reasoning as `startSessionSweep` taking its sweep as a
 * function: three modes cannot be exercised by a module that fixes one at
 * import time. It also keeps this file free of `env.ts`, which throws on an
 * incomplete environment the moment it is imported — enough to turn "this
 * suite is skipped" into "this file failed to load".
 */
export interface ClientIpOptions {
  readonly source: 'socket' | 'forwarded' | 'header'
  readonly trustedProxies: readonly string[]
  /** Required by, and only read in, `header` mode. Already lowercased. */
  readonly headerName?: string | undefined
}

/**
 * What Fastify's own `trustProxy` should be for a given mode.
 *
 * `forwarded` hands Fastify the list and lets it walk `X-Forwarded-For` from
 * the right, skipping trusted entries and stopping at the first that is not —
 * which is why no hop count is needed and why a forged prefix is never
 * reached. The other two modes trust nothing, so `request.ip` stays the
 * immediate peer, which is the only thing a client cannot choose.
 */
export function trustProxyFor(options: ClientIpOptions): boolean | string[] {
  return options.source === 'forwarded' ? [...options.trustedProxies] : false
}

export class ForwardedAddressError extends Error {
  readonly statusCode = 400
  readonly reason: 'missing_forwarded_address' | 'invalid_forwarded_address'

  constructor(reason: ForwardedAddressError['reason'], message: string) {
    super(message)
    this.name = 'ForwardedAddressError'
    this.reason = reason
  }
}

const clientIpPlugin: FastifyPluginAsync<ClientIpOptions> = async (
  app: FastifyInstance,
  options: ClientIpOptions,
) => {
  const { source, headerName } = options
  // compile() is what Fastify resolves trustProxy with, so "is this peer a
  // declared proxy" is answered by the same matcher, IPv6 included. Both
  // modes that name proxies need it: one to decide whether to read a header,
  // the other to decide whether the walk actually reached a client.
  const isTrustedPeer = source === 'socket' ? null : compile([...options.trustedProxies])

  const resolve = (request: FastifyRequest): string => {
    const peer = normalizeAddress(request.socket.remoteAddress ?? request.ip)

    if (source === 'forwarded') {
      // The matcher is always compiled in this mode; the optional call is what
      // carries that fact past the type checker without a cast.
      if (!isTrustedPeer?.(peer, 0)) {
        /*
         * Not a declared proxy, so nothing it says about identity is read —
         * Fastify's own walk has already ignored the header for the same
         * reason. Its socket address is what is left, and it is the one thing
         * a client cannot choose.
         */
        return peer
      }

      /*
       * Fastify already walked the chain against the trusted list, and that
       * walk answers "which entry is the client", not "is this an address".
       * Its documentation is explicit that request.ip and request.ips are
       * metadata to validate strictly before any security decision is taken
       * on them, and measured, it is right: with a trusted peer sending
       * `X-Forwarded-For: garbage`, request.ip was the string "garbage", the
       * limiter's key was "garbage", and evil-a and evil-b were two buckets.
       * A quota keyed on something that is not an address is not a quota.
       */
      const address = parseSingleAddress(request.ip)
      if (address === null) {
        throw new ForwardedAddressError(
          'invalid_forwarded_address',
          'X-Forwarded-For did not yield a single IP address',
        )
      }

      /*
       * The walk ended on a declared proxy, which means it never reached a
       * client: no header, an empty one, or a chain naming none but proxies.
       * Taking the proxy's own address there is the silent downgrade the
       * header mode already refuses — every visitor behind it would share one
       * identity and one quota, and nothing would say so. It fails loudly
       * instead, with no exception carved out for /health: a deployment's own
       * health check has to satisfy the contract of the mode it configured.
       *
       * It is also why a declared range must contain proxies and nothing
       * else. Ranges themselves are fine — a subnet dedicated to load
       * balancers is what CIDR notation is for — but one wide enough to hold
       * visitors would refuse those visitors here, and one holding untrusted
       * containers would let them name whoever they liked.
       */
      if (isTrustedPeer(address, 0)) {
        throw new ForwardedAddressError(
          'missing_forwarded_address',
          'Trusted proxy did not name a client in X-Forwarded-For',
        )
      }

      return address
    }

    if (source === 'socket' || !isTrustedPeer || !headerName) return peer

    // Normalised before the comparison: a v4 peer seen as ::ffff:… would
    // otherwise slip past a list written in plain v4.
    if (!isTrustedPeer(peer, 0)) {
      // Not a declared proxy, so nothing it sends about identity is believed.
      return peer
    }

    const raw = request.headers[headerName]
    if (raw === undefined) {
      /*
       * A declared proxy that does not set the header the operator said it
       * sets. Falling back would be a silent downgrade — every visitor behind
       * that proxy would share one bucket — so it fails loudly instead, which
       * is the only way the misconfiguration gets noticed.
       */
      throw new ForwardedAddressError(
        'missing_forwarded_address',
        `Trusted proxy did not send ${headerName}`,
      )
    }

    /*
     * `raw` unchanged, arrays included. Taking the first entry of a repeated
     * header would be picking one of several claims and calling it the answer;
     * the contract is a single address, and anything else is a proxy that is
     * not doing what the operator declared it does.
     */
    const address = parseSingleAddress(raw)
    if (address === null) {
      throw new ForwardedAddressError(
        'invalid_forwarded_address',
        `${headerName} is not a single IP address`,
      )
    }

    return address
  }

  /*
   * A getter, not a value assigned by a hook.
   *
   * A hook would make correctness depend on registration order: the rate
   * limiter adds its own onRequest hook when it is registered, and if it were
   * registered first it would read whatever the decoration was initialised to
   * — an empty string, shared by every caller. That is a global quota wearing
   * the costume of a per-client one, and nothing on the surface says so. A
   * getter cannot be early: it resolves when it is read, whenever that is.
   *
   * Memoised per request because the limiter, the logger and any future reader
   * must all get the same answer, and because the header parsing should happen
   * once.
   */
  const cache = new WeakMap<FastifyRequest, string>()

  app.decorateRequest('clientIp', {
    getter(this: FastifyRequest) {
      const cached = cache.get(this)
      if (cached !== undefined) return cached
      const value = resolve(this)
      cache.set(this, value)
      return value
    },
  })

  /*
   * The hook exists only to refuse early. Reading the identity is what raises
   * a malformed or missing forwarded address, and that should be answered
   * before a handler runs rather than at whatever point something happens to
   * read it.
   */
  app.addHook('onRequest', async (request: FastifyRequest) => {
    void request.clientIp
  })
}

/**
 * Wrapped with fastify-plugin so the decoration and the hook land on the root
 * instance. Registration order does not decide correctness — the identity is a
 * getter — but it is still registered before the rate limiter so that a
 * malformed forwarded address is refused before anything else runs.
 */
export default fp(clientIpPlugin, { name: 'presslabz-client-ip' })
