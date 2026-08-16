import {
  type AnyPgColumn,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { contents } from './contents.ts'
import { timestamps } from './shared.ts'

/**
 * Two tables where WordPress uses three. Taxonomies are registered in code,
 * so there is nothing to store about them.
 *
 * Terms are localized on the same model as contents: one row per translation,
 * linked by translationGroupId.
 */
export const terms = pgTable(
  'terms',
  {
    id: uuid().primaryKey().defaultRandom(),
    taxonomy: text().notNull(),
    locale: text().notNull(),
    translationGroupId: uuid().notNull().defaultRandom(),
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    parentId: uuid().references((): AnyPgColumn => terms.id, { onDelete: 'set null' }),
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('terms_taxonomy_locale_slug_uq').on(t.taxonomy, t.locale, t.slug),
    index('terms_translation_group_idx').on(t.translationGroupId),
  ],
)

export const contentTerms = pgTable(
  'content_terms',
  {
    contentId: uuid()
      .notNull()
      .references(() => contents.id, { onDelete: 'cascade' }),
    termId: uuid()
      .notNull()
      .references(() => terms.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.contentId, t.termId] }),
    index('content_terms_term_idx').on(t.termId),
  ],
)
