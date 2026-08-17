import net from 'node:net'
import rateLimit, { normalizeIP } from '@fastify/rate-limit'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, describe, expect, it } from 'vitest'
import clientIpPlugin, {
  type ClientIpOptions,
  normalizeAddress,
  parseSingleAddress,
  trustProxyFor,
} from './client-ip.ts'
import { registerErrorHandling } from './errors.ts'

/*
 * The question these answer is not "what is the address" but "who is allowed
 * to say". A client reaching the API directly could set X-Forwarded-For and
 * take a fresh rate-limit allowance with it; that is the hole, and every case
 * below is a way somebody might try to reopen it.
 *
 * The addresses are documentation ranges (RFC 5737 / 3849) so nothing here
 * resembles a real host.
 */

const TRAEFIK = '10.20.0.2'
const TRAEFIK_V6 = 'fd00:20::2'
const CLOUDFLARED = '10.20.0.3'
const VISITOR = '203.0.113.42'
const VISITOR_V6 = '2001:db8:cafe::42'
const OUTSIDER = '198.51.100.7'

let app: FastifyInstance | null = null

afterEach(async () => {
  await app?.close()
  app = null
})

async function serve(options: ClientIpOptions) {
  const instance = Fastify({ trustProxy: trustProxyFor(options) })
  registerErrorHandling(instance)
  await instance.register(clientIpPlugin, options)
  instance.get('/who', async (request) => ({ clientIp: request.clientIp }))
  await instance.ready()
  app = instance

  return async (remoteAddress: string, headers: Record<string, string> = {}) => {
    const response = await instance.inject({ url: '/who', remoteAddress, headers })
    return { status: response.statusCode, body: response.json() }
  }
}

const socketMode: ClientIpOptions = { source: 'socket', trustedProxies: [] }
const forwardedMode: ClientIpOptions = {
  source: 'forwarded',
  trustedProxies: [TRAEFIK, CLOUDFLARED, TRAEFIK_V6],
}
const headerMode: ClientIpOptions = {
  source: 'header',
  trustedProxies: [TRAEFIK, TRAEFIK_V6],
  headerName: 'cf-connecting-ip',
}

describe('normalizing an address', () => {
  it('reduces an IPv4-mapped IPv6 address to the address it is', () => {
    // Two shapes of one client is two rate-limit buckets, and a peer that
    // slips past a CIDR list written in the other notation.
    expect(normalizeAddress('::ffff:203.0.113.42')).toBe('203.0.113.42')
    expect(normalizeAddress('::FFFF:203.0.113.42')).toBe('203.0.113.42')
  })

  it('leaves everything else alone', () => {
    expect(normalizeAddress('203.0.113.42')).toBe('203.0.113.42')
    expect(normalizeAddress('2001:db8::1')).toBe('2001:db8::1')
    expect(normalizeAddress(undefined)).toBe('')
  })
})

describe('reading a single address from a header', () => {
  it('accepts one address, v4 or v6', () => {
    expect(parseSingleAddress('203.0.113.42')).toBe('203.0.113.42')
    expect(parseSingleAddress('2001:db8::1')).toBe('2001:db8::1')
    expect(parseSingleAddress('::ffff:203.0.113.42')).toBe('203.0.113.42')
  })

  it('refuses everything that is not exactly one address', () => {
    // A list, a port, prose, a range: each of these has been someone's idea of
    // what belongs in a forwarding header, and none of them is an identity.
    for (const value of [
      '203.0.113.42, 198.51.100.9',
      '203.0.113.42:443',
      '[2001:db8::1]:443',
      ' 203.0.113.42 extra',
      'not-an-address',
      '',
      '999.1.1.1',
      '203.0.113.0/24',
      undefined,
      42,
      // Anything that is not a string is refused rather than indexed into. A
      // repeated header does not arrive in this shape — Node joins it — but a
      // single address is the contract whatever hands the value over.
      ['203.0.113.42'],
      ['203.0.113.42', '198.51.100.9'],
    ]) {
      expect(parseSingleAddress(value), String(value)).toBeNull()
    }
  })
})

