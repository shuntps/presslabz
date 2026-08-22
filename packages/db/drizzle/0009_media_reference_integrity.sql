-- A document may not name an asset that is not there, and an asset a document
-- names may not be removed.
--
-- Written by hand, like every migration here. Two things drizzle-kit would not
-- have produced: the seeding of `media_reference_sync`, which has to look at
-- whether this installation already holds documents, and the constraint names,
-- which the API reads when it turns a violation into a refusal — a generated
-- name is one the tooling can change under us.
--
-- The foreign keys are created **with** the table rather than added afterwards.
-- `NOT VALID` exists to attach a constraint to a table that is already full
-- without scanning it; this one is born empty, so its keys are in place before
-- the first row and the backfill is checked by them as it runs. Nothing to
-- validate afterwards, and so no `VALIDATE CONSTRAINT` holding SHARE UPDATE
-- EXCLUSIVE over a scan.

CREATE TYPE "public"."content_media_source" AS ENUM('block', 'meta');--> statement-breakpoint
CREATE TYPE "public"."media_reference_sync_state" AS ENUM('pending', 'ready');--> statement-breakpoint

CREATE TABLE "content_media" (
	"content_id" uuid NOT NULL,
	"media_id" uuid NOT NULL,
	"source" "content_media_source" NOT NULL,
	CONSTRAINT "content_media_pkey" PRIMARY KEY("content_id","media_id","source"),
	CONSTRAINT "content_media_content_fk" FOREIGN KEY ("content_id") REFERENCES "public"."contents"("id") ON DELETE cascade ON UPDATE no action,
	CONSTRAINT "content_media_media_fk" FOREIGN KEY ("media_id") REFERENCES "public"."media"("id") ON DELETE restrict ON UPDATE no action
);--> statement-breakpoint

-- Postgres indexes the referenced side of a foreign key, not the referencing
-- side, and ON DELETE RESTRICT interrogates the referencing side. Without this
-- every media deletion scans the whole table.
CREATE INDEX "content_media_media_idx" ON "content_media" USING btree ("media_id");--> statement-breakpoint

-- Whether the mirror has been reconciled with what it mirrors.
--
-- Applying this file and starting the API are two events, and an operator can
-- do the first without the second — leaving a new server running against an
-- empty table, with every asset deletable and no reference enforced, and
-- nothing anywhere saying so. This row is what says so.
CREATE TABLE "media_reference_sync" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"state" "media_reference_sync_state" NOT NULL,
	"reconciled_at" timestamp with time zone,
	CONSTRAINT "media_reference_sync_single_row" CHECK ("media_reference_sync"."id")
);--> statement-breakpoint

-- A database that already holds documents has a mirror to build, and is not
-- trusted until something has built it. One that is empty — a fresh install, a
-- scratch database a test just made — has nothing to mirror and is coherent as
-- it stands, which is what keeps `drizzle-kit migrate` sufficient on its own
-- for a test database and keeps the API package out of the db package.
INSERT INTO "media_reference_sync" ("id", "state", "reconciled_at")
SELECT true,
       CASE WHEN EXISTS (SELECT 1 FROM "contents") THEN 'pending' ELSE 'ready' END::"media_reference_sync_state",
       CASE WHEN EXISTS (SELECT 1 FROM "contents") THEN NULL ELSE now() END;
