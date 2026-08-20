import { envSchema } from './env.schema.ts'

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n')
  throw new Error(`Invalid environment.\n${issues}\n\nCopy .env.example to .env and fill it in.`)
}

export const env = parsed.data