describe('socket mode — the default, and what a direct installation gets', () => {
  it('uses the peer and believes no header at all', async () => {
    const ask = await serve(socketMode)

    expect((await ask(OUTSIDER)).body.clientIp).toBe(OUTSIDER)
    expect((await ask(OUTSIDER, { 'x-forwarded-for': VISITOR })).body.clientIp).toBe(OUTSIDER)
    expect((await ask(OUTSIDER, { 'cf-connecting-ip': VISITOR })).body.clientIp).toBe(OUTSIDER)
    expect(
      (await ask(OUTSIDER, { 'x-forwarded-for': VISITOR, 'cf-connecting-ip': VISITOR })).body
        .clientIp,
    ).toBe(OUTSIDER)
  })

  it('normalizes an IPv4-mapped peer', async () => {
    const ask = await serve(socketMode)
    expect((await ask('::ffff:198.51.100.7')).body.clientIp).toBe(OUTSIDER)
  })
})

describe('forwarded mode — a standard reverse proxy', () => {
  it('finds the visitor at the end of an honest chain', async () => {
    const ask = await serve(forwardedMode)
    const chain = `${VISITOR}, ${CLOUDFLARED}`
    expect((await ask(TRAEFIK, { 'x-forwarded-for': chain })).body.clientIp).toBe(VISITOR)
  })

  it('never reaches a prefix the client forged', async () => {
    /*
     * Cloudflare and every other proxy append. Whatever the client sent stays
     * to the left of the address the first honest hop added, and the walk from
     * the right stops before it.
     */
    const ask = await serve(forwardedMode)
    const forged = `1.2.3.4, 5.6.7.8, ${VISITOR}, ${CLOUDFLARED}`
    expect((await ask(TRAEFIK, { 'x-forwarded-for': forged })).body.clientIp).toBe(VISITOR)
  })

  it('is not fooled by a forged entry that names a trusted proxy', async () => {
    const ask = await serve(forwardedMode)
    const forged = `${CLOUDFLARED}, ${VISITOR}, ${CLOUDFLARED}`
    expect((await ask(TRAEFIK, { 'x-forwarded-for': forged })).body.clientIp).toBe(VISITOR)
  })

  it('works when a hop appends nothing, so no hop count is needed', async () => {
    const ask = await serve(forwardedMode)
    expect((await ask(TRAEFIK, { 'x-forwarded-for': VISITOR })).body.clientIp).toBe(VISITOR)
  })

  it('ignores a chain offered by something that is not a declared proxy', async () => {
    const ask = await serve(forwardedMode)
    const chain = `${VISITOR}, ${CLOUDFLARED}`
    expect((await ask(OUTSIDER, { 'x-forwarded-for': chain })).body.clientIp).toBe(OUTSIDER)
  })

  it('carries IPv6 through, including a v6 visitor behind a v4 chain', async () => {
    const ask = await serve(forwardedMode)
    expect(
      (await ask(TRAEFIK_V6, { 'x-forwarded-for': `${VISITOR_V6}, ${CLOUDFLARED}` })).body.clientIp,
    ).toBe(VISITOR_V6)
    expect(
      (await ask(TRAEFIK, { 'x-forwarded-for': `${VISITOR_V6}, ${CLOUDFLARED}` })).body.clientIp,
    ).toBe(VISITOR_V6)
  })

  it('reduces an IPv4-mapped entry to the address it is', async () => {
    const ask = await serve(forwardedMode)
    expect(
      (await ask(TRAEFIK, { 'x-forwarded-for': `::ffff:${VISITOR}, ${CLOUDFLARED}` })).body
        .clientIp,
    ).toBe(VISITOR)
  })
})

