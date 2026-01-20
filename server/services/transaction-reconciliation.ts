import { storage } from "../storage";
import type { EnrichedTransaction } from "@shared/schema";

const REFUND_KEYWORDS = [
  "REFUND",
  "RETURN",
  "DD RET",
  "REV",
  "RETURNED",
  "CREDIT MEMO",
  "CHARGEBACK",
  "REVERSAL",
];

// Marketplace merchants where refunds may not include standard refund keywords
const MARKETPLACE_MERCHANTS = [
  "VINTED",
  "EBAY",
  "DEPOP",
  "POSHMARK",
  "MERCARI",
  "ETSY",
];

// Keywords indicating a bounced/returned direct debit
const BOUNCE_KEYWORDS = [
  "DIRECT DEBIT RETURNED",
  "DD RETURNED",
  "UNPAID DIRECT DEBIT",
  "RETURNED PAYMENT",
  "PAYMENT RETURNED",
  "BOUNCED",
  "DISHONOURED",
  "INSUFFICIENT FUNDS",
];

function hasBounceKeyword(description: string): boolean {
  const upper = description.toUpperCase();
  return BOUNCE_KEYWORDS.some((keyword) => upper.includes(keyword));
}

function isMarketplaceMerchant(tx: EnrichedTransaction): boolean {
  const description = (tx.merchantCleanName || tx.originalDescription).toUpperCase();
  return MARKETPLACE_MERCHANTS.some((merchant) => description.includes(merchant));
}

interface ReconciliationResult {
  transfersDetected: number;
  refundsDetected: number;
  bouncedPaymentsDetected: number;
  transactionsUpdated: number;
}

function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

function hasRefundKeyword(description: string): boolean {
  const upper = description.toUpperCase();
  return REFUND_KEYWORDS.some((keyword) => upper.includes(keyword));
}

function amountWithin10Percent(amount1: number, amount2: number): boolean {
  const absAmount1 = Math.abs(amount1);
  const absAmount2 = Math.abs(amount2);
  if (absAmount1 === 0 && absAmount2 === 0) return true;
  const larger = Math.max(absAmount1, absAmount2);
  const diff = Math.abs(absAmount1 - absAmount2);
  return diff / larger <= 0.1;
}

function merchantMatches(tx1: EnrichedTransaction, tx2: EnrichedTransaction): boolean {
  if (tx1.merchantCleanName && tx2.merchantCleanName) {
    return tx1.merchantCleanName.toLowerCase() === tx2.merchantCleanName.toLowerCase();
  }
  const desc1 = tx1.originalDescription.toLowerCase().replace(/[^a-z0-9]/g, "");
  const desc2 = tx2.originalDescription.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (desc1.length < 5 || desc2.length < 5) return false;
  return desc1.includes(desc2.substring(0, 10)) || desc2.includes(desc1.substring(0, 10));
}

