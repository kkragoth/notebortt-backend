ALTER TABLE "boards" ADD COLUMN "preview_svg" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "preview_version" text;--> statement-breakpoint
ALTER TABLE "boards" ADD COLUMN "preview_updated_at" timestamp with time zone;
