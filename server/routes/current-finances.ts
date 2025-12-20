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
import { triggerAccountSync, isAccountSyncing } from "../services/background-sync";

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

function aggregateAnalysisSummaries(
  accounts: Array<{ item: TrueLayerItem; transactionCount: number }>
): CombinedFinancesResponse["combined"] {
  let totalIncome = 0;
  let employment = 0;
  let sideHustle = 0;
  let otherIncome = 0;
  let fixedCosts = 0;
  let essentials = 0;
  let discretionary = 0;
  let debtPayments = 0;
  let analysisMonths = 1;

  for (const { item } of accounts) {
    const summary = item.analysisSummary;
    if (!summary) continue;

    // Handle side hustle income separately
    if (item.isSideHustle) {
      sideHustle += summary.employmentIncomeCents + summary.otherIncomeCents;
    } else {
      employment += summary.employmentIncomeCents;
      otherIncome += summary.otherIncomeCents + summary.sideHustleIncomeCents;
    }
    
    totalIncome += summary.averageMonthlyIncomeCents;
    fixedCosts += summary.fixedCostsCents;
    essentials += summary.essentialsCents;
    discretionary += summary.discretionaryCents;
    debtPayments += summary.debtPaymentsCents;
    analysisMonths = Math.max(analysisMonths, summary.analysisMonths);
  }

  const availableForDebt = Math.max(0, totalIncome - fixedCosts - essentials - debtPayments);

  return {
    totalIncomeCents: totalIncome,
    employmentIncomeCents: employment,
    sideHustleIncomeCents: sideHustle,
    otherIncomeCents: otherIncome,
    fixedCostsCents: fixedCosts,
    essentialsCents: essentials,
    discretionaryCents: discretionary,
    debtPaymentsCents: debtPayments,
    availableForDebtCents: availableForDebt,
    analysisMonths,
  };
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

      const transactions = await storage.getEnrichedTransactionsByItemId(accountId);
      const transactionCount = transactions.length;
      
      const transactionDetails: EnrichedTransactionDetail[] = transactions.map((tx) => ({
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
      }));

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
   * Returns aggregated view across all accounts with debt budget calculation
   */
  app.get("/api/current-finances/combined", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const items = await storage.getTrueLayerItemsByUserId(userId);
      const user = await storage.getUser(userId);
      
      const accountsWithCounts = await Promise.all(
        items.map(async (item) => {
          const transactionCount = await storage.getEnrichedTransactionsCountByItemId(item.id);
          return { item, transactionCount };
        })
      );

      const accounts = accountsWithCounts.map(({ item, transactionCount }) => 
        buildAccountSummary(item, transactionCount)
      );
      
      const combined = aggregateAnalysisSummaries(accountsWithCounts);
      
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
      
      const response = await fetch(`${PYTHON_API_URL}/api/nylas/grants/${userId}`);
      
      if (response.ok) {
        const data = await response.json();
        res.json(data);
      } else {
        // Python service unavailable or error
        res.json({
          nylas_available: false,
          has_grants: false,
          message: "Nylas service unavailable"
        });
      }
    } catch (error: any) {
      console.error("[Nylas Proxy] Error checking grants:", error);
      res.json({
        nylas_available: false,
        has_grants: false,
        message: "Failed to connect to Nylas service"
      });
    }
  });

  /**
   * GET /api/nylas/auth-url
   * Get Nylas OAuth URL for email connection
   */
  app.get("/api/nylas/auth-url", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const redirectUri = req.query.redirect_uri as string;
      
      const url = new URL(`${PYTHON_API_URL}/api/nylas/auth-url`);
      url.searchParams.set("user_id", userId);
      if (redirectUri) {
        url.searchParams.set("redirect_uri", redirectUri);
      }
      
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
   * POST /api/nylas/callback
   * Handle Nylas OAuth callback
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
}
