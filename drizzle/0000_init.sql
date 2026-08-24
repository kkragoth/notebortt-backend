CREATE TABLE "oauth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_id" text NOT NULL,
	"email" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refresh_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"family_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "workspace_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"email" text NOT NULL,
	"email_lower" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "workspace_invitations_token_unique" UNIQUE("token"),
	CONSTRAINT "valid_workspace_invite_role" CHECK ("workspace_invitations"."role" IN ('admin', 'editor', 'viewer')),
	CONSTRAINT "valid_workspace_invite_status" CHECK ("workspace_invitations"."status" IN ('pending', 'accepted', 'declined', 'expired', 'revoked'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "valid_workspace_role" CHECK ("workspace_members"."role" IN ('owner', 'admin', 'editor', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "board_favorites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "board_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"email_lower" text NOT NULL,
	"permission" text DEFAULT 'view' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "board_invitations_token_unique" UNIQUE("token"),
	CONSTRAINT "valid_board_invitation_permission" CHECK ("board_invitations"."permission" IN ('view', 'edit')),
	CONSTRAINT "valid_board_invitation_status" CHECK ("board_invitations"."status" IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "board_members" (
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
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_commit_id" uuid,
	"current_branch" text DEFAULT 'main',
	"preview_svg" text,
	"preview_version" text,
	"preview_updated_at" timestamp with time zone,
	"link_share_view_enabled" boolean DEFAULT false NOT NULL,
	"link_share_view_token" text,
	"link_share_edit_enabled" boolean DEFAULT false NOT NULL,
	"link_share_edit_token" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "boards_link_share_view_token_unique" UNIQUE("link_share_view_token"),
	CONSTRAINT "boards_link_share_edit_token_unique" UNIQUE("link_share_edit_token"),
	CONSTRAINT "link_share_view_token_required_when_enabled" CHECK (NOT "boards"."link_share_view_enabled" OR "boards"."link_share_view_token" IS NOT NULL),
	CONSTRAINT "link_share_edit_token_required_when_enabled" CHECK (NOT "boards"."link_share_edit_enabled" OR "boards"."link_share_edit_token" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"parent_id" uuid,
	"branch_name" text DEFAULT 'main' NOT NULL,
	"message" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "elements" (
	"id" text PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "valid_element_type" CHECK ("elements"."type" IN ('NOTE','TEXT','ARROW','DRAWING','SHAPE','COLUMN','TABLE','IMAGE','LINK_PREVIEW','META_COLUMN','RANGE'))
);
--> statement-breakpoint
CREATE TABLE "billing_customer_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"organization_id" text,
	"stripe_customer_id" text NOT NULL,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_subscription_id" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"organization_id" text,
	"user_id" uuid,
	"status" text NOT NULL,
	"plan" text NOT NULL,
	"price_id" text,
	"trial_end" timestamp with time zone,
	"current_period_end" timestamp with time zone,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"raw" jsonb,
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"stripe_event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now(),
	"raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_favorites" ADD CONSTRAINT "board_favorites_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_favorites" ADD CONSTRAINT "board_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invitations" ADD CONSTRAINT "board_invitations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invitations" ADD CONSTRAINT "board_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_members" ADD CONSTRAINT "board_members_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_current_commit_id_commits_id_fk" FOREIGN KEY ("current_commit_id") REFERENCES "public"."commits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_parent_id_commits_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elements" ADD CONSTRAINT "elements_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_customer_links" ADD CONSTRAINT "billing_customer_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_provider_id_idx" ON "oauth_accounts" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_hash_expires" ON "refresh_tokens" USING btree ("token_hash","expires_at");--> statement-breakpoint
CREATE INDEX "idx_refresh_tokens_family" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invitation_pending_idx" ON "workspace_invitations" USING btree ("workspace_id","email_lower","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_idx" ON "workspace_members" USING btree ("workspace_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_single_owner_idx" ON "workspace_members" USING btree ("workspace_id") WHERE "workspace_members"."role" = 'owner';--> statement-breakpoint
CREATE INDEX "idx_workspace_members_user" ON "workspace_members" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "board_favorite_user_idx" ON "board_favorites" USING btree ("board_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_board_favorites_user" ON "board_favorites" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_board_invitations_email" ON "board_invitations" USING btree ("email_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "board_invitation_pending_idx" ON "board_invitations" USING btree ("board_id","email_lower","status");--> statement-breakpoint
CREATE UNIQUE INDEX "board_member_user_idx" ON "board_members" USING btree ("board_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_board_members_user" ON "board_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_boards_workspace" ON "boards" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "idx_boards_link_view_token" ON "boards" USING btree ("link_share_view_token");--> statement-breakpoint
CREATE INDEX "idx_boards_link_edit_token" ON "boards" USING btree ("link_share_edit_token");--> statement-breakpoint
CREATE INDEX "idx_commits_board_branch" ON "commits" USING btree ("board_id","branch_name");--> statement-breakpoint
CREATE INDEX "idx_elements_board" ON "elements" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_links_stripe_customer_idx" ON "billing_customer_links" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_links_user_idx" ON "billing_customer_links" USING btree ("user_id") WHERE "billing_customer_links"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "billing_customer_links_org_idx" ON "billing_customer_links" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_idx" ON "billing_subscriptions" USING btree ("stripe_subscription_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("stripe_customer_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_org_idx" ON "billing_subscriptions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_idx" ON "billing_subscriptions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_stripe_event_idx" ON "billing_webhook_events" USING btree ("stripe_event_id");--> statement-breakpoint
CREATE INDEX "billing_webhook_events_type_idx" ON "billing_webhook_events" USING btree ("event_type");