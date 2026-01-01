/**
 * Background Sync Service
 * 
 * Automatically refreshes TrueLayer accounts every 30 minutes.
 * Features:
 * - Per-account concurrency guards to prevent duplicate syncs
 * - Token refresh handling for expired connections
 * - Integration with Ntropy enrichment pipeline
 */

import { storage } from "../storage";
import { 
  fetchAllTransactions, 
  fetchAccounts,
  refreshAccessToken 
} from "../truelayer";
import { encryptToken, decryptToken } from "../encryption";
import type { TrueLayerItem, InsertEnrichedTransaction, AccountAnalysisSummary, EnrichedTransaction } from "@shared/schema";
import { mapNtropyLabelsToCategory } from "./category-mapping";

const SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const STALE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Add one month to a date, clamping to the last day of the target month
 * if the current day exceeds the number of days in the target month.
 * Example: Jan 31 → Feb 28 (or Feb 29 in leap year)
 */
function addOneMonth(date: Date): Date {
  const result = new Date(date);
  const currentDay = result.getDate();
  const currentMonth = result.getMonth();
  
  // Move to the first day of the target month to avoid overflow
  result.setDate(1);
  result.setMonth(currentMonth + 1);
  
  // Get the last day of the target month
  const lastDayOfTargetMonth = new Date(result.getFullYear(), result.getMonth() + 1, 0).getDate();
  
  // Clamp the day to the last day of the target month if needed
  result.setDate(Math.min(currentDay, lastDayOfTargetMonth));
  
  return result;
}

// Concurrency guard: tracks accounts currently being synced
const syncingAccounts = new Set<string>();

// Global scheduler handle
let schedulerInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Check if an account needs refreshing based on lastSyncedAt
 */
function needsRefresh(item: TrueLayerItem): boolean {
  if (!item.lastSyncedAt) return true;
  const lastSync = new Date(item.lastSyncedAt).getTime();
  const now = Date.now();
  return (now - lastSync) > STALE_THRESHOLD_MS;
}

/**
 * Check if an account needs budget recalibration
 * Returns true if nextRecalibrationDate is null or in the past
 */
function needsRecalibration(item: TrueLayerItem): boolean {
  if (!item.nextRecalibrationDate) return true;
  const recalibrationDate = new Date(item.nextRecalibrationDate);
  return recalibrationDate <= new Date();
}

/**
 * Recalibrate account budget analysis
 * Analyzes enriched transactions to compute AccountAnalysisSummary
 * Exported for use by re-enrichment endpoints
 */
export async function recalibrateAccountBudget(item: TrueLayerItem): Promise<void> {
  const accountId = item.id;
  console.log(`[Background Sync] Starting budget recalibration for account ${accountId}`);

  try {
    const transactions = await storage.getEnrichedTransactionsByItemId(accountId);
    
    // Calculate next recalibration date (1 month from now) using helper to avoid overflow
    const nextRecalibrationDate = addOneMonth(new Date());
    
    if (transactions.length === 0) {
      console.log(`[Background Sync] No transactions to analyze for account ${accountId}, updating next recalibration date`);
      // Still update nextRecalibrationDate to prevent constant retries
      await storage.updateTrueLayerItem(accountId, {
        nextRecalibrationDate: nextRecalibrationDate.toISOString().split('T')[0],
      });
      return;
    }

    const summary = computeAccountAnalysisSummary(transactions, item.isSideHustle || false);

    await storage.updateTrueLayerItem(accountId, {
      analysisSummary: summary,
      lastAnalyzedAt: new Date(),
      nextRecalibrationDate: nextRecalibrationDate.toISOString().split('T')[0],
    });

    console.log(`[Background Sync] Budget recalibration completed for account ${accountId}`);
  } catch (error) {
    console.error(`[Background Sync] Budget recalibration failed for account ${accountId}:`, error);
  }
}

/**
 * Compute AccountAnalysisSummary from enriched transactions
 */
