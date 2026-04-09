CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_hash_expires" ON "refresh_tokens" USING btree ("token_hash","expires_at");
CREATE INDEX IF NOT EXISTS "idx_workspace_members_user" ON "workspace_members" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "idx_boards_workspace" ON "boards" USING btree ("workspace_id");
CREATE INDEX IF NOT EXISTS "idx_board_shares_user" ON "board_shares" USING btree ("user_id");
