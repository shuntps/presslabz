import type { Blocks } from '@presslabz/blocks'
import { CONTENT_STATUSES } from '@presslabz/core'
import { type SQL, sql } from 'drizzle-orm'
import {
  type AnyPgColumn,
  foreignKey,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'
import { timestamps, tsvector } from './shared.ts'
import { users } from './users.ts'

/**
 * The list lives in packages/core, which is where the domain decides what a
 * status means. Restating it here would let the database and the validation
 * drift, and the drift would only show up as a constraint violation in
 * production.
 */
export const contentStatus = pgEnum('content_status', CONTENT_STATUSES)

/**
 * A translation group, and the one content type its members may have.
 *
 * It exists to make that rule structural. While the group was only a uuid
 * column, "every member shares a type" was an application check with nothing
 * behind it: a client could invent a group id, two concurrent creates would
 * both find no siblings to lock, and the group ended up holding a post and a
 * page. Reproduced, not theorised.
 *
 * The row is also the serialization point for every membership change. Joining
 * locks it before reading the members it authorizes against; deleting the last
 * member locks it before removing anything. One lock order, so a join cannot
 * authorize against a member that is disappearing underneath it.
 */
export const translationGroups = pgTable(
  'translation_groups',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Every member of this group is of this type. Enforced by the FK below. */
    type: text().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [
    /*
     * Redundant for uniqueness — id is already the primary key — and required
     * anyway: Postgres will only let a composite foreign key reference columns
     * carrying a unique constraint or index.
     */
    unique('translation_groups_id_type_uq').on(t.id, t.type),
  ],
)

/**
 * One row per translation, not one row per document.
 *
 * Translations share a `translationGroupId` but are otherwise independent:
 * separate slug, separate status, separate block structure. That is what lets
 * a French draft sit behind a published English original, and what a
 * per-locale-fields model cannot express.
 *
 * `blocks` is typed from packages/blocks, which owns the Block vocabulary.
 * The column stays plain jsonb in Postgres; what the import buys is that a
 * row this package writes cannot disagree with what the renderer accepts.
 */
export const contents = pgTable(
  'contents',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Registered in code via defineContentType(), not a row in a table. */
    type: text().notNull(),
    locale: text().notNull(),
    /*
     * No default. A content row cannot invent the group it belongs to: the
     * group is opened first, server-side, and its id supplied here. A default
     * is what let a client hand over an id nothing had created yet.
     */
    translationGroupId: uuid().notNull(),
    slug: text().notNull(),
    status: contentStatus().notNull().default('draft'),
    title: text().notNull(),
    excerpt: text(),
    blocks: jsonb().$type<Blocks>().notNull().default([]),
    /** Replaces wp_postmeta. Queried through the GIN index below. */
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    parentId: uuid().references((): AnyPgColumn => contents.id, { onDelete: 'set null' }),
    publishedAt: timestamp({ withTimezone: true }),
    /**
     * Generated column, so it can never drift from the row it describes.
     * The 'simple' configuration does no stemming; per-locale configurations
     * arrive with search in phase 2, since a generated column cannot call a
     * non-immutable function to pick one per row.
     */
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple', coalesce(${contents.title}, '') || ' ' || coalesce(${contents.excerpt}, ''))`,
    ),
    ...timestamps,
  },
  (t) => [
    uniqueIndex('contents_type_locale_slug_uq').on(t.type, t.locale, t.slug),
    /*
     * One translation per language per group. The repository also checks this
     * inside its transaction so the error can say something useful, but the
     * check alone is not a guarantee: two concurrent inserts of the same new
     * locale can both read an empty result before either writes. This index
     * is what actually makes it impossible, and it keeps holding for any code
     * path written later that forgets to look.
     */
    /*
     * The structural half of "a group has exactly one type". The application
     * still checks it under the group lock, because a constraint gives a
     * useful guarantee and a poor error message — but the guarantee is here.
     *
     * restrict, never cascade: deleting a group must not take content with it.
     * The repository empties a group before it removes it.
     */
    foreignKey({
      name: 'contents_translation_group_fk',
      columns: [t.translationGroupId, t.type],
      foreignColumns: [translationGroups.id, translationGroups.type],
    }).onDelete('restrict'),
    uniqueIndex('contents_group_locale_uq').on(t.translationGroupId, t.locale),
    index('contents_translation_group_idx').on(t.translationGroupId),
    index('contents_listing_idx').on(t.type, t.locale, t.status, t.publishedAt),
    index('contents_meta_gin').using('gin', t.meta),
    index('contents_search_gin').using('gin', t.searchVector),
  ],
)

export const contentRevisions = pgTable(
  'content_revisions',
  {
    id: uuid().primaryKey().defaultRandom(),
    contentId: uuid()
      .notNull()
      .references(() => contents.id, { onDelete: 'cascade' }),
    title: text().notNull(),
    blocks: jsonb().$type<Blocks>().notNull(),
    meta: jsonb().$type<Record<string, unknown>>().notNull(),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('content_revisions_content_idx').on(t.contentId, t.createdAt)],
)
