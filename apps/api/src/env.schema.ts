/**
 * The shape of the environment, with no side effect.
 *
 * Separate from env.ts because that module parses `process.env` at import
 * and throws when it is incomplete — which is right for the process and
 * useless for a test: every refusal declared here has to be shown to
 * actually refuse, against inputs a real environment would never hold.
 */
import {
  isLocale,
  isLocaleList,
  LOCALES,
  parseLocaleList,
  SUPPORTED_LOCALES_MESSAGE,
} from '@presslabz/i18n'
import { z } from 'zod'

/*
 * The parsing lives in packages/i18n because the public site has to answer
 * this identically: a site that routes a language the API refuses to write is
 * two definitions of "which languages does this installation run" drifting.
 */
const localeList = z
  .string()
  .default(LOCALES.join(','))
  .refine(isLocaleList, { error: SUPPORTED_LOCALES_MESSAGE })
  .transform(parseLocaleList)

/**
 * Where the address of the client actually comes from.
 *
 * There is no boolean here on purpose. `trustProxy: true` — which is what this
 * replaces — let anyone reaching the API directly choose their own address by
 * sending a header, and with it their own rate-limit bucket. Nor is there a
 * hop count: a topology whose paths have different lengths makes a fixed
 * number of hops something an attacker can arrange to satisfy.
 */
const CLIENT_IP_SOURCES = ['socket', 'forwarded', 'header'] as const

/** One entry of TRUSTED_PROXIES: a bare address or a range, v4 or v6. */
const proxyEntry = z.union([z.ipv4(), z.ipv6(), z.cidrv4(), z.cidrv6()])

const trustedProxies = z
  .string()
  .default('')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .check((ctx) => {
    // Named one by one: "invalid list" sends an operator hunting through a
    // line they probably copied from their proxy's own configuration.
    for (const entry of ctx.value) {
      if (!proxyEntry.safeParse(entry).success) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `"${entry}" is not an IPv4/IPv6 address or CIDR range`,
        })
      }
    }
  })

/**
 * The origins allowed to send credentialed requests, exactly.
 *
 * A list rather than a single value, because an installation can legitimately
 * serve its admin from more than one name — but never a wildcard and never a
 * reflected origin: a request that carries the session cookie must name an
 * origin the operator wrote down. CORS compares scheme, host and port, so
 * `http://localhost:5173` and `http://127.0.0.1:5173` are two different
 * origins, and a browser sitting on one while the API allows the other cannot
 * even read the 401 that tells it nobody is signed in.
 *
 * Each entry must be a bare origin. A trailing slash or a path would compare
 * unequal against every request forever, which is a misconfiguration that
 * looks like working configuration.
 */
const adminOrigins = z
  .string()
  .default('http://localhost:5173')
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .check((ctx) => {
    if (ctx.value.length === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'ADMIN_ORIGIN must name at least one origin',
      })
      return
    }

    for (const entry of ctx.value) {
      let parsed: URL
      try {
        parsed = new URL(entry)
      } catch {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `"${entry}" is not an absolute origin such as https://admin.example`,
        })
        continue
      }

      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `"${entry}" must use http or https`,
        })
      } else if (entry !== parsed.origin) {
        ctx.issues.push({
          code: 'custom',
          input: ctx.value,
          message: `"${entry}" must be a bare origin — scheme, host and port only, so "${parsed.origin}"`,
        })
      }
    }
  })

/**
 * A header name, as HTTP defines one, lowercased so a comparison never depends
 * on how the operator typed it.
 */
const headerName = z
  .string()
  .regex(/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/, 'must be a valid HTTP header name')
  .transform((value) => value.toLowerCase())

/**
 * The prefix every rate-limit key carries.
 *
 * The plugin's own default is `fastify-rate-limit-`, which two PressLabz
 * installations sharing one Valkey would both use — and they would then share
 * each other's buckets. This default is ours, but it cannot tell two
 * installations apart either: that case needs a unique value per installation,
 * and nothing can detect it automatically.
 */
const namespace = z
  .string()
  .regex(/^[A-Za-z0-9:._-]{1,64}$/, 'must be 1-64 characters of A-Z a-z 0-9 : . _ -')
  .default('presslabz:rl:')

/**
 * A URL this API will actually fetch from or write to, so the scheme is
 * checked rather than assumed.
 *
 * `z.url()` accepts any scheme — `ftp://`, `file://`, `javascript:` — and an
 * endpoint setting that takes those is a setting that can point the object
 * store somewhere it was never meant to go.
 *
 * Zod's own `z.httpUrl()` is the obvious answer and cannot be used here:
 * measured against 4.4.3, it refuses `http://localhost:9000`,
 * `http://127.0.0.1:9000` and `http://storage:9000` — every hostname without a
 * public dotted suffix. That is development, Docker Compose, and any
 * installation whose bucket is a service name on an internal network. So the
 * scheme is checked and the hostname is left alone.
 */
const httpUrl = z.url().refine(
  (value) => {
    const scheme = URL.parse(value)?.protocol
    return scheme === 'http:' || scheme === 'https:'
  },
  { error: 'must be an http:// or https:// URL' },
)

