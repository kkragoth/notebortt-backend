ALTER TABLE "elements" DROP CONSTRAINT IF EXISTS "valid_element_type";
--> statement-breakpoint
ALTER TABLE "elements" ADD CONSTRAINT "valid_element_type" CHECK ("elements"."type" IN ('NOTE','TEXT','ARROW','DRAWING','SHAPE','COLUMN','TABLE','IMAGE','LINK_PREVIEW','META_COLUMN','RANGE'));
