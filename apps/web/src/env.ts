import { resolveMediaBase } from '@presslabz/core'
import { type LocaleConfig, resolveLocaleConfig } from '@presslabz/i18n'
import { z } from 'zod'

/**
 * The environment this site runs under, validated once at boot.
 *
 * Same shape as the API's: parse at import, throw on anything missing, and
 * never reach for `process.env` anywhere else. A site that starts with half a
 * configuration answers requests with errors that name the wrong cause.
 *
 * Zod rather than `astro:env`, deliberately. The project already states its
 * environment in one place and one style, and every variable here is also read
 * by the API — DATABASE_URL, the S3 pair, the locale pair. Two schemas for one
 * .env is how they drift.
 */

if (!process.env.DATABASE_URL) {
  try {
    process.loadEnvFile(new URL('../../../.env', import.meta.url).pathname)
  } catch {
    // A deployment supplies the environment directly; the schema decides.
  }
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  DATABASE_URL: z.url(),
  /** Absolute URLs — canonical tags, hreflang, the sitemap — are built on it. */
  SITE_URL: z.url().default('http://localhost:4321'),
  /*
   * The name a reader sees. An environment variable until settings are
   * exposed: it belongs in the settings table, and putting it there now would
   * mean a database read on every page for a string that changes once a year.
   */
  SITE_NAME: z.string().min(1).max(120).default('PressLabz'),
  S3_ENDPOINT: z.url(),
  S3_BUCKET: z.string().min(1),
  MEDIA_BASE_URL: z.url().optional(),
  DEFAULT_LOCALE: z.string().optional(),
  SUPPORTED_LOCALES: z.string().optional(),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const problems = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`The public site cannot start with this environment:\n${problems}`)
}

export const env = parsed.data

export const localeConfig: LocaleConfig = resolveLocaleConfig({
  supported: env.SUPPORTED_LOCALES,
  default: env.DEFAULT_LOCALE,
})

/*
 * Astro's i18n routing is configured at build time, so the locale list is
 * baked into the bundle. Starting that bundle under a different SUPPORTED_
 * LOCALES is a site whose routes and whose framework disagree about which
 * languages exist — Astro.currentLocale comes back undefined for the added
 * one, and the failure looks like a template bug rather than a stale build.
 */
const built = typeof __BUILT_LOCALES__ === 'undefined' ? null : __BUILT_LOCALES__

if (built) {
  const missing = localeConfig.locales.filter((locale) => !built.includes(locale))
  if (missing.length > 0) {
    throw new Error(
      `SUPPORTED_LOCALES adds ${missing.join(', ')} to a build made for ${built.join(', ')}. ` +
        'The locale list is fixed when the site is built; build again.',
    )
  }
}

export const mediaBase = resolveMediaBase({
  mediaBaseUrl: env.MEDIA_BASE_URL,
  s3Endpoint: env.S3_ENDPOINT,
  s3Bucket: env.S3_BUCKET,
})
