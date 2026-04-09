CREATE TABLE "billing_customer_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid,
  "organization_id" text,
  "stripe_customer_id" text NOT NULL,
  "email" text,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stripe_subscription_id" text NOT NULL,
  "stripe_customer_id" text NOT NULL,
  "organization_id" text,
  "user_id" uuid,
  "status" text NOT NULL,
  "plan" text NOT NULL,
  "price_id" text,
  "trial_end" timestamp with time zone,
  "current_period_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false NOT NULL,
  "raw" jsonb,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stripe_event_id" text NOT NULL,
  "event_type" text NOT NULL,
  "processed_at" timestamp with time zone DEFAULT now(),
  "raw" jsonb
);
--> statement-breakpoint
ALTER TABLE "billing_customer_links" ADD CONSTRAINT "billing_customer_links_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "billing_subscriptions" ADD CONSTRAINT "billing_subscriptions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_links_stripe_customer_idx" ON "billing_customer_links" USING btree ("stripe_customer_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_customer_links_user_idx" ON "billing_customer_links" USING btree ("user_id");
--> statement-breakpoint
CREATE INDEX "billing_customer_links_org_idx" ON "billing_customer_links" USING btree ("organization_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_subscriptions_stripe_subscription_idx" ON "billing_subscriptions" USING btree ("stripe_subscription_id");
--> statement-breakpoint
CREATE INDEX "billing_subscriptions_customer_idx" ON "billing_subscriptions" USING btree ("stripe_customer_id");
--> statement-breakpoint
CREATE INDEX "billing_subscriptions_org_idx" ON "billing_subscriptions" USING btree ("organization_id");
--> statement-breakpoint
CREATE INDEX "billing_subscriptions_user_idx" ON "billing_subscriptions" USING btree ("user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_webhook_events_stripe_event_idx" ON "billing_webhook_events" USING btree ("stripe_event_id");
--> statement-breakpoint
CREATE INDEX "billing_webhook_events_type_idx" ON "billing_webhook_events" USING btree ("event_type");
