-- Terms gain the invariants they always needed, and search gains the document.
--
-- Written by hand. drizzle-kit produced the right constraints in the wrong
-- order — foreign keys before the unique constraints they reference — and knew
-- nothing about the function the generated column now calls, or about the
-- index that dropping that column takes with it.
--
-- Nothing has ever written to `terms` or `content_terms`: they carry no
-- repository, no routes and no interface. The guard below says so out loud
-- rather than assuming it, because an installation with rows in them would be
-- one this migration must refuse rather than mangle.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM terms) OR EXISTS (SELECT 1 FROM content_terms) THEN
    RAISE EXCEPTION
      'terms or content_terms hold rows, and this migration adds constraints they were written without. Nothing in PressLabz has ever inserted into these tables; whatever put rows there knows what they mean, and this migration does not.';
  END IF;
END
$$;--> statement-breakpoint

-- ── The text a search would look through ────────────────────────────────────
--
-- Immutable, because a generated column may call nothing else. It pulls every
-- `text`, `code` and `attribution` out of the block tree, which is exactly
-- what blocksToPlainText covers on the TypeScript side — the two are one
-- rule expressed twice, and the test that crosses them is what keeps them
-- honest.
--
-- The depth bound is a bound, not a guess: a block holds inline content, an
-- inline node holds marks, and nothing in the vocabulary nests deeper than
-- that. Unbounded `$.**` would walk whatever a future block type invents.
CREATE OR REPLACE FUNCTION presslabz_blocks_text(blocks jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(
    (
      SELECT string_agg(value, ' ')
      FROM jsonb_array_elements_text(
        jsonb_path_query_array(blocks, 'strict $.**{0 to 6}.text') ||
        jsonb_path_query_array(blocks, 'strict $.**{0 to 6}.code') ||
        jsonb_path_query_array(blocks, 'strict $.**{0 to 6}.attribution')
      ) AS t(value)
    ),
    ''
  )
$$;--> statement-breakpoint

-- Dropping a generated column takes its index with it, so both come back.
ALTER TABLE "contents" DROP COLUMN "search_vector";--> statement-breakpoint
ALTER TABLE "contents" ADD COLUMN "search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', coalesce("contents"."title", '') || ' ' || coalesce("contents"."excerpt", '') || ' ' || presslabz_blocks_text("contents"."blocks"))) STORED;--> statement-breakpoint
CREATE INDEX "contents_search_gin" ON "contents" USING gin ("search_vector");--> statement-breakpoint

-- ── A term belongs to a group, and a group to one taxonomy ──────────────────

CREATE TABLE "term_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"taxonomy" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "term_groups_id_taxonomy_uq" UNIQUE("id","taxonomy")
);--> statement-breakpoint

-- The old default invented a group id that pointed at nothing.
ALTER TABLE "terms" ALTER COLUMN "translation_group_id" DROP DEFAULT;--> statement-breakpoint

-- The unique constraints first: a composite foreign key may only reference
-- columns that carry one, and drizzle-kit emitted these the other way round.
ALTER TABLE "terms" ADD CONSTRAINT "terms_id_taxonomy_locale_uq" UNIQUE("id","taxonomy","locale");--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_id_locale_uq" UNIQUE("id","locale");--> statement-breakpoint
CREATE UNIQUE INDEX "terms_group_locale_uq" ON "terms" USING btree ("translation_group_id","locale");--> statement-breakpoint

ALTER TABLE "terms" ADD CONSTRAINT "terms_group_fk" FOREIGN KEY ("translation_group_id","taxonomy") REFERENCES "public"."term_groups"("id","taxonomy") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint

-- The parent must be the same taxonomy in the same language, which the plain
-- reference this replaces could not say.
ALTER TABLE "terms" DROP CONSTRAINT IF EXISTS "terms_parent_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_parent_fk" FOREIGN KEY ("parent_id","taxonomy","locale") REFERENCES "public"."terms"("id","taxonomy","locale") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "terms" ADD CONSTRAINT "terms_parent_not_self" CHECK ("terms"."parent_id" is distinct from "terms"."id");--> statement-breakpoint

-- ── Filing a document under a term ──────────────────────────────────────────
--
-- The row restates the type, the language and the taxonomy so that both sides
-- can be held to them. One `locale` column serves both foreign keys, which is
-- what makes an English post under a French category unrepresentable.

ALTER TABLE "content_terms" DROP CONSTRAINT "content_terms_content_id_contents_id_fk";--> statement-breakpoint
ALTER TABLE "content_terms" DROP CONSTRAINT "content_terms_term_id_terms_id_fk";--> statement-breakpoint
ALTER TABLE "content_terms" ADD COLUMN "type" text NOT NULL;--> statement-breakpoint
ALTER TABLE "content_terms" ADD COLUMN "locale" text NOT NULL;--> statement-breakpoint
ALTER TABLE "content_terms" ADD COLUMN "taxonomy" text NOT NULL;--> statement-breakpoint
ALTER TABLE "content_terms" ADD CONSTRAINT "content_terms_content_fk" FOREIGN KEY ("content_id","type","locale") REFERENCES "public"."contents"("id","type","locale") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_terms" ADD CONSTRAINT "content_terms_term_fk" FOREIGN KEY ("term_id","taxonomy","locale") REFERENCES "public"."terms"("id","taxonomy","locale") ON DELETE cascade ON UPDATE no action;
