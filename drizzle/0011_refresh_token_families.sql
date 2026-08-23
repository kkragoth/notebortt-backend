ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "family_id" uuid NOT NULL DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD COLUMN IF NOT EXISTS "revoked_at" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_family" ON "refresh_tokens" USING btree ("family_id");
