CREATE TABLE "board_favorites" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "board_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "board_favorites" ADD CONSTRAINT "board_favorites_board_id_boards_id_fk" FOREIGN KEY ("board_id") REFERENCES "public"."boards"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "board_favorites" ADD CONSTRAINT "board_favorites_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "board_favorite_user_idx" ON "board_favorites" USING btree ("board_id","user_id");
--> statement-breakpoint
CREATE INDEX "idx_board_favorites_user" ON "board_favorites" USING btree ("user_id");
