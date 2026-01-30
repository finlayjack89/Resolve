import type {
  TrueLayerTransaction,
  TrueLayerDirectDebit,
  TrueLayerPersona,
  BudgetAnalysisResponse,
  DetectedDebtPayment,
  BreakdownItem,
} from "@shared/schema";
import { startOfMonth, isBefore, differenceInCalendarMonths, getDaysInMonth, differenceInDays, format } from "date-fns";

// Debt-related keywords for detection
const DEBT_KEYWORDS = [
  "AMEX",
  "AMERICAN EXPRESS",
  "BARCLAYCARD",
  "BARCLAYS CARD",
  "CAPITAL ONE",
  "MBNA",
  "HSBC CARD",
  "LLOYDS CARD",
  "NATWEST CARD",
  "SANTANDER CARD",
  "VIRGIN MONEY",
  "TESCO CREDIT",
  "LOAN",
  "KLARNA",
  "CLEARPAY",
  "AFTERPAY",
  "LAYBUY",
  "PAYPAL CREDIT",
  "VERY",
  "LITTLEWOODS",
  "JD WILLIAMS",
  "STUDIO",
  "BRIGHTHOUSE",
  "PROVIDENT",
  "QUICKQUID",
  "WONGA",
  "PAYDAY",
];

// Fixed cost classification patterns
const FIXED_COST_CLASSIFICATIONS = [
  ["Bills", "Rent"],
  ["Bills", "Utilities"],
  ["Bills", "Tax"],
  ["Bills", "Credit Card"],
  ["Home", "Mortgage"],
  ["Home", "Rent"],
  ["Insurance"],
];

// Variable essential classification patterns
const VARIABLE_ESSENTIAL_CLASSIFICATIONS = [
  ["Shopping", "Groceries"],
  ["Transport"],
  ["Health"],
  ["Education"],
];

// Income classification patterns
const INCOME_CLASSIFICATIONS = [
  ["Income", "Salary"],
  ["Income"],
];

// Internal transfer patterns to exclude from income
const TRANSFER_KEYWORDS = ["Transfer", "TRANSFER", "TFR", "INTERNAL"];

// Returned/refund patterns to exclude from income
// These are NOT real income - they are money coming back from failed payments
const RETURNED_PAYMENT_KEYWORDS = [
  "RETURNED",
  "DD RETURNED", 
  "DD RET",
  "DIRECT DEBIT RETURNED",
  "REFUND",
  "REF",
  "REVERSAL",
  "REV",
  "RETURN",
  "CHARGEBACK",
  "CREDIT MEMO",
  "UNPAID",
  "DISHONOURED",
  "BOUNCED",
  "INSUFFICIENT FUNDS",
  "CANCELLED",
];

function classificationMatches(
  txClassification: string[],
  patterns: string[][]
): boolean {
  for (const pattern of patterns) {
    // Check if ALL elements of the pattern exist in the transaction classification
    const allMatch = pattern.every((p) =>
      txClassification.some(
        (c) => c.toLowerCase() === p.toLowerCase()
      )
    );
    if (allMatch) return true;
  }
  return false;
}

function isInternalTransfer(tx: TrueLayerTransaction): boolean {
  // Check if description contains transfer keywords
  const upperDesc = tx.description.toUpperCase();
  if (TRANSFER_KEYWORDS.some((kw) => upperDesc.includes(kw.toUpperCase()))) {
    return true;
  }
  // Check if classification indicates transfer
  if (tx.transaction_classification.some((c) => c.toLowerCase() === "transfer")) {
    return true;
  }
  return false;
}

function isReturnedOrRefund(tx: TrueLayerTransaction): boolean {
  // Check if description contains returned payment/refund keywords
  const upperDesc = tx.description.toUpperCase();
  if (RETURNED_PAYMENT_KEYWORDS.some((kw) => upperDesc.includes(kw.toUpperCase()))) {
    return true;
  }
  return false;
}

