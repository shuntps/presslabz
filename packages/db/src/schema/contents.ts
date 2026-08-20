import type { Blocks } from '@presslabz/blocks'
import { CONTENT_STATUSES } from '@presslabz/core'
import { type SQL, sql } from 'drizzle-orm'
import {
  check,
  foreignKey,
  index,
  integer,
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
    /** Metadata on the row it describes, queried through the GIN index below. */
    meta: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /*
     * The parent, constrained structurally rather than by hope. See the
     * composite foreign key below: `parentId` alone only guaranteed that some
     * row existed, so a page could name a post, a translation in another
     * language, or itself.
     */
    parentId: uuid(),
    /*
     * What a client says it was editing, so two editors cannot silently
     * overwrite each other.
     *
     * The row lock serializes the writes; it does not notice that the second
     * one was composed against a version the first has already replaced. With
     * only a lock, the later save wins and the earlier author's work is gone
     * with no error anywhere — which is the failure this column exists to
     * turn into a refusal.
     *
     * An integer rather than a timestamp: `updatedAt` is a moment, and a
     * moment survives a JSON round trip, a clock adjustment and a
     * millisecond-truncating client only by luck.
     */
    version: integer().notNull().default(1),
    publishedAt: timestamp({ withTimezone: true }),
    /**
     * Generated column, so it can never drift from the row it describes.
     *
     * Title, excerpt **and the document's own words**: it indexed the first
     * two only, which is a search that cannot find a paragraph — the thing
     * people actually search for. `presslabz_blocks_text` is an immutable SQL
     * function that pulls every text, code and attribution out of the blocks,
     * covering exactly what `blocksToPlainText` covers on the other side.
     * Immutable because a generated column may call nothing else.
     *
     * The 'simple' configuration does no stemming; per-locale configurations
     * need a function that picks one per row, and picking depends on a column,
     * which a generated expression may not do.
     *
     * Nothing queries this column yet. It exists so that the day something
     * does, the index is already correct for every document ever written.
     */
    searchVector: tsvector().generatedAlwaysAs(
      (): SQL =>
        sql`to_tsvector('simple', coalesce(${contents.title}, '') || ' ' || coalesce(${contents.excerpt}, '') || ' ' || presslabz_blocks_text(${contents.blocks}))`,
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
    /*
     * Redundant for uniqueness — id is the primary key — and required anyway,
     * because Postgres will only let a composite foreign key reference columns
     * carrying a unique constraint. Same reason the translation group has one.
     */
    unique('contents_id_type_locale_uq').on(t.id, t.type, t.locale),

    /*
     * "A parent is the same kind of thing, in the same language." Enforced by
     * the database rather than checked by the application, because a check
     * loses its race: two concurrent writes can each read a compatible parent
     * and then make it incompatible.
     *
     * restrict, and the repository detaches the children first — the same
     * shape as deleting a translation group.
     *
     * `set null` is what this wants to say and cannot: on a composite key
     * Postgres nulls *every* column of it, so deleting a parent tried to set
     * the child's `type` and `locale` to null as well and failed on the
     * not-null constraint. Postgres 15 can name the column, but drizzle-kit
     * cannot generate that, and a constraint the schema and the migrations
     * disagree about is worse than an explicit UPDATE.
     *
     * Never cascade: deleting a page must not delete the pages under it. Its
     * children become roots, which is visible and recoverable; the alternative
     * silently removes a subtree because somebody deleted an index page.
     */
    foreignKey({
      name: 'contents_parent_fk',
      columns: [t.parentId, t.type, t.locale],
      foreignColumns: [t.id, t.type, t.locale],
    }).onDelete('restrict'),

    /*
     * A document is not its own parent. The cycle check in the repository
     * would catch it, but a one-row cycle is cheap enough to refuse here and
     * this holds for any path written later that forgets to look.
     */
    check('contents_parent_not_self', sql`${t.parentId} is distinct from ${t.id}`),

    index('contents_parent_idx').on(t.parentId),
    index('contents_translation_group_idx').on(t.translationGroupId),
    index('contents_listing_idx').on(t.type, t.locale, t.status, t.publishedAt),
    /*
     * What the admin's listing actually asks for: one type, one language,
     * newest change first, resumed from a cursor. The columns are in that
     * order and both sort columns are in the index, so a page is a range scan
     * that stops after `limit` rows — no sort of the whole filtered set, and
     * no cost that grows with how far in the reader has paged. Without it,
     * every page read and sorted every document of that type and language.
     */
    index('contents_updated_idx').on(
      t.type,
      t.locale,
      t.updatedAt.desc().nullsFirst(),
      t.id.desc().nullsFirst(),
    ),
    index('contents_meta_gin').using('gin', t.meta),
    /*
     * So "is this asset used anywhere" is a question the database can answer.
     * Deleting media used to check nothing, which meant a page could lose its
     * illustration because somebody tidied the library — and finding the uses
     * without this index means reading every document in the installation.
     */
    index('contents_blocks_gin').using('gin', t.blocks),
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
    /*
     * The whole editorial state, not the parts somebody happened to think of.
     *
     * It used to hold the title, the blocks and the metadata, which reads like
     * "the document" until a restore is attempted: the slug, the excerpt, the
     * status, the parent and the publication date were all missing, so putting
     * a document back the way it was was impossible from its own history. A
     * revision that cannot restore is a record nobody can use.
     */
    slug: text().notNull(),
    title: text().notNull(),
    excerpt: text(),
    status: contentStatus().notNull(),
    blocks: jsonb().$type<Blocks>().notNull(),
    meta: jsonb().$type<Record<string, unknown>>().notNull(),
    authorId: uuid().references(() => users.id, { onDelete: 'set null' }),
    /*
     * Unconstrained on purpose, unlike the live column.
     *
     * A revision records what the document was, and the page it hung under may
     * since have been deleted. A foreign key here would quietly rewrite that
     * history — `on delete set null` would erase the parent from every old
     * revision — so the id is kept as recorded, and a restore that would
     * recreate a parent which no longer exists is refused by the live table's
     * own constraint instead.
     */
    parentId: uuid(),
    /*
     * withTimezone, not withTimeZone. Drizzle takes an options object and
     * ignores a key it does not know, so the capitalised spelling produced a
     * column with no time zone at all and said nothing — the generated SQL was
     * the only place it showed.
     */
    publishedAt: timestamp({ withTimezone: true }),
    /** The version this snapshot is of, so history reads in order. */
    version: integer().notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index('content_revisions_content_idx').on(t.contentId, t.createdAt)],
)
