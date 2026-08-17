import { describe, expect, it } from 'vitest'
import { envSchema } from './env.schema.ts'

/*
 * Every option supplied is either applied or refused at startup. An option
 * that is quietly ignored is the failure this configuration exists to prevent:
 * an operator who believes they declared a proxy and did not, running an API
 * that trusts nobody while its logs say visitors all share one address — or,
 * worse, the reverse.
 */

const BASE = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  VALKEY_URL: 'redis://localhost:6379',
}

const parse = (overrides: Record<string, string> = {}) =>
  envSchema.safeParse({ ...BASE, ...overrides })

const messagesOf = (result: ReturnType<typeof parse>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.message)

describe('defaults', () => {
  it('trusts nothing when nothing is configured', () => {
    const result = parse()
    expect(result.success).toBe(true)
    expect(result.success && result.data.CLIENT_IP_SOURCE).toBe('socket')
    expect(result.success && result.data.TRUSTED_PROXIES).toEqual([])
    expect(result.success && result.data.CLIENT_IP_HEADER).toBeUndefined()
  })

  it('leaves the application timeout off', () => {
    // Fastify's handler timeout is cooperative and nothing here observes
    // request.signal yet, so a positive default would answer 503 while the
    // write it was meant to stop carried on.
    const result = parse()
    expect(result.success && result.data.HTTP_HANDLER_TIMEOUT_MS).toBe(0)
  })

  it('groups IPv6 clients by /64 and prefixes keys with something of ours', () => {
    const result = parse()
    expect(result.success && result.data.IPV6_RATE_LIMIT_PREFIX).toBe(64)
    expect(result.success && result.data.RATE_LIMIT_NAMESPACE).toBe('presslabz:rl:')
  })
})

describe('the trusted proxy list', () => {
  it('accepts addresses and ranges, v4 and v6', () => {
    const result = parse({
      CLIENT_IP_SOURCE: 'forwarded',
      TRUSTED_PROXIES: '10.20.0.2, 10.20.0.0/24, fd00:20::2, fd00:20::/64',
    })
    expect(result.success).toBe(true)
    expect(result.success && result.data.TRUSTED_PROXIES).toHaveLength(4)
  })

  it('names the entry that is wrong rather than the list', () => {
    const result = parse({ CLIENT_IP_SOURCE: 'forwarded', TRUSTED_PROXIES: '10.20.0.2, nonsense' })
    expect(result.success).toBe(false)
    expect(messagesOf(result).join('\n')).toContain('"nonsense"')
  })

  it('refuses a range that is not one', () => {
    const result = parse({ CLIENT_IP_SOURCE: 'forwarded', TRUSTED_PROXIES: '10.20.0.0/99' })
    expect(result.success).toBe(false)
  })
})

describe('modes that would silently do nothing', () => {
  it('refuses forwarded with no proxies to trust', () => {
    const result = parse({ CLIENT_IP_SOURCE: 'forwarded' })
    expect(messagesOf(result)).toContain('CLIENT_IP_SOURCE=forwarded requires TRUSTED_PROXIES')
  })

  it('refuses header mode with no proxies', () => {
    const result = parse({ CLIENT_IP_SOURCE: 'header', CLIENT_IP_HEADER: 'cf-connecting-ip' })
    expect(messagesOf(result)).toContain('CLIENT_IP_SOURCE=header requires TRUSTED_PROXIES')
  })

  it('refuses header mode with no header to read', () => {
    const result = parse({ CLIENT_IP_SOURCE: 'header', TRUSTED_PROXIES: '10.20.0.2' })
    expect(messagesOf(result)).toContain('CLIENT_IP_SOURCE=header requires CLIENT_IP_HEADER')
  })

  it('refuses proxies declared in socket mode, where they are ignored', () => {
    // The mistake this catches: the CIDRs were set and the mode was not.
    const result = parse({ TRUSTED_PROXIES: '10.20.0.2' })
    expect(messagesOf(result).join('\n')).toContain('ignored when CLIENT_IP_SOURCE=socket')
  })

  it('refuses a header name in forwarded mode, where it is ignored', () => {
    const result = parse({
      CLIENT_IP_SOURCE: 'forwarded',
      TRUSTED_PROXIES: '10.20.0.2',
      CLIENT_IP_HEADER: 'cf-connecting-ip',
    })
    expect(messagesOf(result).join('\n')).toContain('only read when CLIENT_IP_SOURCE=header')
  })

  it('refuses a header name in socket mode too', () => {
    const result = parse({ CLIENT_IP_HEADER: 'cf-connecting-ip' })
    expect(messagesOf(result).join('\n')).toContain('only read when CLIENT_IP_SOURCE=header')
  })

  it('sends someone naming X-Forwarded-For to the mode that reads it', () => {
    const result = parse({
      CLIENT_IP_SOURCE: 'header',
      TRUSTED_PROXIES: '10.20.0.2',
      CLIENT_IP_HEADER: 'X-Forwarded-For',
    })
    expect(messagesOf(result).join('\n')).toContain('use CLIENT_IP_SOURCE=forwarded instead')
  })

  it('lowercases the header name so a comparison never depends on typing', () => {
    const result = parse({
      CLIENT_IP_SOURCE: 'header',
      TRUSTED_PROXIES: '10.20.0.2',
      CLIENT_IP_HEADER: 'CF-Connecting-IP',
    })
    expect(result.success && result.data.CLIENT_IP_HEADER).toBe('cf-connecting-ip')
  })

  it('refuses a header name that is not one', () => {
    const result = parse({
      CLIENT_IP_SOURCE: 'header',
      TRUSTED_PROXIES: '10.20.0.2',
      CLIENT_IP_HEADER: 'not a header',
    })
    expect(result.success).toBe(false)
  })

  it('refuses a source it does not implement', () => {
    expect(parse({ CLIENT_IP_SOURCE: 'trust-everyone' }).success).toBe(false)
  })
})

