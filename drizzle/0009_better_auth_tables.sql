ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "stripe_customer_id" text;

ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "access_token" text;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "refresh_token" text;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "id_token" text;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "access_token_expires_at" timestamp with time zone;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "refresh_token_expires_at" timestamp with time zone;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "scope" text;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "password" text;
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "created_at" timestamp with time zone DEFAULT now();
ALTER TABLE "oauth_accounts" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now();

CREATE TABLE IF NOT EXISTS "auth_sessions" (
  "id" text PRIMARY KEY NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "token" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "user_id" uuid NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth_verifications" (
  "id" text PRIMARY KEY NOT NULL,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "auth_subscriptions" (
  "id" text PRIMARY KEY NOT NULL,
  "plan" text NOT NULL,
  "reference_id" text NOT NULL,
  "stripe_customer_id" text,
  "stripe_subscription_id" text,
  "status" text DEFAULT 'incomplete' NOT NULL,
  "period_start" timestamp with time zone,
  "period_end" timestamp with time zone,
  "trial_start" timestamp with time zone,
  "trial_end" timestamp with time zone,
  "cancel_at_period_end" boolean DEFAULT false,
  "cancel_at" timestamp with time zone,
  "canceled_at" timestamp with time zone,
  "ended_at" timestamp with time zone,
  "seats" integer,
  "billing_interval" text,
  "stripe_schedule_id" text
);

ALTER TABLE "auth_sessions"
  ADD CONSTRAINT "auth_sessions_user_id_users_id_fk"
  FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_token_idx" ON "auth_sessions" USING btree ("token");
CREATE INDEX IF NOT EXISTS "auth_sessions_user_id_idx" ON "auth_sessions" USING btree ("user_id");
CREATE INDEX IF NOT EXISTS "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");
