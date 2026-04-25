ALTER TABLE "boards"
  ADD COLUMN IF NOT EXISTS "item_type" text NOT NULL DEFAULT 'canvas',
  ADD COLUMN IF NOT EXISTS "status" text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "avatar_shortcut" text,
  ADD COLUMN IF NOT EXISTS "avatar_color" text,
  ADD COLUMN IF NOT EXISTS "sidebar_order" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "archived_at" timestamp with time zone;

ALTER TABLE "workspaces"
  ADD COLUMN IF NOT EXISTS "avatar_shortcut" text,
  ADD COLUMN IF NOT EXISTS "gradient_from" text,
  ADD COLUMN IF NOT EXISTS "gradient_to" text,
  ADD COLUMN IF NOT EXISTS "gradient_preset_id" text,
  ADD COLUMN IF NOT EXISTS "item_type_order" jsonb NOT NULL DEFAULT '["canvas","journal","graph"]'::jsonb;

UPDATE "boards"
SET "item_type" = 'canvas',
    "status" = 'active'
WHERE "item_type" IS NULL
   OR "status" IS NULL;

WITH ordered_boards AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (PARTITION BY "workspace_id", "item_type" ORDER BY "created_at", "id") - 1 AS row_index
  FROM "boards"
)
UPDATE "boards" AS b
SET "sidebar_order" = o.row_index
FROM ordered_boards AS o
WHERE b."id" = o."id";

UPDATE "boards"
SET "avatar_shortcut" = UPPER(SUBSTRING(REGEXP_REPLACE(COALESCE("name", ''), '[^A-Za-z0-9]+', '', 'g') FROM 1 FOR 2))
WHERE "avatar_shortcut" IS NULL OR LENGTH(TRIM("avatar_shortcut")) = 0;

UPDATE "boards"
SET "avatar_shortcut" = 'CN'
WHERE "avatar_shortcut" IS NULL OR LENGTH(TRIM("avatar_shortcut")) = 0;

UPDATE "boards"
SET "avatar_color" = 'blue'
WHERE "avatar_color" IS NULL OR LENGTH(TRIM("avatar_color")) = 0;

DO $$
BEGIN
  ALTER TABLE "boards" ADD CONSTRAINT "valid_item_type" CHECK ("boards"."item_type" IN ('canvas', 'journal', 'graph'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "boards" ADD CONSTRAINT "valid_item_status" CHECK ("boards"."status" IN ('active', 'archived'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "boards" ADD CONSTRAINT "valid_avatar_shortcut_length" CHECK ("boards"."avatar_shortcut" IS NULL OR length("boards"."avatar_shortcut") <= 4);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "workspaces" ADD CONSTRAINT "valid_workspace_avatar_shortcut_length" CHECK ("workspaces"."avatar_shortcut" IS NULL OR length("workspaces"."avatar_shortcut") <= 4);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "workspaces" ADD CONSTRAINT "workspace_gradient_from_non_empty" CHECK ("workspaces"."gradient_from" IS NULL OR length(trim("workspaces"."gradient_from")) > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "workspaces" ADD CONSTRAINT "workspace_gradient_to_non_empty" CHECK ("workspaces"."gradient_to" IS NULL OR length(trim("workspaces"."gradient_to")) > 0);
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "idx_boards_workspace_status_sidebar_order" ON "boards" ("workspace_id", "status", "sidebar_order");
CREATE INDEX IF NOT EXISTS "idx_boards_workspace_item_type_sidebar_order" ON "boards" ("workspace_id", "item_type", "sidebar_order");

CREATE TABLE IF NOT EXISTS "journal_notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "journal_id" uuid NOT NULL REFERENCES "boards"("id") ON DELETE cascade,
  "title" text NOT NULL,
  "body_json" jsonb NOT NULL,
  "body_text" text NOT NULL DEFAULT '',
  "excerpt" text NOT NULL DEFAULT '',
  "tags" text[] NOT NULL DEFAULT '{}'::text[],
  "color" text,
  "status" text NOT NULL DEFAULT 'active',
  "pinned" boolean NOT NULL DEFAULT false,
  "created_by" uuid REFERENCES "users"("id"),
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "archived_at" timestamp with time zone,
  CONSTRAINT "valid_journal_note_status" CHECK ("status" IN ('active', 'archived'))
);

CREATE TABLE IF NOT EXISTS "journal_note_canvas_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "note_id" uuid NOT NULL REFERENCES "journal_notes"("id") ON DELETE cascade,
  "canvas_board_id" uuid NOT NULL REFERENCES "boards"("id") ON DELETE cascade,
  "target_element_id" text,
  "target_container_id" text,
  "sync_mode" text NOT NULL DEFAULT 'synced',
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  CONSTRAINT "valid_journal_note_canvas_sync_mode" CHECK ("sync_mode" IN ('synced', 'snapshot', 'plain_text'))
);

CREATE INDEX IF NOT EXISTS "idx_journal_notes_journal_status_updated" ON "journal_notes" ("journal_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_journal_notes_journal_pinned_updated" ON "journal_notes" ("journal_id", "pinned", "updated_at");
CREATE INDEX IF NOT EXISTS "idx_journal_notes_tags_gin" ON "journal_notes" USING gin ("tags");
CREATE INDEX IF NOT EXISTS "idx_journal_note_canvas_links_note" ON "journal_note_canvas_links" ("note_id");
CREATE INDEX IF NOT EXISTS "idx_journal_note_canvas_links_canvas" ON "journal_note_canvas_links" ("canvas_board_id");
