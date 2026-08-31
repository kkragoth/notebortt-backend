-- Run once per production database BEFORE `drizzle-kit migrate` picks up
-- 0001: builds the index without an exclusive write lock on the hot table.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "idx_elements_board_updated_at" ON "elements" USING btree ("board_id","updated_at");
-- An interrupted CONCURRENTLY build leaves an INVALID index under this exact
-- name, and the later plain `CREATE INDEX IF NOT EXISTS` in the tracked
-- migration would then skip — leaving the useless index in place forever.
-- Verify validity after running this script; drop + rerun if invalid:
--   select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
--    where c.relname = 'idx_elements_board_updated_at' and not i.indisvalid;
--   drop index concurrently if exists "idx_elements_board_updated_at";