describe('the rate limit namespace', () => {
  it('accepts a prefix an operator would actually write', () => {
    const result = parse({ RATE_LIMIT_NAMESPACE: 'presslabz:site-a:rl:' })
    expect(result.success && result.data.RATE_LIMIT_NAMESPACE).toBe('presslabz:site-a:rl:')
  })

  it('refuses whitespace, emptiness and a prefix nobody meant to type', () => {
    for (const value of ['', ' ', 'with space', 'new\nline', 'x'.repeat(65)]) {
      expect(parse({ RATE_LIMIT_NAMESPACE: value }).success, JSON.stringify(value)).toBe(false)
    }
  })
})

describe('the IPv6 grouping prefix', () => {
  it('accepts a prefix length', () => {
    expect(parse({ IPV6_RATE_LIMIT_PREFIX: '56' }).success).toBe(true)
    expect(parse({ IPV6_RATE_LIMIT_PREFIX: '128' }).success).toBe(true)
  })

  it('refuses one that is not', () => {
    for (const value of ['0', '129', '-1', '64.5', 'sixty-four']) {
      expect(parse({ IPV6_RATE_LIMIT_PREFIX: value }).success, value).toBe(false)
    }
  })
})

describe('timeouts', () => {
  it('refuses headers taking longer than the whole request', () => {
    const result = parse({ HTTP_HEADERS_TIMEOUT_MS: '30000', HTTP_REQUEST_TIMEOUT_MS: '20000' })
    expect(messagesOf(result)).toContain(
      'HTTP_HEADERS_TIMEOUT_MS must not exceed HTTP_REQUEST_TIMEOUT_MS',
    )
  })

  it('refuses zero for every timeout except the application one', () => {
    // Zero means "off", which is the state this work exists to leave.
    expect(parse({ HTTP_SOCKET_IDLE_TIMEOUT_MS: '0' }).success).toBe(false)
    expect(parse({ HTTP_HEADERS_TIMEOUT_MS: '0' }).success).toBe(false)
    expect(parse({ HTTP_REQUEST_TIMEOUT_MS: '0' }).success).toBe(false)
    expect(parse({ HEALTH_CHECK_TIMEOUT_MS: '0' }).success).toBe(false)
  })

  it('allows zero for the application timeout, and only there', () => {
    const result = parse({ HTTP_HANDLER_TIMEOUT_MS: '0' })
    expect(result.success).toBe(true)
    expect(parse({ HTTP_HANDLER_TIMEOUT_MS: '-1' }).success).toBe(false)
  })

  it('accepts a positive application timeout, which is the operator to decide', () => {
    /*
     * Off is the default, not the contract. Fastify's handler timeout is
     * cooperative: it answers 503 and aborts request.signal, and nothing here
     * observes that signal yet, so a positive value bounds the answer and not
     * the work. That is a real trade-off an operator may want — a slow route
     * answered rather than left open — so the schema takes it rather than
     * refusing a value the server supports.
     */
    const result = parse({ HTTP_HANDLER_TIMEOUT_MS: '30000' })
    expect(result.success && result.data.HTTP_HANDLER_TIMEOUT_MS).toBe(30_000)
  })
})

describe('the admin origins', () => {
  it('defaults to one exact localhost origin', () => {
    const result = parse()
    expect(result.success && result.data.ADMIN_ORIGIN).toEqual(['http://localhost:5173'])
  })

  it('takes the loopback alternative, chosen entirely through configuration', () => {
    const result = parse({ ADMIN_ORIGIN: 'http://127.0.0.1:5173' })
    expect(result.success && result.data.ADMIN_ORIGIN).toEqual(['http://127.0.0.1:5173'])
  })

  it('takes a list, for an installation with more than one admin name', () => {
    const result = parse({ ADMIN_ORIGIN: 'https://admin.example, https://staff.example' })
    expect(result.success && result.data.ADMIN_ORIGIN).toEqual([
      'https://admin.example',
      'https://staff.example',
    ])
  })

  it('refuses a wildcard, which cannot carry a cookie anyway', () => {
    expect(parse({ ADMIN_ORIGIN: '*' }).success).toBe(false)
  })

  it('refuses anything that is not a bare origin', () => {
    // A trailing slash or a path compares unequal against every request
    // forever: a misconfiguration that looks like a configuration.
    for (const value of [
      'http://localhost:5173/',
      'http://localhost:5173/admin',
      'localhost:5173',
      'ftp://localhost:5173',
      '',
    ]) {
      expect(parse({ ADMIN_ORIGIN: value }).success, JSON.stringify(value)).toBe(false)
    }
  })

  it('names the entry that is wrong rather than the list', () => {
    const result = parse({ ADMIN_ORIGIN: 'https://admin.example, nonsense' })
    expect(messagesOf(result).join('\n')).toContain('"nonsense"')
  })
})