export async function reconcileTransactions(userId: string): Promise<ReconciliationResult> {
  console.log(`[Reconciliation] Starting reconciliation for user ${userId.substring(0, 8)}...`);
  
  const transactions = await storage.getEnrichedTransactionsByUserId(userId);
  
  if (transactions.length === 0) {
    console.log(`[Reconciliation] No transactions to reconcile`);
    return { transfersDetected: 0, refundsDetected: 0, bouncedPaymentsDetected: 0, transactionsUpdated: 0 };
  }
  
  const unprocessed = transactions.filter(
    (tx) => tx.transactionType === "regular" && !tx.excludeFromAnalysis
  );
  
  console.log(`[Reconciliation] Processing ${unprocessed.length} unprocessed transactions out of ${transactions.length} total`);
  
  let transfersDetected = 0;
  let refundsDetected = 0;
  let bouncedPaymentsDetected = 0;
  let transactionsUpdated = 0;
  
  const processedIds = new Set<string>();
  
  const incoming = unprocessed.filter((tx) => tx.entryType === "incoming");
  const outgoing = unprocessed.filter((tx) => tx.entryType === "outgoing");
  
  for (const inTx of incoming) {
    if (processedIds.has(inTx.id)) continue;
    
    for (const outTx of outgoing) {
      if (processedIds.has(outTx.id)) continue;
      
      const sameAmount = inTx.amountCents === outTx.amountCents;
      const withinDays = daysBetween(inTx.transactionDate, outTx.transactionDate) <= 2;
      
      if (sameAmount && withinDays) {
        await storage.updateEnrichedTransactionReconciliation(inTx.id, {
          transactionType: "transfer",
          linkedTransactionId: outTx.id,
          excludeFromAnalysis: true,
        });
        
        await storage.updateEnrichedTransactionReconciliation(outTx.id, {
          transactionType: "transfer",
          linkedTransactionId: inTx.id,
          excludeFromAnalysis: true,
        });
        
        processedIds.add(inTx.id);
        processedIds.add(outTx.id);
        transfersDetected++;
        transactionsUpdated += 2;
        
        console.log(`[Reconciliation] Detected transfer: ${inTx.originalDescription.substring(0, 30)}... <-> ${outTx.originalDescription.substring(0, 30)}... (${inTx.amountCents / 100})`);
        break;
      }
    }
  }
  
  for (const tx of incoming) {
    if (processedIds.has(tx.id)) continue;
    
    const description = tx.merchantCleanName || tx.originalDescription;
    if (hasRefundKeyword(description)) {
      let linkedOriginalId: string | null = null;
      
      for (const outTx of outgoing) {
        if (processedIds.has(outTx.id)) continue;
        
        const within90Days = daysBetween(tx.transactionDate, outTx.transactionDate) <= 90;
        const similarAmount = amountWithin10Percent(tx.amountCents, outTx.amountCents);
        const sameMerchant = merchantMatches(tx, outTx);
        const outTxIsEarlier = new Date(outTx.transactionDate) < new Date(tx.transactionDate);
        
        if (within90Days && similarAmount && sameMerchant && outTxIsEarlier) {
          linkedOriginalId = outTx.id;
          break;
        }
      }
      
      const transactionType = description.toUpperCase().includes("REVERSAL") ? "reversal" : "refund";
      
      await storage.updateEnrichedTransactionReconciliation(tx.id, {
        transactionType,
        linkedTransactionId: linkedOriginalId,
        excludeFromAnalysis: true,
      });
      
      if (linkedOriginalId) {
        await storage.updateEnrichedTransactionReconciliation(linkedOriginalId, {
          excludeFromAnalysis: true,
        });
        processedIds.add(linkedOriginalId);
        transactionsUpdated++;
      }
      
      processedIds.add(tx.id);
      refundsDetected++;
      transactionsUpdated++;
      
      console.log(`[Reconciliation] Detected ${transactionType}: ${tx.originalDescription.substring(0, 40)}... (${tx.amountCents / 100})`);
    }
  }
  
  // PHASE 2b: Detect marketplace refunds (Vinted, eBay, Depop, etc.)
  // These are incoming transactions from known marketplace merchants that match earlier outgoing purchases
  // Marketplace refunds often don't include standard refund keywords
  for (const inTx of incoming) {
    if (processedIds.has(inTx.id)) continue;
    
    // Only process if this is from a known marketplace merchant
    if (!isMarketplaceMerchant(inTx)) continue;
    
    // Look for matching outgoing purchase (same marketplace, similar amount, within 90 days)
    let linkedOriginalId: string | null = null;
    
    for (const outTx of outgoing) {
      if (processedIds.has(outTx.id)) continue;
      
      const within90Days = daysBetween(inTx.transactionDate, outTx.transactionDate) <= 90;
      const similarAmount = amountWithin10Percent(inTx.amountCents, outTx.amountCents);
      const sameMarketplace = isMarketplaceMerchant(outTx) && merchantMatches(inTx, outTx);
      const outTxIsEarlier = new Date(outTx.transactionDate) < new Date(inTx.transactionDate);
      
      if (within90Days && similarAmount && sameMarketplace && outTxIsEarlier) {
        linkedOriginalId = outTx.id;
        break;
      }
    }
    
    // Only mark as marketplace refund if we found a matching original purchase
    if (linkedOriginalId) {
      await storage.updateEnrichedTransactionReconciliation(inTx.id, {
        transactionType: "refund",
        linkedTransactionId: linkedOriginalId,
        excludeFromAnalysis: true,
      });
      
      await storage.updateEnrichedTransactionReconciliation(linkedOriginalId, {
        excludeFromAnalysis: true,
      });
      
      processedIds.add(inTx.id);
      processedIds.add(linkedOriginalId);
      refundsDetected++;
      transactionsUpdated += 2;
      
      console.log(`[Reconciliation] Detected marketplace refund: ${inTx.originalDescription.substring(0, 40)}... (${inTx.amountCents / 100})`);
    }
  }
  
  // PHASE 3: Detect bounced/returned direct debits
  // These are incoming credits that match outgoing debits (the payment that bounced)
  for (const inTx of incoming) {
    if (processedIds.has(inTx.id)) continue;
    
    const description = inTx.merchantCleanName || inTx.originalDescription;
    if (hasBounceKeyword(description)) {
      // Look for matching outgoing payment (same amount, within 7 days, earlier date)
      let linkedOriginalId: string | null = null;
      
      for (const outTx of outgoing) {
        if (processedIds.has(outTx.id)) continue;
        
        const sameAmount = inTx.amountCents === outTx.amountCents;
        const within7Days = daysBetween(inTx.transactionDate, outTx.transactionDate) <= 7;
        const outTxIsEarlier = new Date(outTx.transactionDate) < new Date(inTx.transactionDate);
        
        if (sameAmount && within7Days && outTxIsEarlier) {
          linkedOriginalId = outTx.id;
          break;
        }
      }
      
      // Mark the bounced return credit as excluded
      await storage.updateEnrichedTransactionReconciliation(inTx.id, {
        transactionType: "bounced_payment",
        linkedTransactionId: linkedOriginalId,
        excludeFromAnalysis: true,
      });
      
      // Mark the original payment that bounced as excluded too
      if (linkedOriginalId) {
        await storage.updateEnrichedTransactionReconciliation(linkedOriginalId, {
          transactionType: "bounced_payment",
          linkedTransactionId: inTx.id,
          excludeFromAnalysis: true,
        });
        processedIds.add(linkedOriginalId);
        transactionsUpdated++;
      }
      
      processedIds.add(inTx.id);
      bouncedPaymentsDetected++;
      transactionsUpdated++;
      
      console.log(`[Reconciliation] Detected bounced payment: ${inTx.originalDescription.substring(0, 40)}... (${inTx.amountCents / 100})`);
    }
  }
  
  console.log(`[Reconciliation] Completed: ${transfersDetected} transfers, ${refundsDetected} refunds, ${bouncedPaymentsDetected} bounced payments, ${transactionsUpdated} transactions updated`);
  
  return { transfersDetected, refundsDetected, bouncedPaymentsDetected, transactionsUpdated };
}
