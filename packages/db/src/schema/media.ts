import { index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { timestamps } from './shared.ts'
import { users } from './users.ts'

/**
 * Note the deliberate asymmetry with `contents`: alt text is stored as a
 * per-locale JSONB map rather than one row per translation. Alt text is a
 * short string that always has the same shape in every language and is never
 * published independently — the objections that rule out per-field
 * translation for documents do not apply here.
 */
export const media = pgTable(
  'media',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Key in the object store. Nothing executable is ever served from it. */
    storageKey: text().notNull().unique(),
    mimeType: text().notNull(),
    byteSize: integer().notNull(),
    width: integer(),
    height: integer(),
    blurhash: text(),
    /** { "en": "A red bicycle", "fr": "Un vélo rouge" } */
    alt: jsonb().$type<Record<string, string>>().notNull().default({}),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    uploadedById: uuid().references(() => users.id, { onDelete: 'set null' }),
    ...timestamps,
  },
  /*
   * The id is in the index because it is in the sort: the library pages by
   * keyset, and two uploads in the same millisecond need a tiebreak that the
   * index can answer rather than one the planner has to sort for.
   */
  (t) => [index('media_created_idx').on(t.createdAt.desc().nullsFirst(), t.id.desc().nullsFirst())],
)

/**
 * Objects whose row is gone and whose bytes are not.
 *
 * Deleting an asset touches two systems that cannot share a transaction: the
 * row lives in Postgres and the bytes in an object store. Something has to be
 * left behind when one of them fails, and it is the cheap one — an object with
 * no row costs storage, while a row with no object breaks every page that
 * renders it.
 *
 * What was missing is that the leak was invisible. A failed delete left bytes
 * nothing referenced, nothing listed and nothing would ever try again. The
 * orphan is written in the same transaction as the row deletion, so it cannot
 * be lost, and removed once the object is actually gone; a sweep retries what
 * is left. That makes a partial failure recoverable rather than merely
 * survivable.
 */
export const mediaOrphans = pgTable(
  'media_orphans',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** One row per object, not per asset: a delete can lose some renditions. */
    storageKey: text().notNull().unique(),
    /** The asset it came from, for a human reading this table during an incident. */
    mediaId: uuid().notNull(),
    attempts: integer().notNull().default(0),
    /** The last thing the store said, so a stuck orphan explains itself. */
    lastError: text(),
    ...timestamps,
  },
  (t) => [index('media_orphans_created_idx').on(t.createdAt)],
)
