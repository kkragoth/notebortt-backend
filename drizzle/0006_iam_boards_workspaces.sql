ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
--> statement-breakpoint

ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "added_by" uuid;
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE "workspace_members" ALTER COLUMN "role" SET DEFAULT 'viewer';
--> statement-breakpoint
ALTER TABLE "workspace_members" DROP CONSTRAINT IF EXISTS "valid_workspace_role";
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "valid_workspace_role" CHECK ("workspace_members"."role" IN ('owner', 'admin', 'editor', 'viewer'));
--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_single_owner_idx" ON "workspace_members" USING btree ("workspace_id") WHERE "workspace_members"."role" = 'owner';
--> statement-breakpoint

ALTER TABLE "workspace_invitations" ADD COLUMN IF NOT EXISTS "email_lower" text;
--> statement-breakpoint
UPDATE "workspace_invitations" SET "email_lower" = lower("email") WHERE "email_lower" IS NULL;
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "email_lower" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ALTER COLUMN "role" SET DEFAULT 'viewer';
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
DROP INDEX IF EXISTS "invitation_unique_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspace_invitation_pending_idx" ON "workspace_invitations" USING btree ("workspace_id","email_lower","status");
--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "valid_invite_role";
--> statement-breakpoint
ALTER TABLE "workspace_invitations" DROP CONSTRAINT IF EXISTS "valid_invite_status";
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "valid_workspace_invite_role" CHECK ("workspace_invitations"."role" IN ('admin', 'editor', 'viewer'));
--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "valid_workspace_invite_status" CHECK ("workspace_invitations"."status" IN ('pending', 'accepted', 'declined', 'expired', 'revoked'));
--> statement-breakpoint

ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_enabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_token" text;
--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN IF NOT EXISTS "link_share_permission" text DEFAULT 'view' NOT NULL;
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_link_share_token_unique" UNIQUE("link_share_token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_boards_link_token" ON "boards" USING btree ("link_share_token");
--> statement-breakpoint
ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "valid_link_share_permission";
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "valid_link_share_permission" CHECK ("boards"."link_share_permission" IN ('view', 'edit'));
--> statement-breakpoint
ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "link_share_token_required_when_enabled";
--> statement-breakpoint

UPDATE "boards" AS b
SET
  "link_share_enabled" = true,
  "link_share_token" = s."token",
  "link_share_permission" = s."permission"
FROM (
  SELECT DISTINCT ON (board_id)
    board_id,
    token,
    permission
  FROM "board_shares"
  WHERE user_id IS NULL
  ORDER BY board_id, created_at DESC
) AS s
WHERE b.id = s.board_id;
--> statement-breakpoint

ALTER TABLE "boards" ADD CONSTRAINT "link_share_token_required_when_enabled" CHECK (NOT "boards"."link_share_enabled" OR "boards"."link_share_token" IS NOT NULL);
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "board_members" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "board_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "permission" text DEFAULT 'view' NOT NULL,
  "added_by" uuid,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "valid_board_member_permission" CHECK ("board_members"."permission" IN ('view', 'edit'))
);
--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "board_member_user_idx" ON "board_members" USING btree ("board_id","user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_board_members_user" ON "board_members" USING btree ("user_id");
--> statement-breakpoint

INSERT INTO "board_members" ("board_id", "user_id", "permission", "created_at", "updated_at")
SELECT "board_id", "user_id", "permission", "created_at", COALESCE("created_at", now())
FROM "board_shares"
WHERE "user_id" IS NOT NULL
ON CONFLICT ("board_id", "user_id")
DO UPDATE SET
  "permission" = EXCLUDED."permission",
  "updated_at" = now();
--> statement-breakpoint

ALTER TABLE "board_invitations" ADD COLUMN IF NOT EXISTS "permission" text;
--> statement-breakpoint
UPDATE "board_invitations"
SET "permission" = CASE
  WHEN "role" = 'editor' THEN 'edit'
  ELSE 'view'
END
WHERE "permission" IS NULL;
--> statement-breakpoint
ALTER TABLE "board_invitations" ALTER COLUMN "permission" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_invitations" ALTER COLUMN "permission" SET DEFAULT 'view';
--> statement-breakpoint
ALTER TABLE "board_invitations" ADD COLUMN IF NOT EXISTS "token" text;
--> statement-breakpoint
UPDATE "board_invitations"
SET "token" = encode(gen_random_bytes(32), 'hex')
WHERE "token" IS NULL;
--> statement-breakpoint
ALTER TABLE "board_invitations" ALTER COLUMN "token" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_invitations" ADD CONSTRAINT "board_invitations_token_unique" UNIQUE("token");
--> statement-breakpoint
UPDATE "board_invitations"
SET "expires_at" = now() + interval '7 days'
WHERE "expires_at" IS NULL;
--> statement-breakpoint
ALTER TABLE "board_invitations" ALTER COLUMN "expires_at" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "board_invitations" ADD COLUMN IF NOT EXISTS "responded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "board_invitations" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();
--> statement-breakpoint
ALTER TABLE "board_invitations" DROP CONSTRAINT IF EXISTS "valid_board_invitation_role";
--> statement-breakpoint
ALTER TABLE "board_invitations" DROP CONSTRAINT IF EXISTS "valid_board_invitation_permission";
--> statement-breakpoint
ALTER TABLE "board_invitations" ADD CONSTRAINT "valid_board_invitation_permission" CHECK ("board_invitations"."permission" IN ('view', 'edit'));
--> statement-breakpoint
ALTER TABLE "board_invitations" DROP COLUMN IF EXISTS "role";
--> statement-breakpoint

ALTER TABLE "mutations" ADD COLUMN IF NOT EXISTS "session_id" text;
--> statement-breakpoint

DROP INDEX IF EXISTS "billing_customer_links_user_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_links_user_idx" ON "billing_customer_links" USING btree ("user_id") WHERE "billing_customer_links"."user_id" IS NOT NULL;
--> statement-breakpoint

DROP INDEX IF EXISTS "idx_board_shares_user";
--> statement-breakpoint
DROP TABLE IF EXISTS "board_shares";
--> statement-breakpoint

ALTER TABLE "boards" DROP CONSTRAINT IF EXISTS "boards_current_commit_id_commits_id_fk";
--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_current_commit_id_commits_id_fk" FOREIGN KEY ("current_commit_id") REFERENCES "public"."commits"("id") ON DELETE set null DEFERRABLE INITIALLY DEFERRED;