describe('forwarded mode — the chain says what it likes, and is checked', () => {
  /*
   * Fastify's walk answers "which entry is the client", never "is this an
   * address", and its documentation says request.ip and request.ips are
   * metadata to validate strictly before any security decision. Measured
   * before this: a trusted peer sending `X-Forwarded-For: garbage` was
   * answered 200, request.clientIp was the string "garbage", and evil-a and
   * evil-b were two rate-limit buckets — a fresh allowance per invented word.
   */
  it('refuses a chain that does not end in exactly one address', async () => {
    const ask = await serve(forwardedMode)

    for (const forged of [
      'garbage',
      'evil-a',
      'evil-b',
      `${VISITOR}, nonsense`,
      `${VISITOR}:443`,
      '203.0.113.0/24',
      '999.1.1.1',
      `${VISITOR} extra`,
      'localhost',
    ]) {
      const response = await ask(TRAEFIK, { 'x-forwarded-for': forged })
      expect(response.status, forged).toBe(400)
      expect(response.body.reason, forged).toBe('invalid_forwarded_address')
    }
  })

  it('refuses a trusted proxy that names no client at all', async () => {
    /*
     * The walk ends on the proxy itself when there is no header, when it is
     * empty, and when the chain names none but proxies. Accepting its address
     * there would give every visitor behind it one identity and one quota,
     * silently — the same downgrade the header mode already refuses. There is
     * no exception for a health check either: a deployment's own probe has to
     * satisfy the contract of the mode it configured.
     */
    const ask = await serve(forwardedMode)

    const cases: [string, Record<string, string>][] = [
      ['no header at all', {}],
      ['an empty header', { 'x-forwarded-for': '' }],
      ['a header naming only proxies', { 'x-forwarded-for': `${CLOUDFLARED}, ${TRAEFIK}` }],
      ['a header naming only itself', { 'x-forwarded-for': TRAEFIK }],
    ]

    for (const [label, headers] of cases) {
      const response = await ask(TRAEFIK, headers)
      expect(response.status, label).toBe(400)
      expect(response.body.reason, label).toBe('missing_forwarded_address')
    }
  })

  it('leaves a peer that is not a declared proxy on its socket address', async () => {
    /*
     * The refusal above is about proxies, not about everyone. Something
     * reaching the API directly keeps the address it connected from, header or
     * no header — that is the one value it cannot choose.
     */
    const ask = await serve(forwardedMode)

    expect((await ask(OUTSIDER)).body.clientIp).toBe(OUTSIDER)
    expect((await ask(OUTSIDER, { 'x-forwarded-for': '' })).body.clientIp).toBe(OUTSIDER)
    expect((await ask(OUTSIDER, { 'x-forwarded-for': 'garbage' })).body.clientIp).toBe(OUTSIDER)
    expect((await ask(OUTSIDER, { 'x-forwarded-for': VISITOR })).body.clientIp).toBe(OUTSIDER)
    expect((await ask(`::ffff:${OUTSIDER}`)).body.clientIp).toBe(OUTSIDER)
  })

  it('never turns a malformed chain into a rate limit key', async () => {
    /*
     * The property the refusal exists for, asserted where it bites: the key
     * generator is never reached at all, so no invented value can become a
     * bucket. An honest chain still gets its own, keyed on the visitor rather
     * than on the proxy.
     */
    const instance = Fastify({ trustProxy: trustProxyFor(forwardedMode) })
    registerErrorHandling(instance)
    await instance.register(clientIpPlugin, forwardedMode)

    const keys: string[] = []
    await instance.register(rateLimit, {
      max: 1_000,
      timeWindow: '1 minute',
      keyGenerator: (request) => {
        const key = normalizeIP(request.clientIp, 64)
        keys.push(key)
        return key
      },
    })
    instance.get('/who', async (request) => ({ clientIp: request.clientIp }))
    await instance.ready()

    try {
      const forged = ['evil-a', 'evil-b', 'garbage', `${VISITOR}, evil-c`]
      const statuses: number[] = []
      for (const value of forged) {
        const response = await instance.inject({
          url: '/who',
          remoteAddress: TRAEFIK,
          headers: { 'x-forwarded-for': value },
        })
        statuses.push(response.statusCode)
      }

      expect(statuses).toEqual([400, 400, 400, 400])
      expect(keys).toEqual([])

      const honest = await instance.inject({
        url: '/who',
        remoteAddress: TRAEFIK,
        headers: { 'x-forwarded-for': `${VISITOR}, ${CLOUDFLARED}` },
      })
      expect(honest.statusCode).toBe(200)
      expect(keys).toEqual([VISITOR])
    } finally {
      await instance.close()
    }
  })
})

