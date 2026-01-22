import { randomUUID } from "crypto";
import type { EnrichedTransaction } from "@shared/schema";

export interface GhostPairMatch {
  outgoingTransactionId: string;
  incomingTransactionId: string;
  ecosystemPairId: string;
  amountCents: number;
  dateDifferenceInDays: number;
}

function daysBetween(date1: string, date2: string): number {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  const diffTime = Math.abs(d2.getTime() - d1.getTime());
  return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
}

export function detectGhostPairs(
  transactions: EnrichedTransaction[]
): GhostPairMatch[] {
  const matches: GhostPairMatch[] = [];
  const matchedTransactionIds = new Set<string>();

  // Sort transactions by date for consistent processing
  const sorted = [...transactions].sort(
    (a, b) =>
      new Date(a.transactionDate).getTime() -
      new Date(b.transactionDate).getTime()
  );

  // Get outgoing transactions (exclude already matched)
  const outgoing = sorted.filter((tx) => 
    tx.entryType === "outgoing" && 
    !tx.isInternalTransfer && 
    !tx.ecosystemPairId &&
    tx.transactionType !== "transfer"
  );
  const incoming = sorted.filter((tx) => 
    tx.entryType === "incoming" && 
    !tx.isInternalTransfer && 
    !tx.ecosystemPairId &&
    tx.transactionType !== "transfer"
  );

  // For each outgoing transaction, find matching incoming transaction
  for (const outTx of outgoing) {
    // Skip if already matched
    if (matchedTransactionIds.has(outTx.id)) continue;

    // Look for a matching incoming transaction from a different account
    let bestMatch: {
      incomingTx: EnrichedTransaction;
      dateDiff: number;
    } | null = null;

    for (const inTx of incoming) {
      // Skip if already matched
      if (matchedTransactionIds.has(inTx.id)) continue;

      // Must be from a different account
      if (outTx.trueLayerItemId === inTx.trueLayerItemId) continue;

      // Check if amounts match exactly (absolute values)
      if (Math.abs(outTx.amountCents) !== Math.abs(inTx.amountCents))
        continue;

      // Check if within ±3 days
      const dateDiff = daysBetween(outTx.transactionDate, inTx.transactionDate);
      if (dateDiff > 3) continue;

      // If this is the first match or closer date match, use it
      if (bestMatch === null || dateDiff < bestMatch.dateDiff) {
        bestMatch = { incomingTx: inTx, dateDiff };
      }
    }

    // If we found a best match, create the pair
    if (bestMatch) {
      const ecosystemPairId = randomUUID();
      matches.push({
        outgoingTransactionId: outTx.id,
        incomingTransactionId: bestMatch.incomingTx.id,
        ecosystemPairId,
        amountCents: Math.abs(outTx.amountCents),
        dateDifferenceInDays: bestMatch.dateDiff,
      });

      // Mark both transactions as matched
      matchedTransactionIds.add(outTx.id);
      matchedTransactionIds.add(bestMatch.incomingTx.id);
    }
  }

  return matches;
}
