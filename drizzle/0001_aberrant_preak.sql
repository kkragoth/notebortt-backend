ALTER TABLE "elements" ALTER COLUMN "id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "elements" ALTER COLUMN "id" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "mutations" ALTER COLUMN "id" SET DATA TYPE text;