const milliseconds = z.coerce.number().int().positive()

/**
 * Values this repository ships, which therefore belong to nobody.
 *
 * Every one of them is in `.env.example`, in a public repository, and a
 * `docker-compose.yml` anybody can read. In development they are a
 * convenience: a fresh clone comes up without a scavenger hunt. In production
 * they are a credential an attacker already has, and the failure they cause is
 * silent — the installation works, which is exactly why nobody notices.
 *
 * Refused by value rather than by rule, because the rule ("looks like a
 * default") cannot be written: the only thing that makes `presslabz` a bad
 * secret is that it is printed in this repository.
 */
/**
 * What a development installation gets for free, and production does not.
 *
 * Applied before parsing rather than as field defaults, because a default is
 * indistinguishable from a value once parsing is over: the schema would have
 * no way to tell an operator who configured their bucket from one who did not.
 * Outside production these fill in; in production their absence is an error
 * that names the setting.
 */
const DEVELOPMENT_STORAGE = {
  S3_ENDPOINT: 'http://localhost:9000',
  S3_BUCKET: 'presslabz-media',
  S3_ACCESS_KEY_ID: 'presslabz',
  S3_SECRET_ACCESS_KEY: 'presslabz-dev-secret',
} as const

function withDevelopmentStorage(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null) return raw

  const input = raw as Record<string, unknown>
  if (input.NODE_ENV === 'production') return input

  /*
   * Only the storage keys are filled in, and only when they are absent or
   * empty — `S3_ENDPOINT=` in a .env means "not set yet", which is the same
   * convention the admin's API URL follows.
   *
   * Deliberately not applied to every key: doing that silently redefined an
   * empty value as an absent one for the whole schema, and a test that refuses
   * an empty RATE_LIMIT_NAMESPACE caught it. An empty setting is a mistake
   * everywhere else, and staying a mistake is the point.
   */
  const filled: Record<string, unknown> = { ...input }

  for (const [name, value] of Object.entries(DEVELOPMENT_STORAGE)) {
    if (filled[name] === undefined || filled[name] === '') filled[name] = value
  }

  return filled
}

const SHIPPED_CREDENTIALS = new Set([
  'presslabz',
  'presslabz-dev-secret',
  'postgres://presslabz:presslabz@localhost:5432/presslabz',
  'redis://localhost:6379',
])

/** Whether a setting still carries what this repository ships. */
function isShipped(value: string | undefined): boolean {
  return value !== undefined && SHIPPED_CREDENTIALS.has(value)
}

