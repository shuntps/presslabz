import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'drizzle-kit'

// Load the repository-root .env when there is one. CI sets the variables
// directly, so a missing file is not an error.
const envFile = fileURLToPath(new URL('../../.env', import.meta.url))
if (existsSync(envFile)) {
  process.loadEnvFile(envFile)
}

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env at the repository root.')
}

export default defineConfig({
  schema: './src/schema/index.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Table and column names are snake_case in SQL, camelCase in TypeScript.
  // Declared here and in the client so the mapping is defined exactly once.
  casing: 'snake_case',
  dbCredentials: { url },
  strict: true,
  verbose: true,
})
