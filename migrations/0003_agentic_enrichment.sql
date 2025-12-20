-- Phase A: Resolve 2.0 Agentic Enrichment Schema Extensions

-- Create subscription_catalog table
CREATE TABLE IF NOT EXISTS "subscription_catalog" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"merchant_name" text NOT NULL,
	"product_name" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'GBP',
	"recurrence" text DEFAULT 'Monthly',
	"category" text,
	"confidence_score" real DEFAULT 1.0,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "subscription_catalog_merchant_name_product_name_unique" UNIQUE("merchant_name","product_name")
);

-- Create nylas_grants table
CREATE TABLE IF NOT EXISTS "nylas_grants" (
	"id" varchar PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar NOT NULL,
	"grant_id" text NOT NULL UNIQUE,
	"email_address" text NOT NULL,
	"provider" text,
	"created_at" timestamp DEFAULT now()
);

-- Add foreign key for nylas_grants
DO $$ BEGIN
 ALTER TABLE "nylas_grants" ADD CONSTRAINT "nylas_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;

-- Add new columns to enriched_transactions for agentic enrichment
ALTER TABLE "enriched_transactions" ADD COLUMN IF NOT EXISTS "is_subscription" boolean DEFAULT false;
ALTER TABLE "enriched_transactions" ADD COLUMN IF NOT EXISTS "subscription_id" varchar;
ALTER TABLE "enriched_transactions" ADD COLUMN IF NOT EXISTS "context_data" jsonb DEFAULT '{}'::jsonb;
ALTER TABLE "enriched_transactions" ADD COLUMN IF NOT EXISTS "reasoning_trace" jsonb DEFAULT '[]'::jsonb;
ALTER TABLE "enriched_transactions" ADD COLUMN IF NOT EXISTS "ai_confidence" real DEFAULT 0.0;

-- Add foreign key for subscription_id
DO $$ BEGIN
 ALTER TABLE "enriched_transactions" ADD CONSTRAINT "enriched_transactions_subscription_id_subscription_catalog_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscription_catalog"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
