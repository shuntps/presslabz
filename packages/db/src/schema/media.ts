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
  (t) => [index('media_created_idx').on(t.createdAt)],
)
