-- Indexes for keyset pagination.
--
-- The admin's listing asks for one type, one language, newest change first,
-- resumed from a cursor; nothing served that. `contents_listing_idx` leads
-- with (type, locale) and then status and published_at, so every page read the
-- whole filtered set and sorted it — measured: Limit → Sort → Seq Scan over
-- four thousand rows to return twenty-five. The new index carries both sort
-- columns, which turns a page into a range scan that stops after `limit` rows
-- however far in the reader has paged.
--
-- NULLS FIRST is not decoration. `ORDER BY x DESC` means NULLS FIRST in
-- Postgres, and an index declared DESC NULLS LAST does not match it — the
-- first attempt was exactly that, and the planner ignored the index and sorted
-- anyway. The columns are NOT NULL, so the two orderings describe the same
-- rows; only one of them lets the planner use the index.
--
-- The media index is replaced rather than added to: (created_at, id) answers
-- everything the single-column one did, and the id is there because it is in
-- the sort — two uploads in the same millisecond need a tiebreak the index can
-- answer instead of one the planner has to sort for.
--
-- Written non-concurrently. These tables are small at every scale this project
-- has, and CREATE INDEX CONCURRENTLY cannot run inside the transaction the
-- migration runner opens; an installation large enough to care can build them
-- by hand before migrating.

DROP INDEX "media_created_idx";--> statement-breakpoint
CREATE INDEX "contents_updated_idx" ON "contents" USING btree ("type","locale","updated_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);--> statement-breakpoint
CREATE INDEX "media_created_idx" ON "media" USING btree ("created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);