const parsedEnv = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    VALKEY_URL: z.string().min(1, 'VALKEY_URL is required'),
    /** Exact origins allowed to send credentialed requests. Never a wildcard. */
    ADMIN_ORIGIN: adminOrigins,
    /* Object storage. SeaweedFS locally, any S3-compatible service in production. */
    S3_ENDPOINT: httpUrl,
    S3_REGION: z.string().default('us-east-1'),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    /**
     * Where a reader fetches media from. Separate from the endpoint the API
     * writes to, because in production those are rarely the same host: uploads
     * go to the bucket and reads come off a CDN in front of it. Defaults to
     * path-style against the endpoint, which is what the dev store serves.
     */
    MEDIA_BASE_URL: httpUrl.optional(),

    /*
     * The page cache the public site fills. Both processes must read the same
     * namespace, which is why this is an environment variable on both sides
     * rather than a value baked into either build.
     */
    /*
     * Preview links. Without a secret the API refuses to issue one and the
     * site refuses to open one — an installation with no preview is a coherent
     * installation, and a weak secret would hand over every unpublished
     * document on it.
     */
    /*
     * How often the API looks for documents whose publication time has come.
     * Zero turns the scheduler off, for an installation that would rather run
     * it elsewhere; the status then stays as inert as it was before it
     * existed, which is a choice rather than an accident.
     */
    SCHEDULER_INTERVAL_MS: z.coerce.number().int().min(0).max(3_600_000).default(60_000),

    PREVIEW_SECRET: z.string().min(32).max(512).optional(),
    PREVIEW_TTL_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
    /** Where the public site answers, for building a preview link. */
    SITE_URL: z.url().optional(),

    PAGE_CACHE_NAMESPACE: z.string().min(1).max(120).optional(),
    PAGE_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(86_400).optional(),

    DEFAULT_LOCALE: z.string().default('en').refine(isLocale),
    SUPPORTED_LOCALES: localeList,

    /* ── Client identity ────────────────────────────────────────────────── */
    CLIENT_IP_SOURCE: z.enum(CLIENT_IP_SOURCES).default('socket'),
    TRUSTED_PROXIES: trustedProxies,
    CLIENT_IP_HEADER: headerName.optional(),

    /* ── Rate limiting ──────────────────────────────────────────────────── */
    /** Prefix length the limiter groups IPv6 clients by. */
    IPV6_RATE_LIMIT_PREFIX: z.coerce.number().int().min(1).max(128).default(64),
    RATE_LIMIT_NAMESPACE: namespace,

    /* ── HTTP timeouts ──────────────────────────────────────────────────── */
    /** Socket inactivity. A transfer that keeps arriving keeps resetting it. */
    HTTP_SOCKET_IDLE_TIMEOUT_MS: milliseconds.default(60_000),
    /** Receiving the request headers. Headers are never legitimately slow. */
    HTTP_HEADERS_TIMEOUT_MS: milliseconds.default(20_000),
    /**
     * Receiving the whole request. 120s over MAX_UPLOAD_BYTES works out at
     * roughly 170 KiB/s; an installation accepting large uploads over slow
     * links has to raise it.
     */
    HTTP_REQUEST_TIMEOUT_MS: milliseconds.default(120_000),
    /**
     * The route lifecycle. Zero — disabled — on purpose: Fastify's timeout is
     * cooperative, and almost nothing here observes `request.signal`, so a
     * positive value would answer 503 while the write it was meant to stop
     * carried on and landed. The one place that does observe it is the upload
     * gate, which drops a queued upload the moment its client goes — and that
     * is the point: a request waiting for a turn can be dropped safely,
     * whereas one already writing cannot. See docs/ARCHITECTURE.md.
     */
    HTTP_HANDLER_TIMEOUT_MS: z.coerce.number().int().nonnegative().default(0),
    /** How long /health waits for a dependency before reporting it down. */
    HEALTH_CHECK_TIMEOUT_MS: milliseconds.default(2_000),
  })
  .refine((env) => env.SUPPORTED_LOCALES.includes(env.DEFAULT_LOCALE), {
    message: 'DEFAULT_LOCALE must be listed in SUPPORTED_LOCALES',
  })
  /*
   * Every option supplied is either applied or refused. An option that is
   * quietly ignored is the failure mode this whole configuration exists to
   * avoid: an operator who believes they configured a proxy and did not.
   */
  .refine((env) => env.CLIENT_IP_SOURCE !== 'forwarded' || env.TRUSTED_PROXIES.length > 0, {
    message: 'CLIENT_IP_SOURCE=forwarded requires TRUSTED_PROXIES',
  })
  .refine((env) => env.CLIENT_IP_SOURCE !== 'header' || env.TRUSTED_PROXIES.length > 0, {
    message: 'CLIENT_IP_SOURCE=header requires TRUSTED_PROXIES',
  })
  .refine((env) => env.CLIENT_IP_SOURCE !== 'header' || env.CLIENT_IP_HEADER !== undefined, {
    message: 'CLIENT_IP_SOURCE=header requires CLIENT_IP_HEADER',
  })
  .refine((env) => env.CLIENT_IP_SOURCE !== 'socket' || env.TRUSTED_PROXIES.length === 0, {
    message: 'TRUSTED_PROXIES is ignored when CLIENT_IP_SOURCE=socket; set the source or drop it',
  })
  .refine((env) => env.CLIENT_IP_SOURCE === 'header' || env.CLIENT_IP_HEADER === undefined, {
    message:
      'CLIENT_IP_HEADER is only read when CLIENT_IP_SOURCE=header; set the source or drop it',
  })
  .refine((env) => env.CLIENT_IP_HEADER !== 'x-forwarded-for', {
    message: 'CLIENT_IP_HEADER cannot be x-forwarded-for; use CLIENT_IP_SOURCE=forwarded instead',
  })
  .refine((env) => env.HTTP_HEADERS_TIMEOUT_MS <= env.HTTP_REQUEST_TIMEOUT_MS, {
    message: 'HTTP_HEADERS_TIMEOUT_MS must not exceed HTTP_REQUEST_TIMEOUT_MS',
  })
  /*
   * A production instance refuses to start on anything this repository ships.
   *
   * Defaults exist so that a clone runs; they are printed in `.env.example`
   * and in `docker-compose.yml`, so in production they are a credential
   * everybody already has. The check is by value and names the setting,
   * because "your object store is readable by the internet" is not a thing to
   * discover from an access log.
   */
  .superRefine((env, context) => {
    if (env.NODE_ENV !== 'production') return

    const shipped: [string, string | undefined][] = [
      ['S3_ACCESS_KEY_ID', env.S3_ACCESS_KEY_ID],
      ['S3_SECRET_ACCESS_KEY', env.S3_SECRET_ACCESS_KEY],
      ['DATABASE_URL', env.DATABASE_URL],
      ['VALKEY_URL', env.VALKEY_URL],
    ]

    for (const [name, value] of shipped) {
      if (isShipped(value)) {
        context.addIssue({
          code: 'custom',
          path: [name],
          message: `${name} still holds the value this repository ships. It is public; set your own.`,
        })
      }
    }
  })

/**
 * The environment, with development's conveniences applied first.
 *
 * `z.preprocess` rather than a wrapper function so that the whole rule — what
 * is supplied, what is required, and what is refused — is one schema a test
 * can hand an object to.
 */
export const envSchema = z.preprocess(withDevelopmentStorage, parsedEnv)
