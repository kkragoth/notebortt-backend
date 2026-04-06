CREATE TABLE "board_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"board_id" uuid NOT NULL,
	"invited_by" uuid NOT NULL,
	"email_lower" text NOT NULL,
	"role" text DEFAULT 'viewer' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now(),
	CONSTRAINT "valid_board_invitation_role" CHECK ("board_invitations"."role" IN ('editor', 'viewer')),
	CONSTRAINT "valid_board_invitation_status" CHECK ("board_invitations"."status" IN ('pending', 'accepted', 'revoked', 'expired'))
);
--> statement-breakpoint
ALTER TABLE "elements" DROP CONSTRAINT "valid_element_type";--> statement-breakpoint
ALTER TABLE "board_invitations" ADD CONSTRAINT "board_invitations_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "board_invitations" ADD CONSTRAINT "board_invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_board_invitations_email" ON "board_invitations" USING btree ("email_lower");--> statement-breakpoint
CREATE UNIQUE INDEX "board_invitation_pending_idx" ON "board_invitations" USING btree ("board_id","email_lower","status");--> statement-breakpoint
ALTER TABLE "elements" ADD CONSTRAINT "valid_element_type" CHECK ("elements"."type" IN ('NOTE','TEXT','ARROW','DRAWING','SHAPE','COLUMN','IMAGE','LINK_PREVIEW','META_COLUMN'));