function detectDebtPayments(transactions: TrueLayerTransaction[]): DetectedDebtPayment[] {
  const detectedDebts = new Map<string, DetectedDebtPayment>();

  for (const tx of transactions) {
    // Only look at debits (negative amounts)
    if (tx.amount >= 0) continue;
    
    const upperDesc = tx.description.toUpperCase();
    for (const keyword of DEBT_KEYWORDS) {
      if (upperDesc.includes(keyword.toUpperCase())) {
        const existingDebt = detectedDebts.get(keyword);
        const amountCents = Math.round(Math.abs(tx.amount) * 100);
        
        // Determine debt type
        let type = "credit_card";
        if (keyword.includes("LOAN") || keyword === "PROVIDENT" || keyword === "QUICKQUID" || keyword === "WONGA" || keyword === "PAYDAY") {
          type = "loan";
        } else if (["KLARNA", "CLEARPAY", "AFTERPAY", "LAYBUY"].includes(keyword)) {
          type = "bnpl";
        }
        
        if (existingDebt) {
          // Add to existing amount
          existingDebt.amountCents += amountCents;
        } else {
          detectedDebts.set(keyword, {
            description: keyword,
            amountCents,
            type,
          });
        }
        break;
      }
    }
  }

  return Array.from(detectedDebts.values());
}

function categorizeTransaction(tx: TrueLayerTransaction): "income" | "fixed" | "variable" | "discretionary" | "excluded" {
  const classification = tx.transaction_classification;
  const txType = tx.transaction_type;

  // Credits are income (if not internal transfer or returned payment)
  if (tx.amount > 0) {
    // Returned payments, refunds, and bounced DDs are NOT income - exclude them entirely
    if (isReturnedOrRefund(tx)) {
      return "excluded"; // These are not real income - money coming back from failed payments
    }
    if (isInternalTransfer(tx)) {
      return "excluded"; // Internal transfers are not income
    }
    if (classificationMatches(classification, INCOME_CLASSIFICATIONS)) {
      return "income";
    }
    return "income"; // Default credits to income
  }

  // Standing orders and direct debits are fixed costs
  if (txType === "STANDING_ORDER" || txType === "DIRECT_DEBIT") {
    return "fixed";
  }

  // Check for fixed cost classifications
  if (classificationMatches(classification, FIXED_COST_CLASSIFICATIONS)) {
    return "fixed";
  }

  // Check for variable essential classifications
  if (classificationMatches(classification, VARIABLE_ESSENTIAL_CLASSIFICATIONS)) {
    return "variable";
  }

  // Everything else is discretionary
  return "discretionary";
}

export interface BudgetEngineInput {
  transactions: TrueLayerTransaction[];
  direct_debits?: TrueLayerDirectDebit[];
  analysisMonths?: number; // Default to 1 for single-month snapshots
}

function extractCategory(classification: string[]): string | undefined {
  // Return the first classification as the primary category
  if (classification.length > 0) {
    return classification.join(" > ");
  }
  return undefined;
}

