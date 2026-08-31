-- P6.5: composite index for flush reconciliation on the hot elements table.
-- PRODUCTION: apply the CONCURRENTLY variant from scripts/ first (see
-- DEPLOY.md); this plain form is a fast no-op afterwards thanks to IF NOT
-- EXISTS, and keeps CI/test databases (empty tables) on the normal
-- transactional migration path.
CREATE INDEX IF NOT EXISTS "idx_elements_board_updated_at" ON "elements" USING btree ("board_id","updated_at");
