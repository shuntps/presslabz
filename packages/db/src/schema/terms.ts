import { sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { contents } from './contents.ts'
import { timestamps } from './shared.ts'

/**
 * Taxonomies, terms, and what a document is filed under.
 *
 * **Reserved, not operational.** These tables carry no repository, no routes
 * and no interface: a content type lists its taxonomies as strings and nothing
 * yet writes a term. What they do carry is every invariant the feature will
 * need, because a schema that is present and unconstrained is the worst of the
 * three states — it invites rows that a later version cannot make sense of,
 * and the migration that repairs them is written against data nobody can
 * reconstruct.
 *
 * Two tables where the classic content managers use three. Taxonomies are
 * registered in code, so there is nothing to store about them, and no row can
 * declare a taxonomy that no content type mentions.
 */

/**
 * A term and its translations, exactly as `translation_groups` is for content:
 * the row is the serialization point, and the type it belongs to — here the
 * taxonomy — is a column, so "every member of a group is in one taxonomy" is
 * the database's answer rather than the application's.
 */
export const termGroups = pgTable(
  'term_groups',
  {
    id: uuid().primaryKey().defaultRandom(),
    taxonomy: text().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    // Redundant for uniqueness and required anyway: a composite foreign key
    // may only reference columns that carry a unique constraint.
    unique('term_groups_id_taxonomy_uq').on(t.id, t.taxonomy),
  ],
)

export const terms = pgTable(
  'terms',
  {
    id: uuid().primaryKey().defaultRandom(),
    taxonomy: text().notNull(),
    locale: text().notNull(),
    translationGroupId: uuid().notNull(),
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

    /*
     * A group holds one taxonomy, and one translation per language. Both were
     * representable before: `translationGroupId` defaulted to a fresh uuid
     * with no group to point at, so two French translations of one term, or a
     * group holding a category and a tag, were rows the database would have
     * accepted.
     */
    foreignKey({
      name: 'terms_group_fk',
      columns: [t.translationGroupId, t.taxonomy],
      foreignColumns: [termGroups.id, termGroups.taxonomy],
    }).onDelete('restrict'),
    uniqueIndex('terms_group_locale_uq').on(t.translationGroupId, t.locale),

    /* The two shapes a composite foreign key needs to point at a term. */
    unique('terms_id_taxonomy_locale_uq').on(t.id, t.taxonomy, t.locale),
    unique('terms_id_locale_uq').on(t.id, t.locale),

    /*
     * A parent is a term of the same taxonomy in the same language — a
     * category nested under a tag is not a hierarchy, it is a mistake with a
     * foreign key. Same shape as a page's parent, and `restrict` for the same
     * reason: deleting a parent must not silently take its children.
     */
    foreignKey({
      name: 'terms_parent_fk',
      columns: [t.parentId, t.taxonomy, t.locale],
      foreignColumns: [t.id, t.taxonomy, t.locale],
    }).onDelete('restrict'),
    check('terms_parent_not_self', sql`${t.parentId} is distinct from ${t.id}`),
  ],
)

/**
 * What a document is filed under.
 *
 * The row states the type, the language and the taxonomy, and both foreign
 * keys are composite — so the content really is that type in that language,
 * the term really is that taxonomy in that language, and because one `locale`
 * column serves both, they are the same language. Filing an English post under
 * a French category is not something this table can hold.
 *
 * One rule is deliberately *not* here: whether a content type declares the
 * taxonomy at all. That declaration lives in code — `defineContentType`
 * lists them — and a database cannot consult it without a table that copies
 * it, which is the entity-attribute-value habit this project exists to avoid.
 * The repository that writes these rows will check it against the registry;
 * what the schema guarantees is stated above, and nothing more is implied.
 */
export const contentTerms = pgTable(
  'content_terms',
  {
    contentId: uuid().notNull(),
    termId: uuid().notNull(),
    /** The content's type, restated so the foreign key can hold it to it. */
    type: text().notNull(),
    /** Shared by both sides: this is what makes the languages agree. */
    locale: text().notNull(),
    taxonomy: text().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contentId, t.termId] }),
    index('content_terms_term_idx').on(t.termId),

    foreignKey({
      name: 'content_terms_content_fk',
      columns: [t.contentId, t.type, t.locale],
      foreignColumns: [contents.id, contents.type, contents.locale],
    }).onDelete('cascade'),

    foreignKey({
      name: 'content_terms_term_fk',
      columns: [t.termId, t.taxonomy, t.locale],
      foreignColumns: [terms.id, terms.taxonomy, terms.locale],
    }).onDelete('cascade'),
  ],
)