function computeAccountAnalysisSummary(
  transactions: EnrichedTransaction[],
  isSideHustle: boolean
): AccountAnalysisSummary {
  const incomeItems: Array<{ description: string; amountCents: number; category: string }> = [];
  const fixedCostsItems: Array<{ description: string; amountCents: number; category: string }> = [];
  const essentialsItems: Array<{ description: string; amountCents: number; category: string }> = [];
  const discretionaryItems: Array<{ description: string; amountCents: number; category: string }> = [];
  const debtPaymentsItems: Array<{ description: string; amountCents: number; category: string }> = [];

  let totalIncomeCents = 0;
  let employmentIncomeCents = 0;
  let otherIncomeCents = 0;
  let sideHustleIncomeCents = 0;
  let fixedCostsCents = 0;
  let essentialsCents = 0;
  let discretionaryCents = 0;
  let debtPaymentsCents = 0;

  for (const tx of transactions) {
    const item = {
      description: tx.merchantCleanName || tx.originalDescription,
      amountCents: tx.amountCents,
      category: tx.ukCategory || tx.budgetCategory || 'other',
    };

    if (tx.entryType === 'incoming') {
      incomeItems.push(item);
      totalIncomeCents += tx.amountCents;

      if (isSideHustle) {
        sideHustleIncomeCents += tx.amountCents;
      } else if (tx.ukCategory === 'employment' || tx.budgetCategory === 'income') {
        employmentIncomeCents += tx.amountCents;
      } else {
        otherIncomeCents += tx.amountCents;
      }
    } else {
      switch (tx.budgetCategory) {
        case 'fixed_costs':
          fixedCostsItems.push(item);
          fixedCostsCents += tx.amountCents;
          break;
        case 'essentials':
          essentialsItems.push(item);
          essentialsCents += tx.amountCents;
          break;
        case 'debt':
          debtPaymentsItems.push(item);
          debtPaymentsCents += tx.amountCents;
          break;
        case 'discretionary':
        default:
          discretionaryItems.push(item);
          discretionaryCents += tx.amountCents;
          break;
      }
    }
  }

  const dateRange = getTransactionDateRange(transactions);
  const analysisMonths = Math.max(1, dateRange);

  const averageMonthlyIncomeCents = Math.round(totalIncomeCents / analysisMonths);
  const avgFixedCents = Math.round(fixedCostsCents / analysisMonths);
  const avgEssentialsCents = Math.round(essentialsCents / analysisMonths);
  const avgDiscretionaryCents = Math.round(discretionaryCents / analysisMonths);
  const avgDebtCents = Math.round(debtPaymentsCents / analysisMonths);

  // Safe-to-spend = Income - Fixed Costs - Variable Essentials (matches budget-engine.ts)
  const safeToSpendCents = Math.max(0, averageMonthlyIncomeCents - avgFixedCents - avgEssentialsCents);
  // Available for debt is what's left after discretionary spending
  const availableForDebtCents = Math.max(0, safeToSpendCents - avgDiscretionaryCents);

  return {
    averageMonthlyIncomeCents,
    employmentIncomeCents: Math.round(employmentIncomeCents / analysisMonths),
    otherIncomeCents: Math.round(otherIncomeCents / analysisMonths),
    sideHustleIncomeCents: Math.round(sideHustleIncomeCents / analysisMonths),
    fixedCostsCents: avgFixedCents,
    essentialsCents: avgEssentialsCents,
    discretionaryCents: avgDiscretionaryCents,
    debtPaymentsCents: avgDebtCents,
    availableForDebtCents,
    breakdown: {
      income: incomeItems,
      fixedCosts: fixedCostsItems,
      essentials: essentialsItems,
      discretionary: discretionaryItems,
      debtPayments: debtPaymentsItems,
    },
    analysisMonths,
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Calculate the date range in months from the transactions
 */
function getTransactionDateRange(transactions: EnrichedTransaction[]): number {
  if (transactions.length === 0) return 1;
  
  const dates = transactions
    .map(tx => tx.transactionDate ? new Date(tx.transactionDate) : null)
    .filter((d): d is Date => d !== null);
  
  if (dates.length === 0) return 1;
  
  const minDate = new Date(Math.min(...dates.map(d => d.getTime())));
  const maxDate = new Date(Math.max(...dates.map(d => d.getTime())));
  
  const diffMonths = (maxDate.getFullYear() - minDate.getFullYear()) * 12 
    + (maxDate.getMonth() - minDate.getMonth()) + 1;
  
  return Math.max(1, diffMonths);
}

/**
 * Acquire a sync lock for an account
 * Returns true if lock acquired, false if already syncing
 */
function acquireSyncLock(accountId: string): boolean {
  if (syncingAccounts.has(accountId)) {
    return false;
  }
  syncingAccounts.add(accountId);
  return true;
}

/**
 * Release the sync lock for an account
 */
function releaseSyncLock(accountId: string): void {
  syncingAccounts.delete(accountId);
}

/**
 * Check if an account is currently syncing
 */
export function isAccountSyncing(accountId: string): boolean {
  return syncingAccounts.has(accountId);
}

/**
 * Get all accounts currently being synced
 */
export function getSyncingAccounts(): string[] {
  return Array.from(syncingAccounts);
}

/**
 * Sync a single TrueLayer account
 * Fetches transactions, enriches with Ntropy, updates analysis summary
 */
async function syncAccount(item: TrueLayerItem): Promise<void> {
  const accountId = item.id;
  
  if (!acquireSyncLock(accountId)) {
    console.log(`[Background Sync] Account ${accountId} already syncing, skipping`);
    return;
  }

  try {
    console.log(`[Background Sync] Starting sync for account ${accountId} (${item.institutionName})`);
    console.log(`[Background Sync] Current connection status: ${item.connectionStatus}, consent expires: ${item.consentExpiresAt}`);

    // Only skip accounts that are truly disconnected or have unrecoverable errors
    // "expired" status means the token expired but we can try to refresh it
    const skipStatuses = ["disconnected", "token_error"];
    if (skipStatuses.includes(item.connectionStatus || "")) {
      console.log(`[Background Sync] Account ${accountId} has unrecoverable status '${item.connectionStatus}', skipping`);
      return;
    }

    // Decrypt access token
    let accessToken: string;
    try {
      accessToken = decryptToken(item.accessTokenEncrypted);
    } catch (error) {
      console.error(`[Background Sync] Failed to decrypt token for account ${accountId}:`, error);
      await storage.updateTrueLayerItem(accountId, { connectionStatus: "token_error" });
      return;
    }

    // Check if token is expired (either by consent date or by connection status)
    const isExpired = (item.consentExpiresAt && new Date(item.consentExpiresAt) < new Date()) 
      || item.connectionStatus === "expired";
    
    if (isExpired && item.refreshTokenEncrypted) {
      try {
        console.log(`[Background Sync] Refreshing expired token for account ${accountId}`);
        const refreshToken = decryptToken(item.refreshTokenEncrypted);
        const newTokens = await refreshAccessToken(refreshToken);
        
        accessToken = newTokens.access_token;
        
        // Update tokens AND set connection status back to active
        await storage.updateTrueLayerItem(accountId, {
          accessTokenEncrypted: encryptToken(newTokens.access_token),
          refreshTokenEncrypted: newTokens.refresh_token 
            ? encryptToken(newTokens.refresh_token) 
            : item.refreshTokenEncrypted,
          consentExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
          connectionStatus: "active",  // Reset to active after successful refresh
        });
        
        console.log(`[Background Sync] Token refreshed successfully for account ${accountId}, status set to active`);
      } catch (refreshError) {
        console.error(`[Background Sync] Token refresh failed for account ${accountId}:`, refreshError);
        await storage.updateTrueLayerItem(accountId, { connectionStatus: "expired" });
        return;
      }
    } else if (isExpired && !item.refreshTokenEncrypted) {
      // No refresh token available, user needs to reconnect
      console.log(`[Background Sync] Account ${accountId} is expired and has no refresh token, requires reconnection`);
      await storage.updateTrueLayerItem(accountId, { connectionStatus: "expired" });
      return;
    }

    // Fetch transactions from TrueLayer (90 days)
    const transactions = await fetchAllTransactions(accessToken, 90);
    console.log(`[Background Sync] Fetched ${transactions.length} transactions for account ${accountId}`);

    // Get existing enriched transactions for this account to find new ones
    const existingTransactions = await storage.getEnrichedTransactionsByItemId(accountId);
    const existingTxIds = new Set(existingTransactions.map(tx => tx.trueLayerTransactionId));
    
    // Filter to only new transactions
    const newTransactions = transactions.filter(tx => !existingTxIds.has(tx.transaction_id));
    console.log(`[Background Sync] Found ${newTransactions.length} new transactions for account ${accountId}`);

    if (newTransactions.length > 0) {
      // Try to enrich with Ntropy, fallback to deterministic categorization
      let enrichedData: any[] = [];
      
      // Get user for account holder name and country
      const user = await storage.getUser(item.userId);
      const accountHolderName = user?.firstName && user?.lastName 
        ? `${user.firstName} ${user.lastName}` 
        : null;
      const userCountry = user?.country || "GB";
      
      // CRITICAL FIX: Fetch Nylas grant ID so Layer 2 (Context Hunter) can function
      const nylasGrants = await storage.getNylasGrantsByUserId(item.userId);
      const nylasGrantId = nylasGrants.length > 0 ? nylasGrants[0].grantId : null;
      if (nylasGrantId) {
        console.log(`[Background Sync] Found Nylas grant for user, enabling email receipt search`);
      }
      
      try {
        const enrichmentResponse = await fetch("http://localhost:8000/enrich-transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            transactions: newTransactions.map(t => ({
              transaction_id: t.transaction_id,
              description: t.description,
              amount: t.amount,
              currency: t.currency || "GBP",
              transaction_type: t.transaction_type,
              transaction_category: t.transaction_category,
              transaction_classification: t.transaction_classification,
              timestamp: t.timestamp,
            })),
            user_id: item.userId,
            truelayer_item_id: accountId,
            analysis_months: 3,
            account_holder_name: accountHolderName,
            country: userCountry,
            nylas_grant_id: nylasGrantId, // CRITICAL: Pass grant ID so agentic Layer 2 can search emails
          }),
        });

        if (enrichmentResponse.ok) {
          const data = await enrichmentResponse.json();
          enrichedData = data.enriched_transactions || [];
          console.log(`[Background Sync] Ntropy enriched ${enrichedData.length} transactions`);
        } else {
          throw new Error("Enrichment service unavailable");
        }
      } catch (enrichError) {
        console.log(`[Background Sync] Ntropy unavailable, using deterministic categorization`);
        
        // Fallback: use deterministic categorization
        enrichedData = newTransactions.map(tx => {
          const isIncoming = tx.amount > 0 || tx.transaction_type === "CREDIT";
          const categoryMapping = mapNtropyLabelsToCategory(
            tx.transaction_classification || [],
            tx.merchant_name,
            tx.description,
            isIncoming
          );
          
          return {
            transaction_id: tx.transaction_id,
            merchant_clean_name: tx.merchant_name || tx.description,
            merchant_logo_url: null,
            merchant_website_url: null,
            labels: tx.transaction_classification || [],
            is_recurring: false,
            recurrence_frequency: null,
            recurrence_day: null,
            amount_cents: Math.round(Math.abs(tx.amount) * 100),
            entry_type: isIncoming ? "incoming" : "outgoing",
            budget_category: categoryMapping.budgetGroup,
            uk_category: categoryMapping.ukCategory,
            transaction_date: tx.timestamp?.split("T")[0] || null,
            // CASCADE FIELDS: Fallback uses deterministic rules (no AI)
            enrichment_source: "math_brain", // Fallback is rule-based
            ntropy_confidence: 0.7, // Lower confidence for fallback
            reasoning_trace: ["Layer 0: Fallback - Ntropy unavailable, used deterministic categorization"],
            exclude_from_analysis: false,
            transaction_type: "regular",
            linked_transaction_id: null,
          };
        });
      }

      // Save enriched transactions
      const transactionsToSave: InsertEnrichedTransaction[] = enrichedData.map((enriched: any) => {
        const originalTx = newTransactions.find(t => t.transaction_id === enriched.transaction_id);
        const categoryMapping = mapNtropyLabelsToCategory(
          enriched.labels || [],
          enriched.merchant_clean_name,
          originalTx?.description,
          enriched.entry_type === "incoming"
        );

        return {
          userId: item.userId,
          trueLayerItemId: accountId,
          trueLayerTransactionId: enriched.transaction_id,
          ntropyTransactionId: enriched.ntropy_transaction_id || null,
          originalDescription: originalTx?.description || "",
          merchantCleanName: enriched.merchant_clean_name || null,
          merchantLogoUrl: enriched.merchant_logo_url || null,
          merchantWebsiteUrl: enriched.merchant_website_url || null,
          labels: enriched.labels || [],
          isRecurring: enriched.is_recurring || false,
          recurrenceFrequency: enriched.recurrence_frequency || null,
          recurrenceDay: enriched.recurrence_day || null,
          amountCents: enriched.amount_cents,
          entryType: enriched.entry_type,
          budgetCategory: categoryMapping.budgetGroup,
          ukCategory: categoryMapping.ukCategory,
          transactionDate: enriched.transaction_date || null,
          // CASCADE FIELDS: Persist the 4-layer cascade results
          enrichmentSource: enriched.enrichment_source || null,
          ntropyConfidence: enriched.ntropy_confidence ?? null,
          reasoningTrace: enriched.reasoning_trace || [],
          excludeFromAnalysis: enriched.exclude_from_analysis || false,
          transactionType: enriched.transaction_type || "regular",
          linkedTransactionId: enriched.linked_transaction_id || null,
        };
      });

      await storage.saveEnrichedTransactions(transactionsToSave);
      console.log(`[Background Sync] Saved ${transactionsToSave.length} enriched transactions for account ${accountId}`);

      // Update lastEnrichedAt
      await storage.updateTrueLayerItem(accountId, { lastEnrichedAt: new Date() });
      
      // IMPORTANT: Always recalibrate after adding new transactions
      // This ensures analysisSummary reflects the newly enriched data
      console.log(`[Background Sync] Triggering immediate budget recalibration after new transactions`);
      const freshItem = await storage.getTrueLayerItemById(accountId);
      if (freshItem) {
        await recalibrateAccountBudget(freshItem);
      }
    } else {
      // No new transactions, but still check if scheduled recalibration is needed
      const updatedItem = await storage.getTrueLayerItemById(accountId);
      if (updatedItem && needsRecalibration(updatedItem)) {
        await recalibrateAccountBudget(updatedItem);
      }
    }

    // Update lastSyncedAt
    await storage.updateTrueLayerItem(accountId, { lastSyncedAt: new Date() });
    console.log(`[Background Sync] Sync completed for account ${accountId}`);

  } catch (error) {
    console.error(`[Background Sync] Sync failed for account ${accountId}:`, error);
  } finally {
    releaseSyncLock(accountId);
  }
}

