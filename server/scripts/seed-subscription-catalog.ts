import { db } from "../db";
import { subscriptionCatalog } from "@shared/schema";
import * as fs from "fs";
import * as path from "path";

async function seedSubscriptionCatalog() {
  console.log("[Seed] Starting subscription catalog seed...");
  
  const csvPath = path.join(process.cwd(), "attached_assets/UK_Subscriptions_Master_2025_1766181302807.csv");
  
  if (!fs.existsSync(csvPath)) {
    console.error(`[Seed] CSV file not found at: ${csvPath}`);
    process.exit(1);
  }
  
  const csvContent = fs.readFileSync(csvPath, "utf-8");
  const lines = csvContent.split("\n");
  
  // Skip first row (junk header "Untitled 16,,,,,,") and second row (actual headers)
  const dataLines = lines.slice(2);
  
  let inserted = 0;
  let skipped = 0;
  let errors = 0;
  
  for (const line of dataLines) {
    const trimmedLine = line.trim();
    if (!trimmedLine) continue;
    
    // Parse CSV line (handle quoted values if needed)
    const parts = trimmedLine.split(",");
    if (parts.length < 6) {
      console.warn(`[Seed] Skipping malformed line: ${trimmedLine.substring(0, 50)}...`);
      skipped++;
      continue;
    }
    
    const [merchantName, productName, amountStr, currency, recurrence, _type, category] = parts;
    
    // Parse amount to cents
    const amount = parseFloat(amountStr);
    if (isNaN(amount)) {
      console.warn(`[Seed] Skipping line with invalid amount: ${amountStr}`);
      skipped++;
      continue;
    }
    const amountCents = Math.round(amount * 100);
    
    try {
      // Upsert: insert or update on conflict
      await db.insert(subscriptionCatalog)
        .values({
          merchantName: merchantName.trim(),
          productName: productName.trim(),
          amountCents,
          currency: currency?.trim() || "GBP",
          recurrence: recurrence?.trim() || "Monthly",
          category: category?.trim() || null,
          confidenceScore: 1.0, // Seed data is trusted
        })
        .onConflictDoUpdate({
          target: [subscriptionCatalog.merchantName, subscriptionCatalog.productName],
          set: {
            amountCents,
            currency: currency?.trim() || "GBP",
            recurrence: recurrence?.trim() || "Monthly",
            category: category?.trim() || null,
            confidenceScore: 1.0,
          },
        });
      inserted++;
    } catch (error) {
      console.error(`[Seed] Error inserting ${merchantName} - ${productName}:`, error);
      errors++;
    }
  }
  
  console.log(`[Seed] Subscription catalog seeding complete.`);
  console.log(`[Seed] Inserted/Updated: ${inserted}, Skipped: ${skipped}, Errors: ${errors}`);
  
  process.exit(0);
}

seedSubscriptionCatalog().catch((err) => {
  console.error("[Seed] Fatal error:", err);
  process.exit(1);
});
