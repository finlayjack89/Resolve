/**
 * Current Finances API Routes
 * 
 * Provides endpoints for the Current Finances feature which displays
 * connected bank accounts, their transaction summaries, and combined
 * budget analysis for debt repayment calculations.
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import type { TrueLayerItem, EnrichedTransaction, AccountAnalysisSummary } from "@shared/schema";
import { ProcessingStatus } from "@shared/schema";
import { 
  mapNtropyLabelsToCategory, 
  UKBudgetCategory,
  type BudgetGroup,
  BUDGET_GROUP_CONFIG,
  getCategoriesForGroup,
  isIncomeCategory,
  isFixedCostCategory,
  isEssentialCategory,
  isDiscretionaryCategory,
  isDebtPaymentCategory,
} from "../services/category-mapping";
import { triggerAccountSync, isAccountSyncing, recalibrateAccountBudget } from "../services/background-sync";
import { detectGhostPairs } from "../services/reconciliation";
import { detectRecurringPatterns } from "../services/frequency-detection";
import { analyzeBudget } from "../services/budget-engine";
import {
  fetchTransactions,
  fetchCardTransactions,
  calculateDynamicDateRange,
  decryptToken,
  refreshAccessToken,
  encryptToken,
} from "../truelayer";

// Response types for the Current Finances API
export interface ConnectedAccountSummary {
  id: string;
  trueLayerAccountId: string;
  institutionName: string;
  institutionLogoUrl: string | null;
  accountName: string;
  accountType: string | null;
  currency: string | null;
  connectionStatus: string | null;
  isSideHustle: boolean | null;
  lastSyncedAt: string | null;
  lastEnrichedAt: string | null;
  lastAnalyzedAt: string | null;
  transactionCount: number;
  analysisSummary: AccountAnalysisSummary | null;
}

export interface AccountDetailResponse extends ConnectedAccountSummary {
  transactions: EnrichedTransactionDetail[];
  categoryBreakdown: CategoryBreakdown[];
}

export interface EnrichedTransactionDetail {
  id: string;
  trueLayerTransactionId: string;
  originalDescription: string;
  merchantCleanName: string | null;
  merchantLogoUrl: string | null;
  amountCents: number;
  entryType: string;
  ukCategory: string | null;
  budgetCategory: string | null;
  transactionDate: string | null;
  isRecurring: boolean | null;
  recurrenceFrequency: string | null;
  // Ghost transaction fields
  isGhostTransaction: boolean;
  transactionType: string | null;
  linkedTransactionId: string | null;
  linkedTransactionDetails: {
    accountName: string;
    date: string;
    amount: number;
  } | null;
}

export interface CategoryBreakdown {
  category: string;
  displayName: string;
  budgetGroup: BudgetGroup;
  icon: string;
  color: string;
  totalCents: number;
  transactionCount: number;
  percentage: number;
}

export interface CombinedFinancesResponse {
  accounts: ConnectedAccountSummary[];
  combined: {
    totalIncomeCents: number;
    employmentIncomeCents: number;
    sideHustleIncomeCents: number;
    otherIncomeCents: number;
    fixedCostsCents: number;
    essentialsCents: number;
    discretionaryCents: number;
    debtPaymentsCents: number;
    availableForDebtCents: number;
    analysisMonths: number;
  };
  budgetForDebt: {
    currentBudgetCents: number | null;
    potentialBudgetCents: number | null;
    suggestedBudgetCents: number;
  };
}

function buildAccountSummary(
  item: TrueLayerItem,
  transactionCount: number
): ConnectedAccountSummary {
  return {
    id: item.id,
    trueLayerAccountId: item.trueLayerAccountId,
    institutionName: item.institutionName,
    institutionLogoUrl: item.institutionLogoUrl,
    accountName: item.accountName,
    accountType: item.accountType,
    currency: item.currency,
    connectionStatus: item.connectionStatus,
    isSideHustle: item.isSideHustle,
    lastSyncedAt: item.lastSyncedAt?.toISOString() || null,
    lastEnrichedAt: item.lastEnrichedAt?.toISOString() || null,
    lastAnalyzedAt: item.lastAnalyzedAt?.toISOString() || null,
    transactionCount,
    analysisSummary: item.analysisSummary,
  };
}

function buildCategoryBreakdown(transactions: EnrichedTransaction[]): CategoryBreakdown[] {
  const categoryTotals = new Map<string, { totalCents: number; count: number }>();
  let grandTotal = 0;

  for (const tx of transactions) {
    const category = tx.ukCategory || UKBudgetCategory.OTHER;
    const current = categoryTotals.get(category) || { totalCents: 0, count: 0 };
    current.totalCents += Math.abs(tx.amountCents);
    current.count += 1;
    categoryTotals.set(category, current);
    grandTotal += Math.abs(tx.amountCents);
  }

  const breakdown: CategoryBreakdown[] = [];
  
  for (const [category, data] of Array.from(categoryTotals)) {
    const ukCategory = category as UKBudgetCategory;
    const mapping = mapNtropyLabelsToCategory([], undefined, undefined, false);
    let budgetGroup: BudgetGroup = "other";
    
    if (isIncomeCategory(ukCategory)) budgetGroup = "income";
    else if (isFixedCostCategory(ukCategory)) budgetGroup = "fixed_costs";
    else if (isEssentialCategory(ukCategory)) budgetGroup = "essentials";
    else if (isDiscretionaryCategory(ukCategory)) budgetGroup = "discretionary";
    else if (isDebtPaymentCategory(ukCategory)) budgetGroup = "debt";
    
    const groupConfig = BUDGET_GROUP_CONFIG[budgetGroup];

    breakdown.push({
      category,
      displayName: category.charAt(0).toUpperCase() + category.slice(1).replace(/_/g, " "),
      budgetGroup,
      icon: groupConfig.icon,
      color: groupConfig.color,
      totalCents: data.totalCents,
      transactionCount: data.count,
      percentage: grandTotal > 0 ? Math.round((data.totalCents / grandTotal) * 100) : 0,
    });
  }

  return breakdown.sort((a, b) => b.totalCents - a.totalCents);
}

/**
 * Recalculates and updates user budget from all connected accounts
 * Called when accounts are added/removed or re-analyzed
 */
async function recalculateUserBudgetFromAccounts(userId: string): Promise<void> {
  const items = await storage.getTrueLayerItemsByUserId(userId);
  
  let totalAvailableForDebt = 0;
  let totalDiscretionary = 0;
  
  for (const item of items) {
    const summary = item.analysisSummary;
    if (!summary) continue;
    
    totalAvailableForDebt += summary.availableForDebtCents;
    totalDiscretionary += summary.discretionaryCents;
  }
  
  // Current budget = what they have available after all expenses
  const currentBudgetCents = totalAvailableForDebt;
  
  // Potential budget = available + 50% of discretionary (what they could save)
  const potentialBudgetCents = totalAvailableForDebt + Math.round(totalDiscretionary * 0.5);
  
  // Update user with calculated budget values
  await storage.updateUser(userId, {
    currentBudgetCents,
    potentialBudgetCents,
  });
  
  console.log(`[Budget Recalc] User ${userId}: current=${currentBudgetCents}, potential=${potentialBudgetCents}`);
}


