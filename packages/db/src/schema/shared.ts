import { customType, timestamp } from 'drizzle-orm/pg-core'

/**
 * Postgres full-text search vector. Drizzle has no built-in tsvector type.
 */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => 'tsvector',
})

/**
 * Every table carries these. Timestamps are always timezone-aware: a CMS
 * schedules publication across timezones, and a naive timestamp silently
 * loses that.
 */
export const timestamps = {
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
}