/**
 * Run a sync cycle for all stale accounts
 */
async function runSyncCycle(): Promise<void> {
  console.log("[Background Sync] Starting sync cycle...");

  try {
    // Get all TrueLayer items that need refresh
    const allItems = await storage.getAllTrueLayerItems();
    const staleItems = allItems.filter(needsRefresh);

    console.log(`[Background Sync] Found ${staleItems.length} accounts needing refresh out of ${allItems.length} total`);

    // Sync accounts in parallel (with concurrency guards preventing duplicates)
    const syncPromises = staleItems.map(item => syncAccount(item));
    await Promise.allSettled(syncPromises);

    console.log("[Background Sync] Sync cycle completed");
  } catch (error) {
    console.error("[Background Sync] Sync cycle failed:", error);
  }
}

/**
 * Start the background sync scheduler
 */
export function startBackgroundSync(): void {
  if (schedulerInterval) {
    console.log("[Background Sync] Scheduler already running");
    return;
  }

  console.log(`[Background Sync] Starting scheduler (interval: ${SYNC_INTERVAL_MS / 60000} minutes)`);
  
  // Run immediately on startup, then every 30 minutes
  runSyncCycle().catch(console.error);
  
  schedulerInterval = setInterval(() => {
    runSyncCycle().catch(console.error);
  }, SYNC_INTERVAL_MS);
}

/**
 * Stop the background sync scheduler
 */
export function stopBackgroundSync(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log("[Background Sync] Scheduler stopped");
  }
}

/**
 * Manually trigger a sync for a specific account
 */
export async function triggerAccountSync(accountId: string): Promise<boolean> {
  const item = await storage.getTrueLayerItemById(accountId);
  if (!item) {
    console.error(`[Background Sync] Account ${accountId} not found`);
    return false;
  }

  await syncAccount(item);
  return true;
}

/**
 * Get sync status for all accounts
 */
export async function getSyncStatus(): Promise<Array<{
  id: string;
  accountName: string;
  institutionName: string;
  lastSyncedAt: string | null;
  needsRefresh: boolean;
  isSyncing: boolean;
}>> {
  const allItems = await storage.getAllTrueLayerItems();
  
  return allItems.map(item => ({
    id: item.id,
    accountName: item.accountName,
    institutionName: item.institutionName,
    lastSyncedAt: item.lastSyncedAt?.toISOString() || null,
    needsRefresh: needsRefresh(item),
    isSyncing: isAccountSyncing(item.id),
  }));
}
