ALTER TABLE "contents" DROP CONSTRAINT "contents_parent_fk";
--> statement-breakpoint
ALTER TABLE "contents" ADD CONSTRAINT "contents_parent_fk" FOREIGN KEY ("parent_id","type","locale") REFERENCES "public"."contents"("id","type","locale") ON DELETE restrict ON UPDATE no action;