export function analyzeBudget(input: BudgetEngineInput): BudgetAnalysisResponse {
  const { transactions, direct_debits = [] } = input;

  // Define current month start for closed period calculation
  const now = new Date();
  const currentMonthStart = startOfMonth(now);
  
  // Define 6-month lookback cutoff (start of 6 months ago)
  const sixMonthsCutoff = new Date(currentMonthStart);
  sixMonthsCutoff.setMonth(sixMonthsCutoff.getMonth() - 6);

  // Split transactions into three categories:
  // - activeMonth: current partial month (for pacing only)
  // - closedHistory: past 6 months only (for averages)
  // - older transactions are excluded from average calculations
  const closedHistory: TrueLayerTransaction[] = [];
  const activeMonth: TrueLayerTransaction[] = [];

  for (const tx of transactions) {
    const txDate = tx.date ? new Date(tx.date) : new Date();
    if (!isBefore(txDate, currentMonthStart)) {
      // Current month - for pacing
      activeMonth.push(tx);
    } else if (!isBefore(txDate, sixMonthsCutoff)) {
      // Within last 6 months - for averages
      closedHistory.push(tx);
    }
    // Transactions older than 6 months are excluded from averages
  }
  
  // Debug logging to trace date distribution
  console.log(`[Budget Engine] Date range: currentMonthStart=${currentMonthStart.toISOString()}, sixMonthsCutoff=${sixMonthsCutoff.toISOString()}`);
  console.log(`[Budget Engine] Transaction distribution: ${activeMonth.length} in current month, ${closedHistory.length} in closed history, ${transactions.length - activeMonth.length - closedHistory.length} excluded (older than 6 months)`);

  // FIX: Count DISTINCT months with transactions instead of just using oldest date delta
  // This prevents the issue where 6-month totals are divided by 1 if date parsing is off
  const distinctMonthsInClosedHistory = new Set<string>();
  for (const tx of closedHistory) {
    const txDate = tx.date ? new Date(tx.date) : null;
    if (txDate && !isNaN(txDate.getTime())) {
      const monthKey = format(txDate, 'yyyy-MM'); // e.g., "2025-07"
      distinctMonthsInClosedHistory.add(monthKey);
    }
  }
  
  // Calculate closedMonthsAnalyzed from DISTINCT months with transactions (max 6)
  let closedMonthsAnalyzed = Math.min(distinctMonthsInClosedHistory.size, 6);
  
  // Fallback: if we have transactions but no distinct months (date parsing issue), use date delta
  if (closedHistory.length > 0 && closedMonthsAnalyzed === 0) {
    const oldestTransactionDate = closedHistory.reduce((oldest, tx) => {
      const txDate = tx.date ? new Date(tx.date) : new Date();
      return txDate < oldest ? txDate : oldest;
    }, new Date(closedHistory[0].date || new Date()));
    
    const monthsFound = differenceInCalendarMonths(currentMonthStart, oldestTransactionDate);
    closedMonthsAnalyzed = Math.max(1, Math.min(monthsFound, 6));
    console.log(`[Budget Engine] Date parsing fallback: used delta method, got ${closedMonthsAnalyzed} months`);
  }
  
  console.log(`[Budget Engine] Closed period analysis: ${closedHistory.length} transactions across ${distinctMonthsInClosedHistory.size} distinct months (using ${closedMonthsAnalyzed} for averaging)`);
  console.log(`[Budget Engine] Distinct months: ${Array.from(distinctMonthsInClosedHistory).sort().join(', ')}`);

  // Categorize CLOSED HISTORY transactions only for averages
  const incomeItems: BreakdownItem[] = [];
  const fixedCostsItems: BreakdownItem[] = [];
  const variableEssentialsItems: BreakdownItem[] = [];
  const discretionaryItems: BreakdownItem[] = [];

  let totalIncomeCents = 0;
  let totalFixedCents = 0;
  let totalVariableCents = 0;
  let totalDiscretionaryCents = 0;

  let excludedCount = 0;
  for (const tx of closedHistory) {
    const budgetCategory = categorizeTransaction(tx);
    const amountCents = Math.round(Math.abs(tx.amount) * 100);
    const amount = Math.abs(tx.amount);
    const category = extractCategory(tx.transaction_classification);
    const txRecord: BreakdownItem = { description: tx.description, amount, category };

    switch (budgetCategory) {
      case "income":
        incomeItems.push(txRecord);
        totalIncomeCents += amountCents;
        break;
      case "fixed":
        fixedCostsItems.push(txRecord);
        totalFixedCents += amountCents;
        break;
      case "variable":
        variableEssentialsItems.push(txRecord);
        totalVariableCents += amountCents;
        break;
      case "discretionary":
        if (tx.amount < 0) {
          discretionaryItems.push(txRecord);
          totalDiscretionaryCents += amountCents;
        }
        break;
      case "excluded":
        // Returned payments, refunds, transfers - skip entirely from budget calculations
        excludedCount++;
        break;
    }
  }
  
  console.log(`[Budget Engine] Excluded ${excludedCount} transactions (returns/refunds/transfers) from budget calculations`);

  // Calculate ACTIVE MONTH metrics for pacing
  let currentMonthSpendCents = 0;
  let currentMonthIncomeCents = 0;

  for (const tx of activeMonth) {
    const amountCents = Math.round(Math.abs(tx.amount) * 100);
    // Only count real income - exclude returns, refunds, and transfers
    if (tx.amount > 0 && !isInternalTransfer(tx) && !isReturnedOrRefund(tx)) {
      currentMonthIncomeCents += amountCents;
    } else if (tx.amount < 0) {
      currentMonthSpendCents += amountCents;
    }
  }

  // Calculate pacing projection
  const daysPassed = differenceInDays(now, currentMonthStart) + 1;
  const totalDaysInMonth = getDaysInMonth(now);
  const projectedMonthSpendCents = totalDaysInMonth > 0 && daysPassed > 0
    ? Math.round((currentMonthSpendCents / daysPassed) * totalDaysInMonth)
    : 0;
  const projectedMonthIncomeCents = totalDaysInMonth > 0 && daysPassed > 0
    ? Math.round((currentMonthIncomeCents / daysPassed) * totalDaysInMonth)
    : 0;

  // Add direct debits to fixed costs (they represent committed monthly payments)
  for (const dd of direct_debits) {
    if (dd.amount > 0) {
      const amountCents = Math.round(dd.amount * 100);
      const alreadyCounted = fixedCostsItems.some(
        (t) => t.description.toUpperCase().includes(dd.name.toUpperCase())
      );
      if (!alreadyCounted) {
        fixedCostsItems.push({ description: `${dd.name} (Direct Debit)`, amount: dd.amount, category: "Bills > Direct Debit" });
        totalFixedCents += amountCents;
      }
    }
  }

  // Calculate monthly averages from CLOSED HISTORY only
  // Use closedMonthsAnalyzed as divisor (or 1 to prevent division by zero)
  const divisor = closedMonthsAnalyzed > 0 ? closedMonthsAnalyzed : 1;
  
  // If no closed history, use active month projections as fallback estimates
  const hasClosedHistory = closedHistory.length > 0 && closedMonthsAnalyzed > 0;
  
  // FIX: Add logging to help debug monthly average calculation issues
  console.log(`[Budget Engine] Calculating averages: hasClosedHistory=${hasClosedHistory}, divisor=${divisor}`);
  console.log(`[Budget Engine] Totals from closed history: income=${totalIncomeCents}, fixed=${totalFixedCents}, variable=${totalVariableCents}, discretionary=${totalDiscretionaryCents}`);
  
  const averageMonthlyIncomeCents = hasClosedHistory 
    ? Math.round(totalIncomeCents / divisor)
    : projectedMonthIncomeCents;
  const fixedCostsCents = hasClosedHistory
    ? Math.round(totalFixedCents / divisor)
    : 0;
  const variableEssentialsCents = hasClosedHistory
    ? Math.round(totalVariableCents / divisor)
    : 0;
  const discretionaryCents = hasClosedHistory
    ? Math.round(totalDiscretionaryCents / divisor)
    : projectedMonthSpendCents;
    
  console.log(`[Budget Engine] Monthly averages: income=${averageMonthlyIncomeCents}, fixed=${fixedCostsCents}, variable=${variableEssentialsCents}, discretionary=${discretionaryCents}`);

  // Safe-to-Spend = Income - Fixed - Variable Essentials
  const safeToSpendCents = Math.max(
    0,
    averageMonthlyIncomeCents - fixedCostsCents - variableEssentialsCents
  );

  // Detect debt payments from ALL transactions (including current month)
  const detectedDebtPayments = detectDebtPayments(transactions);

  // Build current month pacing object
  const currentMonthPacing = {
    currentMonthSpendCents,
    currentMonthIncomeCents,
    projectedMonthSpendCents,
    projectedMonthIncomeCents,
    daysPassed,
    totalDaysInMonth,
    monthStartDate: currentMonthStart.toISOString(),
    monthEndDate: new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString(),
  };

  return {
    averageMonthlyIncomeCents,
    fixedCostsCents,
    variableEssentialsCents,
    discretionaryCents,
    safeToSpendCents,
    detectedDebtPayments,
    breakdown: {
      income: incomeItems,
      fixedCosts: fixedCostsItems,
      variableEssentials: variableEssentialsItems,
      discretionary: discretionaryItems,
    },
    analysisMonths: closedMonthsAnalyzed,
    closedMonthsAnalyzed,
    currentMonthPacing,
  };
}

export function analyzePersona(persona: TrueLayerPersona, analysisMonths: number = 1): BudgetAnalysisResponse {
  return analyzeBudget({
    transactions: persona.transactions,
    direct_debits: persona.direct_debits,
    analysisMonths,
  });
}

// Validation helper - runs all personas and returns results for testing
export function validateAllPersonas(
  personas: Record<string, TrueLayerPersona>
): Record<string, BudgetAnalysisResponse> {
  const results: Record<string, BudgetAnalysisResponse> = {};
  for (const [id, persona] of Object.entries(personas)) {
    results[id] = analyzePersona(persona);
  }
  return results;
}