describe('header mode — a proxy that publishes a canonical address', () => {
  it('reads the header when the peer is a declared proxy', async () => {
    const ask = await serve(headerMode)
    expect((await ask(TRAEFIK, { 'cf-connecting-ip': VISITOR })).body.clientIp).toBe(VISITOR)
    expect((await ask(TRAEFIK_V6, { 'cf-connecting-ip': VISITOR_V6 })).body.clientIp).toBe(
      VISITOR_V6,
    )
  })

  it('ignores it entirely from anything else', async () => {
    // The gate is the socket address, which is the one thing a client cannot
    // choose. Any container that can reach the API would otherwise forge this.
    const ask = await serve(headerMode)
    expect((await ask(OUTSIDER, { 'cf-connecting-ip': VISITOR })).body.clientIp).toBe(OUTSIDER)
  })

  it('compares the peer after normalizing it', async () => {
    // A v4 peer arriving as ::ffff:… would otherwise miss a list written in
    // plain v4 and be treated as an outsider.
    const ask = await serve(headerMode)
    expect((await ask(`::ffff:${TRAEFIK}`, { 'cf-connecting-ip': VISITOR })).body.clientIp).toBe(
      VISITOR,
    )
  })

  it('refuses the request when a declared proxy sends nothing', async () => {
    /*
     * Falling back would be a silent downgrade: every visitor behind that
     * proxy would share one bucket, and the misconfiguration would never be
     * noticed. 400 is deliberate, and it is about the deployment.
     */
    const ask = await serve(headerMode)
    const response = await ask(TRAEFIK)

    expect(response.status).toBe(400)
    expect(response.body.reason).toBe('missing_forwarded_address')
  })

  it('refuses the request when a declared proxy sends something unusable', async () => {
    const ask = await serve(headerMode)

    for (const value of ['203.0.113.42, 198.51.100.9', '203.0.113.42:443', 'nonsense', '']) {
      const response = await ask(TRAEFIK, { 'cf-connecting-ip': value })
      expect(response.status, value).toBe(400)
      expect(response.body.reason, value).toBe('invalid_forwarded_address')
    }
  })

  it('refuses a header the proxy sent twice, over a real connection', async () => {
    /*
     * Two claims are not an identity, and this is the shape a proxy sending
     * twice actually produces. Measured rather than assumed: Node's parser
     * joins repeated occurrences into one comma-separated value — both through
     * a socket and through inject — so the value arrives as a list and is
     * refused as one. It is never handed over as an array to be indexed into,
     * which is why nothing here picks a first entry.
     */
    const instance = Fastify({ trustProxy: trustProxyFor(headerMode) })
    registerErrorHandling(instance)
    await instance.register(clientIpPlugin, { ...headerMode, trustedProxies: ['127.0.0.1'] })
    instance.get('/who', async (request) => ({ clientIp: request.clientIp }))
    await instance.listen({ host: '127.0.0.1', port: 0 })

    try {
      const address = instance.server.address()
      if (!address || typeof address === 'string') throw new Error('expected a TCP address')

      const answer = await new Promise<string>((resolve) => {
        let received = ''
        const socket = net.connect(address.port, '127.0.0.1', () => {
          socket.write(
            `GET /who HTTP/1.1\r\nHost: localhost\r\ncf-connecting-ip: ${VISITOR}\r\ncf-connecting-ip: ${OUTSIDER}\r\nConnection: close\r\n\r\n`,
          )
        })
        socket.on('data', (chunk) => {
          received += chunk.toString()
        })
        socket.on('close', () => resolve(received))
        socket.on('error', () => resolve(received))
      })

      expect(answer).toContain('400')
      expect(answer).toContain('invalid_forwarded_address')
      expect(answer).not.toContain(VISITOR)
    } finally {
      await instance.close()
    }
  })

  it('does not read X-Forwarded-For in this mode', async () => {
    const ask = await serve(headerMode)
    const response = await ask(TRAEFIK, {
      'x-forwarded-for': VISITOR,
      'cf-connecting-ip': '203.0.113.99',
    })
    expect(response.body.clientIp).toBe('203.0.113.99')
  })
})

describe('the identity does not depend on registration order', () => {
  it('resolves when it is read, even if the limiter was registered first', async () => {
    /*
     * A hook-assigned value would leave clientIp at its decorated default for
     * anything registered earlier — every caller sharing one bucket, with
     * nothing on the surface to say so. A getter cannot be early.
     */
    const instance = Fastify()
    registerErrorHandling(instance)

    const seen: string[] = []
    // Registered before the identity plugin, exactly the wrong way round.
    instance.addHook('onRequest', async (request) => {
      seen.push(request.clientIp)
    })
    await instance.register(clientIpPlugin, socketMode)
    instance.get('/who', async (request) => ({ clientIp: request.clientIp }))
    await instance.ready()

    try {
      const response = await instance.inject({ url: '/who', remoteAddress: OUTSIDER })
      expect(response.json().clientIp).toBe(OUTSIDER)
      expect(seen).toEqual([OUTSIDER])
    } finally {
      await instance.close()
    }
  })

  it('resolves once and gives the same answer to every reader', async () => {
    const instance = Fastify()
    registerErrorHandling(instance)
    await instance.register(clientIpPlugin, socketMode)
    instance.get('/who', async (request) => ({
      first: request.clientIp,
      second: request.clientIp,
    }))
    await instance.ready()

    try {
      const body = (await instance.inject({ url: '/who', remoteAddress: OUTSIDER })).json()
      expect(body.first).toBe(OUTSIDER)
      expect(body.second).toBe(OUTSIDER)
    } finally {
      await instance.close()
    }
  })
})
