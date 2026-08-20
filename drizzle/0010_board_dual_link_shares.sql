ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_view_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_view_token" text;
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_edit_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_edit_token" text;
--> statement-breakpoint

-- Backfill the existing single link share into the per-permission columns.
UPDATE "boards"
SET
  "link_share_view_enabled" = ("link_share_enabled" AND "link_share_permission" = 'view'),
  "link_share_view_token" = CASE WHEN "link_share_enabled" AND "link_share_permission" = 'view' THEN "link_share_token" ELSE NULL END,
  "link_share_edit_enabled" = ("link_share_enabled" AND "link_share_permission" = 'edit'),
  "link_share_edit_token" = CASE WHEN "link_share_enabled" AND "link_share_permission" = 'edit' THEN "link_share_token" ELSE NULL END;
--> statement-breakpoint

ALTER TABLE "boards" ADD CONSTRAINT "boards_link_share_view_token_unique" UNIQUE("link_share_view_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_boards_link_view_token" ON "boards" USING btree ("link_share_view_token");
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_link_share_edit_token_unique" UNIQUE("link_share_edit_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_boards_link_edit_token" ON "boards" USING btree ("link_share_edit_token");
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "link_share_view_token_required_when_enabled" CHECK (NOT "boards"."link_share_view_enabled" OR "boards"."link_share_view_token" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "link_share_edit_token_required_when_enabled" CHECK (NOT "boards"."link_share_edit_enabled" OR "boards"."link_share_edit_token" IS NOT NULL);
--> statement-breakpoint

ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "boards_link_share_token_unique";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_boards_link_token";
--> statement-breakpoint
ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "valid_link_share_permission";
--> statement-breakpoint
ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "link_share_token_required_when_enabled";
--> statement-breakpoint
ALTER TABLE "boards" DROP COLUMN IF EXISTS "link_share_enabled";
--> statement-breakpoint
ALTER TABLE "boards" DROP COLUMN IF EXISTS "link_share_token";
--> statement-breakpoint
ALTER TABLE "boards" DROP COLUMN IF EXISTS "link_share_permission";