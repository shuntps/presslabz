CREATE TABLE "media_orphans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"media_id" uuid NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "media_orphans_storageKey_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
CREATE INDEX "media_orphans_created_idx" ON "media_orphans" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contents_blocks_gin" ON "contents" USING gin ("blocks");