import { isLocale, LOCALES } from '@presslabz/i18n'
import { z } from 'zod'

const localeList = z
  .string()
  .default(LOCALES.join(','))
  .transform((value) => value.split(',').map((part) => part.trim()))
  .refine((list) => list.length > 0 && list.every(isLocale), {
    message: `SUPPORTED_LOCALES must be a comma-separated subset of: ${LOCALES.join(', ')}`,
  })

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_HOST: z.string().default('127.0.0.1'),
    API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
    DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
    VALKEY_URL: z.string().min(1, 'VALKEY_URL is required'),
    /** Exact origin allowed to send credentialed requests. Never a wildcard. */
    ADMIN_ORIGIN: z.string().url().default('http://localhost:5173'),
    DEFAULT_LOCALE: z.string().default('en').refine(isLocale),
    SUPPORTED_LOCALES: localeList,
  })
  .refine((env) => env.SUPPORTED_LOCALES.includes(env.DEFAULT_LOCALE), {
    message: 'DEFAULT_LOCALE must be listed in SUPPORTED_LOCALES',
  })

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`Invalid environment.\n${issues}\n\nCopy .env.example to .env and fill it in.`)
}

export const env = parsed.data
export type Env = typeof env
