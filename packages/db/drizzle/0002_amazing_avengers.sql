CREATE TABLE "translation_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "translation_groups_id_type_uq" UNIQUE("id","type")
);
--> statement-breakpoint
-- Preflight. A group holding more than one content type cannot be represented
-- once the constraint below exists, and there is no correct way to guess which
-- type the operator meant. Refuse, and say how to find them, rather than pick
-- one silently or drop the rows that disagree.
DO $$
DECLARE
	mixed integer;
BEGIN
	SELECT count(*) INTO mixed FROM (
		SELECT translation_group_id
		FROM contents
		GROUP BY translation_group_id
		HAVING count(DISTINCT type) > 1
	) AS offending;

	IF mixed > 0 THEN
		RAISE EXCEPTION
			'% translation group(s) hold more than one content type and cannot be migrated. List them with: SELECT translation_group_id, array_agg(DISTINCT type) FROM contents GROUP BY translation_group_id HAVING count(DISTINCT type) > 1; Split or reassign them, then run this migration again.',
			mixed;
	END IF;
END $$;
--> statement-breakpoint
-- Backfill, by the actual (group, type) pairs rather than by picking a type per
-- group. The preflight has already proved there is exactly one pair per group,
-- so this inserts one row each; if that guarantee were ever removed, this fails
-- loudly on the primary key instead of quietly choosing a winner.
INSERT INTO "translation_groups" ("id", "type")
SELECT DISTINCT "translation_group_id", "type" FROM "contents";
--> statement-breakpoint
ALTER TABLE "contents" ALTER COLUMN "translation_group_id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_translation_group_fk" FOREIGN KEY ("translation_group_id","type") REFERENCES "public"."translation_groups"("id","type") ON DELETE restrict ON UPDATE no action;
