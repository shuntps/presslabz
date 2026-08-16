import { jsonb, pgTable, text } from 'drizzle-orm/pg-core'
import { timestamps } from './shared.ts'

/**
 * Replaces wp_options. There is no `autoload` column: nothing is loaded
 * implicitly on every request. Callers ask for the keys they need, and the
 * object cache handles the rest.
 */
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().$type<unknown>().notNull(),
  updatedAt: timestamps.updatedAt,
})
