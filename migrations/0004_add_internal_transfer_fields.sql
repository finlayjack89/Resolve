ALTER TABLE "enriched_transactions" ADD COLUMN "is_internal_transfer" boolean DEFAULT false;
ALTER TABLE "enriched_transactions" ADD COLUMN "ecosystem_pair_id" varchar;
