ALTER TABLE "journal_notes"
  ADD COLUMN IF NOT EXISTS "color_title" boolean NOT NULL DEFAULT false;

