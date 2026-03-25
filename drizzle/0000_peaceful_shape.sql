CREATE TABLE "board_shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"user_id" uuid,
	"permission" text DEFAULT 'view' NOT NULL,
	"token" text,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "board_shares_token_unique" UNIQUE("token"),
	CONSTRAINT "valid_share_permission" CHECK ("board_shares"."permission" IN ('view', 'edit'))
);
--> statement-breakpoint
CREATE TABLE "boards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"current_commit_id" uuid,
	"current_branch" text DEFAULT 'main',
	"created_at" timestamp with time zone DEFAULT now(),
	"updated_at" timestamp with time zone DEFAULT now()
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
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "valid_element_type" CHECK ("elements"."type" IN ('NOTE','TEXT','ARROW','DRAWING','SHAPE','COLUMN','IMAGE','LINK_PREVIEW'))
);
--> statement-breakpoint
CREATE TABLE "mutations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"board_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"operation_type" text NOT NULL,
	"operation_data" jsonb NOT NULL,
	"client_ts" timestamp with time zone NOT NULL,
	"server_ts" timestamp with time zone DEFAULT now(),
	"user_id" uuid,
	CONSTRAINT "valid_operation_type" CHECK ("mutations"."operation_type" IN ('CREATE_ELEMENT','UPDATE_ELEMENT','DELETE_ELEMENTS','MOVE_ELEMENTS','UPDATE_ELEMENTS','REORDER_ELEMENT'))
);
--> statement-breakpoint
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
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
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
	"role" text DEFAULT 'member' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "workspace_invitations_token_unique" UNIQUE("token"),
	CONSTRAINT "valid_invite_role" CHECK ("workspace_invitations"."role" IN ('admin', 'member')),
	CONSTRAINT "valid_invite_status" CHECK ("workspace_invitations"."status" IN ('pending', 'accepted', 'declined', 'expired'))
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "valid_workspace_role" CHECK ("workspace_members"."role" IN ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"owner_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "board_shares" ADD CONSTRAINT "board_shares_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_shares" ADD CONSTRAINT "board_shares_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "boards" ADD CONSTRAINT "boards_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_parent_id_commits_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "elements" ADD CONSTRAINT "elements_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutations" ADD CONSTRAINT "mutations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mutations" ADD CONSTRAINT "mutations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_accounts" ADD CONSTRAINT "oauth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_invitations" ADD CONSTRAINT "workspace_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "board_share_user_idx" ON "board_shares" USING btree ("board_id","user_id");--> statement-breakpoint
CREATE INDEX "idx_commits_board_branch" ON "commits" USING btree ("board_id","branch_name");--> statement-breakpoint
CREATE INDEX "idx_elements_board" ON "elements" USING btree ("board_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mutation_board_seq_idx" ON "mutations" USING btree ("board_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_provider_id_idx" ON "oauth_accounts" USING btree ("provider","provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invitation_unique_idx" ON "workspace_invitations" USING btree ("workspace_id","email","status");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_member_idx" ON "workspace_members" USING btree ("workspace_id","user_id");