export function registerCurrentFinancesRoutes(app: Express): void {
  /**
   * GET /api/current-finances/accounts
   * Returns all connected bank accounts with their analysis summaries
   */
  app.get("/api/current-finances/accounts", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const items = await storage.getTrueLayerItemsByUserId(userId);
      
      const accountsWithCounts = await Promise.all(
        items.map(async (item) => {
          const transactionCount = await storage.getEnrichedTransactionsCountByItemId(item.id);
          return buildAccountSummary(item, transactionCount);
        })
      );

      res.json({ accounts: accountsWithCounts });
    } catch (error: any) {
      console.error("[Current Finances] Error fetching accounts:", error);
      res.status(500).json({ message: "Failed to fetch connected accounts" });
    }
  });

  /**
   * GET /api/current-finances/account/:id
   * Returns detailed view of a specific connected account with transactions
   */
  app.get("/api/current-finances/account/:id", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const accountId = req.params.id;
      
      const item = await storage.getTrueLayerItemById(accountId);
      
      if (!item) {
        return res.status(404).json({ message: "Account not found" });
      }
      
      if (item.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      console.log(`[DEBUG] Fetching transactions for accountId: ${accountId}`);
      const allTransactions = await storage.getEnrichedTransactionsByItemId(accountId);
      
      // INCLUDE ghost transactions (transfers) but mark them as such
      // Only exclude bounced payments and refunds that have linked transactions
      const transactions = allTransactions.filter(tx => {
        // Always include ghost/transfer transactions - they should be displayed with special styling
        if (tx.transactionType === "transfer" || tx.isInternalTransfer) {
          return true;
        }
        // Exclude bounced payments and refunds from the main display
        if (tx.excludeFromAnalysis && (tx.transactionType === "bounced_payment" || tx.transactionType === "refund" || tx.transactionType === "reversal")) {
          return false;
        }
        return true;
      });
      console.log(`[DEBUG] Found ${allTransactions.length} total transactions, ${transactions.length} after filtering`);
      
      // Build a lookup map for linked transaction details
      const allItemTransactions = allTransactions;
      const linkedTransactionsMap = new Map<string, { accountName: string; date: string; amount: number }>();
      
      // Get all TrueLayer items for this user to get account names
      const userItems = await storage.getTrueLayerItemsByUserId(userId);
      const itemNameMap = new Map<string, string>();
      for (const userItem of userItems) {
        itemNameMap.set(userItem.id, userItem.accountName || userItem.institutionName);
      }
      
      // Build linked transaction details for ghost pairs
      for (const tx of allItemTransactions) {
        if (tx.linkedTransactionId) {
          // Find the linked transaction across all user's accounts
          const linkedTx = await storage.getEnrichedTransactionById(tx.linkedTransactionId);
          if (linkedTx) {
            const linkedAccountName = linkedTx.trueLayerItemId 
              ? itemNameMap.get(linkedTx.trueLayerItemId) || "Other Account"
              : "Other Account";
            linkedTransactionsMap.set(tx.id, {
              accountName: linkedAccountName,
              date: linkedTx.transactionDate,
              amount: linkedTx.amountCents,
            });
          }
        }
      }
      
      const transactionCount = transactions.filter(tx => tx.transactionType !== "transfer" && !tx.isInternalTransfer).length;
      
      const transactionDetails: EnrichedTransactionDetail[] = transactions.map((tx) => {
        const isGhostTransaction = tx.transactionType === "transfer" || tx.isInternalTransfer === true;
        return {
          id: tx.id,
          trueLayerTransactionId: tx.trueLayerTransactionId,
          originalDescription: tx.originalDescription,
          merchantCleanName: tx.merchantCleanName,
          merchantLogoUrl: tx.merchantLogoUrl,
          amountCents: tx.amountCents,
          entryType: tx.entryType,
          ukCategory: tx.ukCategory,
          budgetCategory: tx.budgetCategory,
          transactionDate: tx.transactionDate,
          isRecurring: tx.isRecurring,
          recurrenceFrequency: tx.recurrenceFrequency,
          isGhostTransaction,
          transactionType: tx.transactionType,
          linkedTransactionId: tx.linkedTransactionId,
          linkedTransactionDetails: linkedTransactionsMap.get(tx.id) || null,
        };
      });

      const categoryBreakdown = buildCategoryBreakdown(transactions);

      const response: AccountDetailResponse = {
        ...buildAccountSummary(item, transactionCount),
        transactions: transactionDetails,
        categoryBreakdown,
      };

      res.json(response);
    } catch (error: any) {
      console.error("[Current Finances] Error fetching account detail:", error);
      res.status(500).json({ message: "Failed to fetch account details" });
    }
  });

  /**
   * GET /api/current-finances/combined
   * HOLISTIC FIX: Calculates the budget from the UNIFIED stream, not by summing accounts.
   * This prevents double-counting and respects Ghost Pair exclusions.
   */
  app.get("/api/current-finances/combined", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const items = await storage.getTrueLayerItemsByUserId(userId);
      const user = await storage.getUser(userId);
      
      // 1. Get Accounts Summary (Bank Truth - for the list view)
      const accounts = await Promise.all(
        items.map(async (item) => {
          const transactionCount = await storage.getEnrichedTransactionsCountByItemId(item.id);
          return buildAccountSummary(item, transactionCount);
        })
      );

      // 2. HOLISTIC CALCULATION (Budget Truth)
      // Fetch ALL transactions for the user
      const allTransactions = await storage.getEnrichedTransactionsByUserId(userId);
      
      // Filter out "Ghost Pairs" and excluded items
      const budgetTransactions = allTransactions
        .filter(tx => !tx.excludeFromAnalysis)
        .map(tx => {
          // FIX: The budget engine relies on amount sign to determine income vs spending
          // amountCents is stored as absolute value, so we need to apply the sign based on entryType
          const absAmount = tx.amountCents / 100;
          const signedAmount = tx.entryType === 'incoming' ? absAmount : -absAmount;
          
          return {
            description: tx.originalDescription,
            amount: signedAmount, // Positive for income, negative for spending
            transaction_classification: tx.labels || [],
            transaction_type: tx.entryType === 'incoming' ? "CREDIT" : "DEBIT",
            date: tx.transactionDate,
          };
        });

      // Run the Math Brain on the unified stream
      const globalAnalysis = analyzeBudget({
        transactions: budgetTransactions as any, 
        analysisMonths: 6 
      });

      // 3. Map the Global Analysis to the Response
      const combined = {
        totalIncomeCents: globalAnalysis.averageMonthlyIncomeCents,
        employmentIncomeCents: 0, // derived in engine breakdown if needed
        sideHustleIncomeCents: 0, 
        otherIncomeCents: 0,      
        fixedCostsCents: globalAnalysis.fixedCostsCents,
        essentialsCents: globalAnalysis.variableEssentialsCents,
        discretionaryCents: globalAnalysis.discretionaryCents,
        debtPaymentsCents: 0, // Calculated separately via debt detection if needed
        availableForDebtCents: globalAnalysis.safeToSpendCents,
        analysisMonths: globalAnalysis.closedMonthsAnalyzed || globalAnalysis.analysisMonths,
      };

      // Calculate suggested budget for debt repayment
      // Use 50% of discretionary spending as a conservative suggestion
      const suggestedBudgetCents = Math.round(combined.discretionaryCents * 0.5);

      const response: CombinedFinancesResponse = {
        accounts,
        combined,
        budgetForDebt: {
          currentBudgetCents: user?.currentBudgetCents || null,
          potentialBudgetCents: user?.potentialBudgetCents || null,
          suggestedBudgetCents,
        },
      };

      res.json(response);
    } catch (error: any) {
      console.error("[Current Finances] Error fetching combined view:", error);
      res.status(500).json({ message: "Failed to fetch combined finances" });
    }
  });

  /**
   * POST /api/current-finances/account/:id/analyze
   * Triggers full refresh pipeline: sync fresh transactions from TrueLayer,
   * re-enrich via Ntropy, and recalculate the analysis
   */
  app.post("/api/current-finances/account/:id/analyze", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const accountId = req.params.id;
      
      const item = await storage.getTrueLayerItemById(accountId);
      
      if (!item) {
        return res.status(404).json({ message: "Account not found" });
      }
      
      if (item.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Check if this account is already syncing
      if (isAccountSyncing(accountId)) {
        return res.status(409).json({ 
          message: "Account is already syncing. Please wait and try again.",
          syncing: true 
        });
      }

      console.log(`[Current Finances] Starting full refresh pipeline for account ${accountId}`);

      // Step 1: Sync fresh transactions from TrueLayer and enrich via Ntropy
      // triggerAccountSync handles:
      // - Fetching transactions from TrueLayer
      // - Enriching via Ntropy (or fallback categorization)
      // - Saving enriched transactions
      // - Running budget recalibration (computes and saves analysisSummary)
      const syncSuccess = await triggerAccountSync(accountId);
      
      if (!syncSuccess) {
        console.error(`[Current Finances] Sync failed for account ${accountId}`);
        return res.status(500).json({ 
          message: "Failed to sync transactions from bank. Please check connection status." 
        });
      }

      console.log(`[Current Finances] Sync completed for account ${accountId}`);

      // Step 2: Recalculate overall user budget from all accounts
      await recalculateUserBudgetFromAccounts(userId);

      // Step 3: Fetch the updated item to return the latest analysis summary
      const updatedItem = await storage.getTrueLayerItemById(accountId);
      const analysisSummary = updatedItem?.analysisSummary || null;

      console.log(`[Current Finances] Full refresh pipeline completed for account ${accountId}`);

      res.json({ 
        success: true, 
        analysisSummary,
        message: "Transactions synced, enriched, and analyzed successfully."
      });
    } catch (error: any) {
      console.error("[Current Finances] Error analyzing account:", error);
      res.status(500).json({ message: "Failed to analyze account" });
    }
  });

  /**
   * POST /api/current-finances/account/:id/recalibrate
   * Force recalculates the analysisSummary from existing transactions
   * without requiring TrueLayer sync or Python enrichment.
   * This is useful when:
   * - Transaction flags (like excludeFromAnalysis) have been updated
   * - Budget calculation logic has changed
   */
  app.post("/api/current-finances/account/:id/recalibrate", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const accountId = req.params.id;
      
      const item = await storage.getTrueLayerItemById(accountId);
      
      if (!item) {
        return res.status(404).json({ message: "Account not found" });
      }
      
      if (item.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      console.log(`[Current Finances] Starting forced recalibration for account ${accountId}`);

      // Recalibrate the account's analysisSummary
      await recalibrateAccountBudget(item);
      
      // Also recalculate the user's overall budget
      await recalculateUserBudgetFromAccounts(userId);
      
      // Fetch updated item
      const updatedItem = await storage.getTrueLayerItemById(accountId);
      const analysisSummary = updatedItem?.analysisSummary || null;

      console.log(`[Current Finances] Recalibration completed for account ${accountId}`);

      res.json({ 
        success: true, 
        analysisSummary,
        message: "Budget recalibrated successfully with updated transaction flags."
      });
    } catch (error: any) {
      console.error("[Current Finances] Error recalibrating account:", error);
      res.status(500).json({ message: "Failed to recalibrate budget" });
    }
  });

  /**
   * POST /api/finances/initialize-analysis
   * Batch initialization endpoint for staged onboarding flow.
   * Fetches transactions for ALL STAGED accounts in parallel and updates them to ACTIVE.
   * This is called after the user has connected all their accounts and is ready to generate their report.
   */
  app.post("/api/finances/initialize-analysis", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      console.log(`[Initialize Analysis] Starting batch initialization for user ${userId}`);
      
      // Step 1: Query all STAGED accounts for this user
      const allItems = await storage.getTrueLayerItemsByUserId(userId);
      const stagedItems = allItems.filter(item => item.processingStatus === ProcessingStatus.STAGED);
      
      if (stagedItems.length === 0) {
        return res.status(400).json({ 
          message: "No staged accounts found. Please connect at least one bank account first.",
          success: false
        });
      }
      
      console.log(`[Initialize Analysis] Found ${stagedItems.length} staged accounts to process`);
      
      // Step 2: Update all accounts to ANALYZING status
      await Promise.all(
        stagedItems.map(item => 
          storage.updateTrueLayerItem(item.id, { processingStatus: ProcessingStatus.ANALYZING })
        )
      );
      
      // Step 3: Fetch transactions for ALL accounts in parallel
      const { from, to } = calculateDynamicDateRange();
      
      const fetchResults = await Promise.all(
        stagedItems.map(async (item) => {
          try {
            // TOKEN REFRESH: Check if token is expired and refresh if needed
            // This fixes the issue where accounts connected yesterday can't be analyzed
            // because the access token expired (typically after 1 hour)
            let accessToken = decryptToken(item.accessTokenEncrypted);
            
            const isExpired = item.consentExpiresAt && 
              new Date(item.consentExpiresAt) < new Date();
            
            if (isExpired && item.refreshTokenEncrypted) {
              console.log(`[Initialize Analysis] Token expired for ${item.institutionName}, refreshing...`);
              try {
                const refreshToken = decryptToken(item.refreshTokenEncrypted);
                const newTokens = await refreshAccessToken(refreshToken);
                
                // Update the stored tokens
                await storage.updateTrueLayerItem(item.id, {
                  accessTokenEncrypted: encryptToken(newTokens.access_token),
                  refreshTokenEncrypted: newTokens.refresh_token 
                    ? encryptToken(newTokens.refresh_token) 
                    : item.refreshTokenEncrypted,
                  consentExpiresAt: new Date(Date.now() + (newTokens.expires_in * 1000)),
                  connectionStatus: "active",
                });
                
                accessToken = newTokens.access_token;
                console.log(`[Initialize Analysis] Token refreshed successfully for ${item.institutionName}`);
              } catch (refreshError: any) {
                console.error(`[Initialize Analysis] Token refresh failed for ${item.id}:`, refreshError.message);
                // Update to expired status so user knows they need to reconnect
                await storage.updateTrueLayerItem(item.id, { 
                  processingStatus: ProcessingStatus.ERROR,
                  connectionStatus: "expired",
                  connectionError: "Connection expired. Please reconnect this account.",
                });
                return { id: item.id, success: false, error: "Token refresh failed - please reconnect" };
              }
            } else if (isExpired && !item.refreshTokenEncrypted) {
              console.log(`[Initialize Analysis] Token expired but no refresh token for ${item.institutionName}`);
              await storage.updateTrueLayerItem(item.id, { 
                processingStatus: ProcessingStatus.ERROR,
                connectionStatus: "expired",
                connectionError: "Connection expired and cannot be refreshed. Please reconnect this account.",
              });
              return { id: item.id, success: false, error: "No refresh token - please reconnect" };
            }
            
            let transactions: any[] = [];
            
            // Use appropriate fetch method based on connection type
            if (item.connectionType === "credit_card") {
              const txResponse = await fetchCardTransactions(accessToken, item.trueLayerAccountId, from, to);
              transactions = txResponse.results || [];
            } else {
              const txResponse = await fetchTransactions(accessToken, item.trueLayerAccountId, from, to);
              transactions = txResponse.results || [];
            }
            
            console.log(`[Initialize Analysis] Fetched ${transactions.length} transactions for ${item.institutionName} - ${item.accountName}`);
            
            // Store transactions
            if (transactions.length > 0) {
              const rawTransactionsToStore = transactions.map((tx: any) => {
                // CREDIT CARD FIX: For credit cards, the sign semantics are inverted:
                // - DEBIT on a credit card = spending (should be outgoing/negative for budget)
                // - CREDIT on a credit card = payment to card (should be incoming/positive for budget)
                // For current accounts:
                // - Positive amount or CREDIT = incoming
                // - Negative amount or DEBIT = outgoing
                let isIncoming: boolean;
                
                if (item.connectionType === "credit_card") {
                  // Credit cards: CREDIT = payment received (incoming), DEBIT = spending (outgoing)
                  isIncoming = tx.transaction_type === "CREDIT";
                } else {
                  // Current accounts: positive amount or CREDIT = incoming
                  isIncoming = tx.amount > 0 || tx.transaction_type === "CREDIT";
                }
                
                return {
                  userId: userId,
                  trueLayerItemId: item.id,
                  trueLayerTransactionId: String(tx.transaction_id),
                  originalDescription: tx.description || "",
                  amountCents: Math.round(Math.abs(tx.amount) * 100),
                  currency: tx.currency || "GBP",
                  entryType: isIncoming ? "incoming" : "outgoing",
                  transactionDate: tx.timestamp?.split("T")[0] || new Date().toISOString().split("T")[0],
                  ukCategory: tx.transaction_category || (isIncoming ? "income" : "uncategorized"),
                  budgetGroup: isIncoming ? "income" : "discretionary",
                  isRecurring: false,
                  enrichmentStage: "pending",
                  ntropyConfidence: null,
                  enrichmentSource: null,
                  labels: tx.transaction_classification || [],
                };
              });
              
              await storage.saveEnrichedTransactions(rawTransactionsToStore);
            }
            
            // Clear any previous errors but keep in ANALYZING state until Step 6 completes recalibration
            await storage.updateTrueLayerItem(item.id, { 
              connectionError: null,
            });
            
            return { id: item.id, success: true, transactionCount: transactions.length };
          } catch (error: any) {
            console.error(`[Initialize Analysis] Failed to process account ${item.id}:`, error.message);
            
            // Parse error message to provide user-friendly messages
            let connectionError = error.message;
            let connectionStatus = "error";
            
            // Check for specific TrueLayer/Open Banking error patterns
            if (error.message.includes("sca_exceeded") || error.message.includes("SCA exemption")) {
              connectionError = "Bank requires fresh authentication. Please reconnect this account.";
              connectionStatus = "expired";
            } else if (error.message.includes("Article 10A") || error.message.includes("access_denied")) {
              connectionError = "Access denied by bank. Please reconnect this account with fresh consent.";
              connectionStatus = "expired";
            } else if (error.message.includes("401") || error.message.includes("token")) {
              connectionError = "Authentication expired. Please reconnect this account.";
              connectionStatus = "expired";
            } else if (error.message.includes("403")) {
              connectionError = "Bank blocked access. Please reconnect this account.";
              connectionStatus = "expired";
            }
            
            // Update status to ERROR with helpful message
            await storage.updateTrueLayerItem(item.id, { 
              processingStatus: ProcessingStatus.ERROR,
              connectionError,
              connectionStatus,
            });
            
            return { id: item.id, success: false, error: connectionError };
          }
        })
      );
      
      // Step 4: Summary
      const successful = fetchResults.filter(r => r.success);
      const failed = fetchResults.filter(r => !r.success);
      const totalTransactions = successful.reduce((sum, r) => sum + (r.transactionCount || 0), 0);
      
      console.log(`[Initialize Analysis] Batch complete: ${successful.length} accounts synced, ${failed.length} failed, ${totalTransactions} total transactions`);
      
      // Step 4.5: ENRICHMENT - Run transactions through the enrichment cascade
      // This was missing and causing transactions to stay in raw TrueLayer format
      const PYTHON_API_URL_STAGED = process.env.PYTHON_API_URL || "http://localhost:8000";
      const user = await storage.getUser(userId);
      const accountHolderName = user?.firstName && user?.lastName 
        ? `${user.firstName} ${user.lastName}` 
        : null;
      const userCountry = user?.country || "GB";
      const nylasGrants = await storage.getNylasGrantsByUserId(userId);
      const nylasGrantId = nylasGrants.length > 0 ? nylasGrants[0].grantId : null;
      
      // Get pending transactions that need enrichment
      const pendingTransactions = await storage.getEnrichedTransactionsByUserId(userId);
      const transactionsToEnrich = pendingTransactions.filter(tx => tx.enrichmentStage === "pending");
      
      if (transactionsToEnrich.length > 0) {
        console.log(`[Initialize Analysis] Enriching ${transactionsToEnrich.length} transactions...`);
        
        // Get connected lender names for debt detection - populated from user's debt accounts
        const userAccounts = await storage.getAccountsByUserId(userId);
        const connectedLenderNames = userAccounts
          .filter(acc => acc.lenderName)
          .map(acc => acc.lenderName!);
        
        try {
          const enrichmentResponse = await fetch(`${PYTHON_API_URL_STAGED}/enrich-transactions`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transactions: transactionsToEnrich.map(tx => ({
                transaction_id: tx.trueLayerTransactionId,
                description: tx.originalDescription,
                amount: tx.amountCents / 100,
                currency: tx.currency || "GBP",
                transaction_type: tx.entryType === "incoming" ? "CREDIT" : "DEBIT",
                transaction_category: tx.ukCategory,
                transaction_classification: tx.labels || [],
                timestamp: tx.transactionDate,
              })),
              user_id: userId,
              analysis_months: 6,
              account_holder_name: accountHolderName,
              country: userCountry,
              nylas_grant_id: nylasGrantId,
            }),
          });
          
          if (enrichmentResponse.ok) {
            const data = await enrichmentResponse.json();
            const enrichedData = data.enriched_transactions || [];
            console.log(`[Initialize Analysis] Enrichment service returned ${enrichedData.length} enriched transactions`);
            
            // Update transactions with enrichment data
            for (const enriched of enrichedData) {
              const existingTx = transactionsToEnrich.find(
                tx => tx.trueLayerTransactionId === enriched.transaction_id
              );
              
              if (existingTx) {
                // Find the account for this transaction to check connectionType
                const txItem = stagedItems.find(i => i.id === existingTx.trueLayerItemId);
                
                // CREDIT CARD FIX: Re-derive entry type from enrichment with connection type awareness
                let entryType = enriched.entry_type || existingTx.entryType;
                if (txItem?.connectionType === "credit_card" && enriched.transaction_type) {
                  // For credit cards, enforce CREDIT = incoming, DEBIT = outgoing
                  entryType = enriched.transaction_type === "CREDIT" ? "incoming" : "outgoing";
                }
                
                const categoryMapping = mapNtropyLabelsToCategory(
                  enriched.labels || [],
                  enriched.merchant_clean_name,
                  existingTx.originalDescription,
                  entryType === "incoming",
                  connectedLenderNames
                );
                
                await storage.updateEnrichedTransaction(existingTx.id!, {
                  merchantCleanName: enriched.merchant_clean_name || null,
                  merchantLogoUrl: enriched.merchant_logo_url || null,
                  merchantWebsiteUrl: enriched.merchant_website_url || null,
                  labels: enriched.labels || [],
                  isRecurring: enriched.is_recurring || false,
                  recurrenceFrequency: enriched.recurrence_frequency || null,
                  budgetCategory: categoryMapping.budgetGroup,
                  ukCategory: categoryMapping.ukCategory,
                  enrichmentSource: enriched.enrichment_source || "ntropy",
                  ntropyConfidence: enriched.ntropy_confidence ?? null,
                  agenticConfidence: enriched.agentic_confidence ?? null,
                  reasoningTrace: enriched.reasoning_trace || [],
                  excludeFromAnalysis: enriched.exclude_from_analysis ?? false,
                  transactionType: enriched.transaction_type || "regular",
                  linkedTransactionId: enriched.linked_transaction_id || null,
                  enrichmentStage: enriched.enrichment_source === "ntropy" ? "ntropy_done" 
                    : enriched.enrichment_source ? "agentic_done" 
                    : "math_brain_done",
                });
              }
            }
            console.log(`[Initialize Analysis] Updated ${enrichedData.length} transactions with enrichment data`);
          } else {
            console.warn(`[Initialize Analysis] Enrichment service returned ${enrichmentResponse.status}, using fallback categorization`);
            // Fallback: mark as math_brain_done to indicate basic categorization applied
            for (const tx of transactionsToEnrich) {
              await storage.updateEnrichedTransaction(tx.id!, {
                enrichmentStage: "math_brain_done",
                enrichmentSource: "math_brain",
              });
            }
          }
        } catch (enrichError: any) {
          console.warn(`[Initialize Analysis] Enrichment service unavailable: ${enrichError.message}, using fallback categorization`);
          // Fallback: mark as math_brain_done
          for (const tx of transactionsToEnrich) {
            await storage.updateEnrichedTransaction(tx.id!, {
              enrichmentStage: "math_brain_done",
              enrichmentSource: "math_brain",
            });
          }
        }
      }
      
      // Step 5: Run Ghost Pair Detection
      const allTransactions = await storage.getEnrichedTransactionsByUserId(userId);
      const ghostPairs = detectGhostPairs(allTransactions);
      
      let ghostPairsDetected = 0;
      if (ghostPairs.length > 0) {
        console.log(`[Initialize Analysis] Detected ${ghostPairs.length} ghost pairs (internal transfers)`);
        
        for (const pair of ghostPairs) {
          await storage.updateEnrichedTransaction(pair.outgoingTransactionId, {
            isInternalTransfer: true,
            excludeFromAnalysis: true,
            ecosystemPairId: pair.ecosystemPairId,
            transactionType: "transfer",
            enrichmentSource: "math_brain",
          });
          await storage.updateEnrichedTransaction(pair.incomingTransactionId, {
            isInternalTransfer: true,
            excludeFromAnalysis: true,
            ecosystemPairId: pair.ecosystemPairId,
            transactionType: "transfer",
            enrichmentSource: "math_brain",
          });
        }
        ghostPairsDetected = ghostPairs.length;
      }
      
      // Step 5: Detect Recurring Patterns
      let recurringPatternsDetected = 0;
      try {
        const freshTransactions = await storage.getEnrichedTransactionsByUserId(userId);
        const patterns = detectRecurringPatterns(freshTransactions, userId);
        
        if (patterns.length > 0) {
          console.log(`[Initialize Analysis] Detected ${patterns.length} recurring payment patterns`);
          const savedPatterns = await storage.upsertRecurringPatterns(patterns);
          recurringPatternsDetected = savedPatterns.length;
        }
      } catch (patternError: any) {
        console.error(`[Initialize Analysis] Error detecting recurring patterns:`, patternError.message);
      }
      
      // Step 6: Recalibrate Individual Accounts (The Missing Piece!)
      // This populates the 'analysisSummary' column so the UI tiles aren't empty
      const successfulItems = fetchResults.filter(r => r.success).map(r => stagedItems.find(i => i.id === r.id)!);
      
      await Promise.all(successfulItems.map(async (item) => {
        console.log(`[Initialize Analysis] Recalibrating budget for ${item.institutionName}`);
        await recalibrateAccountBudget(item);
        
        // Mark as ACTIVE now that it has data
        await storage.updateTrueLayerItem(item.id, { 
          processingStatus: ProcessingStatus.ACTIVE,
          lastSyncedAt: new Date()
        });
      }));
      
      if (failed.length === stagedItems.length) {
        return res.status(500).json({
          message: "Failed to synchronize accounts. Please try reconnecting your banks.",
          success: false,
          details: failed,
        });
      }
      
      res.json({
        message: "Ecosystem synchronized.",
        success: true,
        accountsProcessed: successful.length,
        accountsFailed: failed.length,
        totalTransactions,
        ghostPairsDetected,
        recurringPatternsDetected,
      });
    } catch (error: any) {
      console.error("[Initialize Analysis] Error during batch initialization:", error);
      res.status(500).json({ 
        message: "Failed to initialize analysis",
        success: false,
        error: error.message 
      });
    }
  });

  /**
   * GET /api/finances/analysis-insights
   * Returns recent analysis insights including detected merchants, ghost pairs, and patterns.
   * Used by the frontend to show real-time progress during analysis.
   */
  app.get("/api/finances/analysis-insights", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      // Get all user's transactions
      const transactions = await storage.getEnrichedTransactionsByUserId(userId);
      
      // Get unique merchants with logos (most recent first)
      const merchantsWithLogos = transactions
        .filter(tx => tx.merchantCleanName && tx.merchantLogoUrl)
        .reduce((acc, tx) => {
          if (!acc.find(m => m.name === tx.merchantCleanName)) {
            acc.push({
              name: tx.merchantCleanName!,
              logoUrl: tx.merchantLogoUrl!,
              category: tx.ukCategory || 'uncategorized',
            });
          }
          return acc;
        }, [] as { name: string; logoUrl: string; category: string }[])
        .slice(0, 20);
      
      // Get ghost pairs (internal transfers)
      const ghostPairs = transactions.filter(tx => tx.isInternalTransfer === true);
      const uniqueGhostPairIds = new Set(ghostPairs.map(tx => tx.ecosystemPairId).filter(Boolean));
      
      // Get recent detection events (transactions marked as ghost pairs)
      const recentDetections = ghostPairs
        .slice(0, 10)
        .map(tx => ({
          type: 'transfer',
          date: tx.transactionDate,
          description: tx.merchantCleanName || tx.originalDescription,
          amount: tx.amountCents,
        }));
      
      // Get recurring patterns
      const patterns = await storage.getRecurringPatternsByUserId(userId);
      const activePatterns = patterns.filter(p => p.isActive);
      
      // Summary stats
      const totalTransactions = transactions.length;
      const analyzedTransactions = transactions.filter(tx => tx.enrichmentSource).length;
      const excludedTransactions = transactions.filter(tx => tx.excludeFromAnalysis).length;
      
      res.json({
        merchants: merchantsWithLogos,
        ghostPairsCount: uniqueGhostPairIds.size,
        recurringPatternsCount: activePatterns.length,
        recentDetections,
        stats: {
          totalTransactions,
          analyzedTransactions,
          excludedTransactions,
        },
        patterns: activePatterns.slice(0, 10).map(p => ({
          merchantName: p.merchantName,
          frequency: p.frequency,
          avgAmount: p.avgAmountCents,
        })),
      });
    } catch (error: any) {
      console.error("[Analysis Insights] Error:", error);
      res.status(500).json({ message: "Failed to get analysis insights" });
    }
  });

  /**
   * POST /api/current-finances/account/:id/re-enrich
   * Re-processes existing transactions through the full enrichment cascade (Layers 0-4)
   * without requiring a TrueLayer connection. This is useful for:
   * - Testing enrichment changes
   * - Re-analyzing with updated confidence logic
   * - Triggering Nylas context hunting for low-confidence transactions
   */
  app.post("/api/current-finances/account/:id/re-enrich", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const accountId = req.params.id;
      
      const item = await storage.getTrueLayerItemById(accountId);
      
      if (!item) {
        return res.status(404).json({ message: "Account not found" });
      }
      
      if (item.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Check if this account is already syncing
      if (isAccountSyncing(accountId)) {
        return res.status(409).json({ 
          message: "Account is already being processed. Please wait and try again.",
          syncing: true 
        });
      }

      console.log(`[Current Finances] Starting re-enrichment for account ${accountId}`);

      // Step 1: Get existing enriched transactions from the database
      const existingTransactions = await storage.getEnrichedTransactionsByItemId(accountId);
      
      if (existingTransactions.length === 0) {
        return res.status(400).json({ 
          message: "No transactions found to re-enrich. Please sync with bank first." 
        });
      }

      console.log(`[Current Finances] Found ${existingTransactions.length} transactions to re-enrich`);

      // Step 2: Convert database transactions to format expected by enrichment service
      // The enrichment service expects TrueLayer-like format
      // CRITICAL: Ensure transaction_id is always a string to prevent Python slice errors
      const transactionsForEnrichment = existingTransactions.map(tx => ({
        transaction_id: String(tx.trueLayerTransactionId || `fallback-${tx.id}`),
        description: String(tx.originalDescription || ""),
        amount: tx.amountCents / 100, // Convert cents back to decimal
        currency: tx.currency || "GBP",
        timestamp: tx.transactionDate ? new Date(tx.transactionDate).toISOString() : new Date().toISOString(),
        transaction_type: tx.entryType === "incoming" ? "CREDIT" : "DEBIT",
        transaction_classification: tx.labels || [],
        merchant_name: tx.merchantCleanName || null,
      }));

      // Step 3: Get user's Nylas grant for context hunting
      const nylasGrants = await storage.getNylasGrantsByUserId(userId);
      const nylasGrantId = nylasGrants.length > 0 ? nylasGrants[0].grantId : null;

      // Get user info for account holder name
      const user = await storage.getUser(userId);
      const accountHolderName = user?.firstName && user?.lastName 
        ? `${user.firstName} ${user.lastName}` 
        : undefined;

      // Step 4: Call the Python enrichment service with streaming for progress
      const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";
      
      console.log(`[Current Finances] Sending ${transactionsForEnrichment.length} transactions to enrichment service`);
      
      const enrichmentResponse = await fetch(`${PYTHON_API_URL}/enrich-transactions-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transactions: transactionsForEnrichment,
          user_id: userId,
          truelayer_item_id: accountId,
          analysis_months: 3,
          account_holder_name: accountHolderName,
          country: user?.country || "GB",
          nylas_grant_id: nylasGrantId, // Pass Nylas grant for Layer 2 context hunting
        }),
      });

      if (!enrichmentResponse.ok) {
        console.error(`[Current Finances] Enrichment service failed: ${enrichmentResponse.status}`);
        return res.status(500).json({ 
          message: "Enrichment service unavailable. Please try again later." 
        });
      }

      // Process streaming response to get final result
      const reader = enrichmentResponse.body?.getReader();
      if (!reader) {
        return res.status(500).json({ message: "Failed to read enrichment response" });
      }

      let enrichedData: any = null;
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === "complete") {
                enrichedData = event.result;
              } else if (event.type === "error") {
                console.error(`[Current Finances] Enrichment error: ${event.message}`);
              }
            } catch (e) {
              // Ignore parse errors for partial data
            }
          }
        }
      }

      if (!enrichedData || !enrichedData.enriched_transactions) {
        return res.status(500).json({ 
          message: "Enrichment completed but no results returned" 
        });
      }

      console.log(`[Current Finances] Enrichment complete. Received ${enrichedData.enriched_transactions.length} enriched transactions`);

      // Step 5: Update existing transactions with new enrichment data
      // We update in-place rather than delete/recreate to preserve IDs
      let updatedCount = 0;
      let failedCount = 0;
      
      for (const enriched of enrichedData.enriched_transactions) {
        const existingTx = existingTransactions.find(
          tx => tx.trueLayerTransactionId === enriched.transaction_id
        );
        
        if (existingTx) {
          try {
            await storage.updateEnrichedTransaction(existingTx.id, {
              // Core merchant/category fields
              merchantCleanName: enriched.merchant_clean_name || existingTx.merchantCleanName,
              merchantLogoUrl: enriched.merchant_logo_url || existingTx.merchantLogoUrl,
              merchantWebsiteUrl: enriched.merchant_website_url || existingTx.merchantWebsiteUrl,
              labels: enriched.labels || existingTx.labels,
              isRecurring: enriched.is_recurring ?? existingTx.isRecurring,
              recurrenceFrequency: enriched.recurrence_frequency || existingTx.recurrenceFrequency,
              budgetCategory: enriched.budget_category || existingTx.budgetCategory,
              ukCategory: enriched.uk_category || existingTx.ukCategory,
              // Cascade tracking fields - FULL pipeline state
              enrichmentSource: enriched.enrichment_source || null, // Reset if not set by cascade
              ntropyConfidence: enriched.ntropy_confidence ?? null,
              agenticConfidence: enriched.agentic_confidence ?? null, // From Layer 2/3
              reasoningTrace: enriched.reasoning_trace || [],
              excludeFromAnalysis: enriched.exclude_from_analysis ?? false,
              transactionType: enriched.transaction_type || "regular",
              linkedTransactionId: enriched.linked_transaction_id || null,
              // Determine enrichment stage based on what was processed
              enrichmentStage: enriched.enrichment_source === "ntropy" ? "ntropy_done" 
                : enriched.enrichment_source ? "agentic_done" 
                : "pending",
            });
            updatedCount++;
          } catch (updateError) {
            console.error(`[Current Finances] Failed to update transaction ${existingTx.id}:`, updateError);
            failedCount++;
          }
        }
      }

      console.log(`[Current Finances] Updated ${updatedCount} transactions, ${failedCount} failed`);

      // Step 6: Trigger budget recalibration
      await recalibrateAccountBudget(item);
      
      // Step 7: Recalculate overall user budget
      await recalculateUserBudgetFromAccounts(userId);

      // Step 8: Fetch updated item for response
      const updatedItem = await storage.getTrueLayerItemById(accountId);
      const analysisSummary = updatedItem?.analysisSummary || null;

      console.log(`[Current Finances] Re-enrichment completed for account ${accountId}`);

      res.json({ 
        success: failedCount === 0, 
        analysisSummary,
        transactionsProcessed: existingTransactions.length,
        transactionsUpdated: updatedCount,
        transactionsFailed: failedCount,
        message: failedCount > 0 
          ? `Re-enriched ${updatedCount} transactions (${failedCount} failed).`
          : `Re-enriched ${updatedCount} transactions through the full cascade.`
      });
    } catch (error: any) {
      console.error("[Current Finances] Error re-enriching account:", error);
      res.status(500).json({ message: "Failed to re-enrich transactions" });
    }
  });

  /**
   * POST /api/current-finances/reanalyse-all
   * Re-processes all connected accounts through the enrichment cascade together.
   * This ensures ghost pair detection works across all accounts and budget totals remain consistent.
   * Optionally syncs new transactions from TrueLayer before re-analysing.
   */
  app.post("/api/current-finances/reanalyse-all", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { syncFromBank = false } = req.body;

      console.log(`[Current Finances] Starting reanalyse-all for user ${userId}, syncFromBank: ${syncFromBank}`);

      // Get all connected accounts
      const items = await storage.getTrueLayerItemsByUserId(userId);
      
      if (items.length === 0) {
        return res.status(400).json({ 
          message: "No connected accounts found. Please connect a bank account first." 
        });
      }

      // Filter to only active accounts (not in error state)
      const activeItems = items.filter(item => 
        item.connectionStatus === "connected" || 
        item.connectionStatus === "active" || 
        item.connectionStatus === "pending_enrichment"
      );

      if (activeItems.length === 0) {
        return res.status(400).json({ 
          message: "No active accounts found. Your bank connections may need to be refreshed." 
        });
      }

      let totalTransactionsProcessed = 0;
      let accountsProcessed = 0;
      const errors: string[] = [];

      // Step 1: Optionally sync new transactions from TrueLayer
      if (syncFromBank) {
        console.log(`[Current Finances] Syncing new transactions from TrueLayer for ${activeItems.length} accounts`);
        
        for (const item of activeItems) {
          try {
            // Only attempt sync if we have valid tokens
            if (item.accessTokenEncrypted && item.connectionStatus !== "token_error") {
              await triggerAccountSync(item.id);
            }
          } catch (syncError: any) {
            console.error(`[Current Finances] Failed to sync account ${item.id}:`, syncError.message);
            // Continue with other accounts even if one fails to sync
            errors.push(`${item.institutionName}: sync failed`);
          }
        }
        
        // Wait a moment for sync to complete (background process)
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Step 2: Collect all transactions from all accounts
      const allTransactions: any[] = [];
      const accountTransactionMap = new Map<string, any[]>();

      for (const item of activeItems) {
        try {
          const transactions = await storage.getEnrichedTransactionsByItemId(item.id);
          if (transactions.length > 0) {
            accountTransactionMap.set(item.id, transactions);
            allTransactions.push(...transactions);
          }
        } catch (error: any) {
          console.error(`[Current Finances] Failed to get transactions for account ${item.id}:`, error.message);
          errors.push(`${item.institutionName}: failed to read transactions`);
        }
      }

      if (allTransactions.length === 0) {
        return res.status(400).json({ 
          message: "No transactions found across your accounts. Please sync with your bank first." 
        });
      }

      console.log(`[Current Finances] Found ${allTransactions.length} total transactions across ${accountTransactionMap.size} accounts`);

      // Step 3: Detect ghost pairs across ALL accounts together
      const ghostPairs = detectGhostPairs(allTransactions);
      console.log(`[Current Finances] Detected ${ghostPairs.length} ghost pairs across all accounts`);

      // Step 4: Update transactions with ghost pair information
      if (ghostPairs.length > 0) {
        for (const pair of ghostPairs) {
          try {
            // Update the outgoing transaction
            await storage.updateEnrichedTransaction(pair.outgoingTransactionId, {
              isInternalTransfer: true,
              transactionType: "transfer",
              linkedTransactionId: pair.incomingTransactionId,
            });
            
            // Update the incoming transaction
            await storage.updateEnrichedTransaction(pair.incomingTransactionId, {
              isInternalTransfer: true,
              transactionType: "transfer",
              linkedTransactionId: pair.outgoingTransactionId,
            });
          } catch (pairError: any) {
            console.error(`[Current Finances] Failed to update ghost pair:`, pairError.message);
          }
        }
      }

      // Step 5: Re-run budget analysis for ALL accounts (including empty ones)
      // Empty accounts need recalibration to clear any stale data
      for (const item of activeItems) {
        try {
          // Always call recalibrateAccountBudget - it handles 0 transactions by clearing the summary
          await recalibrateAccountBudget(item);
          const transactions = accountTransactionMap.get(item.id);
          if (transactions && transactions.length > 0) {
            totalTransactionsProcessed += transactions.length;
          }
          accountsProcessed++;
        } catch (analyzeError: any) {
          console.error(`[Current Finances] Failed to analyze account ${item.id}:`, analyzeError.message);
          errors.push(`${item.institutionName}: analysis failed`);
        }
      }

      console.log(`[Current Finances] Reanalyse-all complete: ${accountsProcessed} accounts, ${totalTransactionsProcessed} transactions, ${ghostPairs.length} ghost pairs`);

      res.json({
        success: true,
        accountsProcessed,
        totalTransactionsProcessed,
        ghostPairsDetected: ghostPairs.length,
        errors: errors.length > 0 ? errors : undefined,
        message: errors.length > 0 
          ? `Reanalysed ${accountsProcessed} accounts with ${errors.length} warnings.`
          : `Successfully reanalysed ${accountsProcessed} accounts and detected ${ghostPairs.length} internal transfers.`,
      });
    } catch (error: any) {
      console.error("[Current Finances] Error in reanalyse-all:", error);
      res.status(500).json({ message: "Failed to reanalyse accounts" });
    }
  });

  /**
   * GET /api/current-finances/refresh-status
   * Returns refresh/sync status for all connected accounts
   */
  app.get("/api/current-finances/refresh-status", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const items = await storage.getTrueLayerItemsByUserId(userId);
      
      const now = new Date();
      const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);
      
      const status = items.map((item) => {
        const lastSync = item.lastSyncedAt ? new Date(item.lastSyncedAt) : null;
        const needsRefresh = !lastSync || lastSync < thirtyMinutesAgo;
        
        return {
          id: item.id,
          accountName: item.accountName,
          institutionName: item.institutionName,
          lastSyncedAt: item.lastSyncedAt?.toISOString() || null,
          needsRefresh,
          connectionStatus: item.connectionStatus,
        };
      });

      res.json({ accounts: status });
    } catch (error: any) {
      console.error("[Current Finances] Error fetching refresh status:", error);
      res.status(500).json({ message: "Failed to fetch refresh status" });
    }
  });

  /**
   * DELETE /api/truelayer/item/:id
   * Removes a connected bank account and all its transaction data
   */
  app.delete("/api/truelayer/item/:id", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const itemId = req.params.id;
      
      const item = await storage.getTrueLayerItemById(itemId);
      
      if (!item) {
        return res.status(404).json({ message: "Account not found" });
      }
      
      if (item.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      // Delete all enriched transactions for this account first (cascades in DB but explicit is safer)
      await storage.deleteEnrichedTransactionsByItemId(itemId);
      
      // Delete the TrueLayer item itself
      await storage.deleteTrueLayerItemById(itemId);
      
      // Recalculate user budget from remaining accounts
      await recalculateUserBudgetFromAccounts(userId);
      
      console.log(`[Current Finances] Removed account ${itemId} for user ${userId}`);
      
      res.json({ success: true, message: "Account removed successfully" });
    } catch (error: any) {
      console.error("[Current Finances] Error removing account:", error);
      res.status(500).json({ message: "Failed to remove account" });
    }
  });

  /**
   * PATCH /api/truelayer/item/:id
   * Updates a TrueLayer item (e.g., side hustle flag)
   */
  app.patch("/api/truelayer/item/:id", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const itemId = req.params.id;
      
      // Validate request body
      const updateSchema = z.object({
        isSideHustle: z.boolean(),
      });
      
      const parseResult = updateSchema.safeParse(req.body);
      if (!parseResult.success) {
        return res.status(400).json({ message: "isSideHustle must be a boolean" });
      }
      
      const { isSideHustle } = parseResult.data;
      
      const item = await storage.getTrueLayerItemById(itemId);
      
      if (!item) {
        return res.status(404).json({ message: "Account not found" });
      }
      
      if (item.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }

      await storage.updateTrueLayerItem(itemId, { isSideHustle });
      
      res.json({ success: true });
    } catch (error: any) {
      console.error("[Current Finances] Error updating item:", error);
      res.status(500).json({ message: "Failed to update account" });
    }
  });

  // ==================== Nylas Proxy Routes ====================
  // These routes proxy to the Python FastAPI backend for Nylas email integration
  
  const PYTHON_API_URL = process.env.PYTHON_API_URL || "http://localhost:8000";

  /**
   * GET /api/nylas/grants
   * Check Nylas availability and user's connected email grants
   */
  app.get("/api/nylas/grants", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      console.log(`[Nylas Proxy] Checking grants for user: ${userId}`);
      
      // First, check the database for existing grants
      const userGrants = await storage.getNylasGrantsByUserId(userId);
      const hasGrants = userGrants.length > 0;
      const connectedEmail = hasGrants ? userGrants[0].emailAddress : undefined;
      
      console.log(`[Nylas Proxy] User has ${userGrants.length} grants in database`);
      
      // Then check Python service availability
      let nylasAvailable = false;
      let pythonMessage = "";
      
      try {
        const response = await fetch(`${PYTHON_API_URL}/api/nylas/grants/${userId}`);
        
        if (response.ok) {
          const data = await response.json();
          nylasAvailable = data.nylas_available === true;
          pythonMessage = data.message || "";
          console.log(`[Nylas Proxy] Python service response - nylas_available: ${nylasAvailable}`);
        } else {
          console.log(`[Nylas Proxy] Python service returned status: ${response.status}`);
        }
      } catch (pythonError: any) {
        console.error("[Nylas Proxy] Python service unavailable:", pythonError.message);
      }
      
      res.json({
        nylas_available: nylasAvailable,
        has_grants: hasGrants,
        connected_email: connectedEmail,
        message: hasGrants 
          ? "Email connected" 
          : nylasAvailable 
            ? "Ready to connect email" 
            : pythonMessage || "Nylas service initializing"
      });
    } catch (error: any) {
      console.error("[Nylas Proxy] Error checking grants:", error);
      res.json({
        nylas_available: false,
        has_grants: false,
        message: "Failed to check grant status"
      });
    }
  });

  // Build the callback URL dynamically based on the environment
  function getNylasCallbackUrl(): string {
    // First check for explicit environment variable
    if (process.env.NYLAS_REDIRECT_URI) {
      return process.env.NYLAS_REDIRECT_URI;
    }
    // Use Replit dev domain if available
    if (process.env.REPLIT_DEV_DOMAIN) {
      return `https://${process.env.REPLIT_DEV_DOMAIN}/api/nylas/callback`;
    }
    // Fallback for local development
    return "http://localhost:5000/api/nylas/callback";
  }

  /**
   * GET /api/nylas/auth-url
   * Get Nylas OAuth URL for email connection
   * Uses a fixed callback URL (/api/nylas/callback) so only ONE URL needs to be registered in Nylas
   */
  app.get("/api/nylas/auth-url", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      // Use our dedicated callback URL - this is the ONLY URL that needs to be in Nylas dashboard
      const callbackUrl = getNylasCallbackUrl();
      console.log(`[Nylas] Generating auth URL with callback: ${callbackUrl}`);
      
      const url = new URL(`${PYTHON_API_URL}/api/nylas/auth-url`);
      url.searchParams.set("user_id", userId);
      url.searchParams.set("redirect_uri", callbackUrl);
      
      const response = await fetch(url.toString());
      
      if (response.ok) {
        const data = await response.json();
        res.json(data);
      } else {
        res.json({
          auth_url: null,
          error: "Failed to generate auth URL"
        });
      }
    } catch (error: any) {
      console.error("[Nylas Proxy] Error getting auth URL:", error);
      res.json({
        auth_url: null,
        error: "Nylas service unavailable"
      });
    }
  });

  /**
   * GET /api/nylas/callback
   * Handle Nylas OAuth callback - this is where Nylas redirects after user authorizes
   * Receives: ?code=...&state=userId
   */
  app.get("/api/nylas/callback", async (req, res) => {
    try {
      const code = req.query.code as string;
      const state = req.query.state as string; // This is the user_id we passed
      
      if (!code || !state) {
        console.error("[Nylas Callback] Missing code or state parameter");
        return res.redirect("/current-finances?email_error=missing_params");
      }
      
      console.log(`[Nylas Callback] Received OAuth callback for user: ${state}`);
      
      // Call Python backend to exchange code for token
      const response = await fetch(`${PYTHON_API_URL}/api/nylas/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, state }),
      });
      
      if (!response.ok) {
        const errorText = await response.text();
        console.error("[Nylas Callback] Token exchange failed:", errorText);
        return res.redirect("/current-finances?email_error=token_exchange_failed");
      }
      
      const data = await response.json();
      
      if (!data.success || !data.grant_id) {
        console.error("[Nylas Callback] Invalid response from token exchange:", data);
        return res.redirect("/current-finances?email_error=invalid_response");
      }
      
      // Save the grant to the database
      await storage.createNylasGrant({
        userId: state,
        grantId: data.grant_id,
        emailAddress: data.email || "unknown",
        provider: data.provider || "unknown",
      });
      
      console.log(`[Nylas Callback] Successfully saved grant for user ${state}, email: ${data.email}`);
      
      // Redirect to current-finances page with success indicator
      res.redirect("/current-finances?email_connected=true");
    } catch (error: any) {
      console.error("[Nylas Callback] Error handling callback:", error);
      res.redirect("/current-finances?email_error=server_error");
    }
  });

  /**
   * POST /api/nylas/callback
   * Alternative POST handler for programmatic token exchange (legacy support)
   */
  app.post("/api/nylas/callback", requireAuth, async (req, res) => {
    try {
      const response = await fetch(`${PYTHON_API_URL}/api/nylas/callback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req.body),
      });
      
      if (response.ok) {
        const data = await response.json();
        res.json(data);
      } else {
        const error = await response.text();
        res.status(response.status).json({ error });
      }
    } catch (error: any) {
      console.error("[Nylas Proxy] Error handling callback:", error);
      res.status(500).json({ error: "Nylas service unavailable" });
    }
  });

  /**
   * POST /api/nylas/manual-sync
   * Manually add a Nylas grant for the current user (for cases where OAuth callback didn't save)
   */
  app.post("/api/nylas/manual-sync", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { grantId, emailAddress, provider } = req.body;
      
      if (!grantId || !emailAddress) {
        return res.status(400).json({ error: "grantId and emailAddress are required" });
      }
      
      console.log(`[Nylas Manual Sync] Adding grant for user ${userId}, email: ${emailAddress}`);
      
      // Check if grant already exists
      const existingGrants = await storage.getNylasGrantsByUserId(userId);
      const existingGrant = existingGrants.find(g => g.grantId === grantId);
      
      if (existingGrant) {
        console.log(`[Nylas Manual Sync] Grant already exists for user ${userId}`);
        return res.json({ success: true, message: "Grant already exists", grant: existingGrant });
      }
      
      // Create the grant
      const grant = await storage.createNylasGrant({
        userId,
        grantId,
        emailAddress,
        provider: provider || "google",
      });
      
      console.log(`[Nylas Manual Sync] Successfully created grant for user ${userId}`);
      res.json({ success: true, message: "Grant created successfully", grant });
    } catch (error: any) {
      console.error("[Nylas Manual Sync] Error:", error);
      res.status(500).json({ error: error.message || "Failed to sync grant" });
    }
  });

  /**
   * POST /api/dev/seed-test-transactions
   * Development-only endpoint to create test data for enrichment cascade testing
   * Creates a mock bank account with PayPal, Amazon, and regular transactions
   */
  if (process.env.NODE_ENV === "development") {
    app.post("/api/dev/seed-test-transactions", requireAuth, async (req, res) => {
      try {
        const userId = (req.user as any).id;
        const now = new Date();
        
        console.log(`[Dev Seed] Creating test data for user ${userId}`);
        
        // Create a mock TrueLayer item (fake bank account)
        const mockItem = await storage.createTrueLayerItem({
          userId,
          trueLayerAccountId: `mock_account_${Date.now()}`,
          institutionName: "Test Bank (Dev)",
          institutionLogoUrl: null,
          accountName: "Test Current Account",
          accountType: "current",
          currency: "GBP",
          accessTokenEncrypted: "mock_encrypted_token", // Fake token
          refreshTokenEncrypted: "mock_encrypted_refresh",
          consentExpiresAt: new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), // 90 days from now
          lastSyncedAt: now,
          connectionStatus: "active",
        });

        console.log(`[Dev Seed] Created mock TrueLayer item: ${mockItem.id}`);

        // Create test transactions - mix of PayPal (low confidence), Amazon, and regular
        const testTransactions = [
          // PayPal transactions - should trigger 0.5x penalty and Nylas cascade
          {
            originalDescription: "PAYPAL *SPOTIFY",
            amountCents: 999,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          {
            originalDescription: "PAYPAL *AMAZON PRIME",
            amountCents: 899,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          {
            originalDescription: "PAYPAL *UNKNOWN MERCHANT",
            amountCents: 2499,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          // Amazon transactions - should also trigger 0.5x penalty
          {
            originalDescription: "AMAZON.CO.UK*MKXXXXXX",
            amountCents: 4599,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          {
            originalDescription: "AMZN MKTP UK*ABCDEF",
            amountCents: 1299,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 12 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          // Regular transactions - should get normal Ntropy confidence
          {
            originalDescription: "TESCO STORES 1234",
            amountCents: 5647,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          {
            originalDescription: "SAINSBURYS SUPERMARKET",
            amountCents: 3299,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          {
            originalDescription: "NETFLIX.COM",
            amountCents: 1599,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          // Income - for balance
          {
            originalDescription: "ACME CORP SALARY",
            amountCents: 250000,
            entryType: "incoming",
            transactionDate: new Date(now.getTime() - 20 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
          // Transfer pair - should trigger Ghost Pair detection
          {
            originalDescription: "Transfer to Savings",
            amountCents: 50000,
            entryType: "outgoing",
            transactionDate: new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
          },
        ];

        // Create enriched transactions (pending enrichment)
        const transactionsToInsert = testTransactions.map(tx => ({
          userId,
          trueLayerItemId: mockItem.id,
          trueLayerTransactionId: `mock_tx_${Date.now()}_${Math.random().toString(36).substring(7)}`,
          originalDescription: tx.originalDescription,
          amountCents: tx.amountCents,
          entryType: tx.entryType,
          transactionDate: tx.transactionDate,
          currency: "GBP",
          enrichmentStage: "pending" as const, // Ready for enrichment
          merchantCleanName: null,
          labels: [],
          isRecurring: false,
          reasoningTrace: [],
          contextData: {},
        }));

        await storage.saveEnrichedTransactions(transactionsToInsert);

        console.log(`[Dev Seed] Created ${transactionsToInsert.length} test transactions`);

        res.json({
          success: true,
          message: `Created test bank account with ${transactionsToInsert.length} transactions`,
          accountId: mockItem.id,
          transactions: transactionsToInsert.length,
          testCases: {
            paypal: 3,
            amazon: 2,
            regular: 3,
            income: 1,
            transfer: 1,
          },
          nextStep: `Call POST /api/current-finances/account/${mockItem.id}/re-enrich to test the enrichment cascade`,
        });
      } catch (error: any) {
        console.error("[Dev Seed] Error:", error);
        res.status(500).json({ error: error.message || "Failed to seed test data" });
      }
    });
  }
}
