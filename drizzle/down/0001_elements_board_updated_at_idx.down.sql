-- Down-migration for 0001_elements_board_updated_at_idx.sql (P6.5 policy:
-- every forward migration carries an explicit reverse; apply manually via
-- psql when rolling back, drizzle-kit does not run these automatically).
DROP INDEX CONCURRENTLY IF EXISTS "idx_elements_board_updated_at";
