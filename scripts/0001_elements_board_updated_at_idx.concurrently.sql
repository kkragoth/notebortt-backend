-- Run once per production database BEFORE `drizzle-kit migrate` picks up
-- 0001: builds the index without an exclusive write lock on the hot table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_elements_board_updated_at" ON "elements" USING btree ("board_id","updated_at");
