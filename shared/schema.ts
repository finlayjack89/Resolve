import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, date, jsonb, timestamp, boolean, unique, real } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// Enums matching the Python backend
export enum AccountType {
  CREDIT_CARD = "Credit Card",
  BNPL = "Buy Now, Pay Later",
  LOAN = "Loan"
}

// Processing status for TrueLayer connected accounts - staged onboarding flow
export enum ProcessingStatus {
  STAGED = "STAGED",           // Account connected but not yet analyzed
  ANALYZING = "ANALYZING",     // Currently fetching transactions and analyzing
  ACTIVE = "ACTIVE",           // Analysis complete, account ready for use
  ERROR = "ERROR"              // Error occurred during processing
}

// Bucket types for credit card balance segments
export enum BucketType {
  PURCHASES = "Purchases",
  BALANCE_TRANSFER = "Balance Transfer",
  MONEY_TRANSFER = "Money Transfer",
  CASH_ADVANCE = "Cash Advance",
  CUSTOM = "Custom"
}

export enum OptimizationStrategy {
  MINIMIZE_TOTAL_INTEREST = "Minimize Total Interest",
  MINIMIZE_MONTHLY_SPEND = "Minimize Monthly Spend",
  TARGET_MAX_BUDGET = "Pay Off ASAP with Max Budget",
  PAY_OFF_IN_PROMO = "Pay Off Within Promo Windows",
  MINIMIZE_SPEND_TO_CLEAR_PROMOS = "Minimize Spend to Clear Promos"
}

export enum PaymentShape {
  LINEAR_PER_ACCOUNT = "Linear (Same Amount Per Account)",
  OPTIMIZED_MONTH_TO_MONTH = "Optimized (Variable Amounts)"
}

export enum MembershipFeeFrequency {
  NONE = "none",
  MONTHLY = "monthly",
  ANNUAL = "annual"
}

// Recurring payment frequency detection
export enum RecurrenceFrequency {
  WEEKLY = "WEEKLY",           // ~7 days between payments
  FORTNIGHTLY = "FORTNIGHTLY", // ~14 days between payments
  MONTHLY = "MONTHLY",         // ~30 days between payments
  QUARTERLY = "QUARTERLY",     // ~90 days between payments
  ANNUAL = "ANNUAL"            // ~365 days between payments
}

// Current Finances - Per-account analysis summary (stored as JSONB)
export interface AccountAnalysisSummary {
  // Historical averages (from CLOSED months only - excludes current incomplete month)
  averageMonthlyIncomeCents: number;
  employmentIncomeCents: number;
  otherIncomeCents: number;
  sideHustleIncomeCents: number;
  fixedCostsCents: number; // Utilities, rent, direct debits
  essentialsCents: number; // Groceries, transport
  discretionaryCents: number; // Entertainment, subscriptions
  debtPaymentsCents: number;
  availableForDebtCents: number;
  breakdown: {
    income: Array<{ description: string; amountCents: number; category: string }>;
    fixedCosts: Array<{ description: string; amountCents: number; category: string }>;
    essentials: Array<{ description: string; amountCents: number; category: string }>;
    discretionary: Array<{ description: string; amountCents: number; category: string }>;
    debtPayments: Array<{ description: string; amountCents: number; category: string }>;
  };
  // Closed period analysis metadata
  closedMonthsAnalyzed: number; // Number of full months used for historical averages (capped at 6)
  analysisMonths: number; // Legacy field - kept for backwards compatibility
  lastUpdated: string;
  // Current month pacing metrics (from activeMonth transactions)
  currentMonthPacing: {
    currentMonthSpendCents: number; // Total outgoing spend this month so far
    currentMonthIncomeCents: number; // Total incoming income this month so far
    projectedMonthSpendCents: number; // Projected spend by end of month
    projectedMonthIncomeCents: number; // Projected income by end of month
    daysPassed: number; // Days elapsed in current month
    totalDaysInMonth: number; // Total days in current month
    monthStartDate: string; // First day of current month (ISO date)
    monthEndDate: string; // Last day of current month (ISO date)
  };
}

// Database Tables
export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  email: text("email").notNull().unique(),
  password: text("password").notNull(),
  firstName: text("first_name"),
  lastName: text("last_name"),
  country: text("country"),
  region: text("region"),
  currency: text("currency").default("USD"),
  currentBudgetCents: integer("current_budget_cents"), // Find My Budget: analyzed current budget
  potentialBudgetCents: integer("potential_budget_cents"), // Find My Budget: potential budget after savings
  createdAt: timestamp("created_at").defaultNow(),
});

export const accounts = pgTable("accounts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  lenderName: text("lender_name").notNull(),
  productName: text("product_name"),
  accountType: text("account_type").notNull(),
  currency: text("currency").default("USD"),
  currentBalanceCents: integer("current_balance_cents").notNull(),
  aprStandardBps: integer("apr_standard_bps").notNull(),
  paymentDueDay: integer("payment_due_day").notNull(),
  minPaymentRuleFixedCents: integer("min_payment_rule_fixed_cents").default(0),
  minPaymentRulePercentageBps: integer("min_payment_rule_percentage_bps").default(0),
  minPaymentRuleIncludesInterest: boolean("min_payment_rule_includes_interest").default(false),
  membershipFeeCents: integer("membership_fee_cents").default(0),
  membershipFeeFrequency: text("membership_fee_frequency").default("none"),
  isManualEntry: boolean("is_manual_entry").default(true),
  promoEndDate: date("promo_end_date"),
  promoDurationMonths: integer("promo_duration_months"),
  accountOpenDate: date("account_open_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const debtBuckets = pgTable("debt_buckets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  accountId: varchar("account_id").notNull().references(() => accounts.id, { onDelete: "cascade" }),
  bucketType: text("bucket_type").notNull(),
  label: text("label"),
  balanceCents: integer("balance_cents").notNull(),
  aprBps: integer("apr_bps").notNull(),
  isPromo: boolean("is_promo").default(false),
  promoExpiryDate: date("promo_expiry_date"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const budgets = pgTable("budgets", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  monthlyBudgetCents: integer("monthly_budget_cents").notNull(),
  futureChanges: jsonb("future_changes").$type<Array<[string, number]>>().default([]),
  lumpSumPayments: jsonb("lump_sum_payments").$type<Array<[string, number]>>().default([]),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const preferences = pgTable("preferences", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }).unique(),
  strategy: text("strategy").notNull(),
  paymentShape: text("payment_shape").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const plans = pgTable("plans", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  planStartDate: date("plan_start_date").notNull(),
  status: text("status").notNull(),
  message: text("message"),
  planData: jsonb("plan_data").$type<Array<MonthlyResult>>(),
  explanation: text("explanation"),
  confirmed: boolean("confirmed").default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const lenderRules = pgTable("lender_rules", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lenderName: text("lender_name").notNull(),
  country: text("country").notNull(),
  fixedCents: integer("fixed_cents").default(0),
  percentageBps: integer("percentage_bps").default(0),
  includesInterest: boolean("includes_interest").default(false),
  ruleDescription: text("rule_description"),
  verifiedAt: timestamp("verified_at").defaultNow(),
}, (table) => ({
  lenderCountryUnique: unique().on(table.lenderName, table.country),
}));

export const lenderProducts = pgTable("lender_products", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  lenderName: text("lender_name").notNull(),
  productName: text("product_name").notNull(),
  country: text("country").notNull().default("UK"),
  purchaseAprBps: integer("purchase_apr_bps"),
  balanceTransferAprBps: integer("balance_transfer_apr_bps"),
  cashAdvanceAprBps: integer("cash_advance_apr_bps"),
  minPaymentFixedCents: integer("min_payment_fixed_cents").default(0),
  minPaymentPercentageBps: integer("min_payment_percentage_bps").default(0),
  minPaymentIncludesInterest: boolean("min_payment_includes_interest").default(false),
  membershipFeeCents: integer("membership_fee_cents").default(0),
  membershipFeeFrequency: text("membership_fee_frequency").default("none"),
  ruleDescription: text("rule_description"),
  sourceUrl: text("source_url"),
  verifiedAt: timestamp("verified_at").defaultNow(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  lenderProductCountryUnique: unique().on(table.lenderName, table.productName, table.country),
}));

// TrueLayer Integration Tables - Supports multiple bank accounts per user
export const trueLayerItems = pgTable("truelayer_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trueLayerAccountId: text("truelayer_account_id").notNull(), // TrueLayer's account_id
  institutionName: text("institution_name").notNull(), // Bank name (e.g., "Barclays", "HSBC")
  institutionLogoUrl: text("institution_logo_url"), // Bank logo URL from TrueLayer
  accountName: text("account_name").notNull(), // Account display name (e.g., "Current Account")
  accountType: text("account_type"), // current, savings, credit_card, etc.
  connectionType: text("connection_type").default("current_account"), // 'current_account' or 'credit_card'
  currency: text("currency").default("GBP"),
  // Credit card specific fields
  cardNetwork: text("card_network"), // VISA, MASTERCARD, AMEX
  partialPan: text("partial_pan"), // Last 4 digits of card number
  cardType: text("card_type"), // CREDIT or CHARGE
  creditLimitCents: integer("credit_limit_cents"), // Total credit limit
  currentBalanceCents: integer("current_balance_cents"), // Current amount owed
  availableCreditCents: integer("available_credit_cents"), // Available credit
  accessTokenEncrypted: text("access_token_encrypted").notNull(),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  consentExpiresAt: timestamp("consent_expires_at"),
  provider: text("provider"), // TrueLayer provider ID
  lastSyncedAt: timestamp("last_synced_at"), // Last transaction fetch
  lastEnrichedAt: timestamp("last_enriched_at"), // Last Ntropy enrichment
  lastAnalyzedAt: timestamp("last_analyzed_at"), // Last full budget analysis
  nextRecalibrationDate: date("next_recalibration_date"), // Monthly recalibration schedule
  isSideHustle: boolean("is_side_hustle").default(false), // Flag for income categorization
  // Per-account analysis summary (cached results)
  analysisSummary: jsonb("analysis_summary").$type<AccountAnalysisSummary>(),
  connectionStatus: text("connection_status").default("active"), // 'active', 'expired', 'error', 'pending_enrichment'
  connectionError: text("connection_error"), // Store error message for transparency
  processingStatus: text("processing_status").default("STAGED"), // 'STAGED', 'ANALYZING', 'ACTIVE', 'ERROR' - staged onboarding flow
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userAccountUnique: unique().on(table.userId, table.trueLayerAccountId),
}));

// Subscription Catalog - Master list of known UK subscriptions with pricing
export const subscriptionCatalog = pgTable("subscription_catalog", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  merchantName: text("merchant_name").notNull(),
  productName: text("product_name").notNull(),
  amountCents: integer("amount_cents").notNull(),
  currency: text("currency").default("GBP"),
  recurrence: text("recurrence").default("Monthly"), // Monthly, Weekly, Yearly, Quarterly
  category: text("category"), // Entertainment, Utility, Health, Food, Transport, etc.
  confidenceScore: real("confidence_score").default(1.0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  merchantProductUnique: unique().on(table.merchantName, table.productName),
}));

// Nylas Grants - Email integration for receipt/subscription confirmation
export const nylasGrants = pgTable("nylas_grants", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  grantId: text("grant_id").notNull().unique(),
  emailAddress: text("email_address").notNull(),
  provider: text("provider"), // google, microsoft, etc.
  createdAt: timestamp("created_at").defaultNow(),
});

// Enriched Transactions Cache (Ntropy enrichment results) - Links to specific TrueLayer account
export const enrichedTransactions = pgTable("enriched_transactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trueLayerItemId: varchar("truelayer_item_id").references(() => trueLayerItems.id, { onDelete: "cascade" }), // Links to specific bank account
  trueLayerTransactionId: text("truelayer_transaction_id").notNull(),
  ntropyTransactionId: text("ntropy_transaction_id"),
  originalDescription: text("original_description").notNull(),
  merchantCleanName: text("merchant_clean_name"),
  merchantLogoUrl: text("merchant_logo_url"),
  merchantWebsiteUrl: text("merchant_website_url"),
  labels: jsonb("labels").$type<string[]>().default([]),
  isRecurring: boolean("is_recurring").default(false),
  recurrenceFrequency: text("recurrence_frequency"),
  recurrenceDay: integer("recurrence_day"),
  amountCents: integer("amount_cents").notNull(),
  entryType: text("entry_type").notNull(), // 'incoming' or 'outgoing'
  budgetCategory: text("budget_category"), // 'debt', 'fixed', 'discretionary'
  ukCategory: text("uk_category"), // UK-specific category mapping (employment, utilities, subscriptions, etc.)
  transactionDate: date("transaction_date").notNull(),
  currency: text("currency").default("GBP"),
  // Reconciliation fields for transfer/refund detection
  transactionType: text("transaction_type").default("regular"), // 'regular', 'transfer', 'refund', 'reversal'
  linkedTransactionId: varchar("linked_transaction_id"), // Links refund to original expense, or transfer to counterpart
  excludeFromAnalysis: boolean("exclude_from_analysis").default(false), // True for transfers/reversals that shouldn't count
  isInternalTransfer: boolean("is_internal_transfer").default(false), // True for detected internal transfers between connected accounts
  ecosystemPairId: varchar("ecosystem_pair_id"), // UUID linking both sides of an internal transfer
  // Agentic Enrichment fields
  isSubscription: boolean("is_subscription").default(false),
  subscriptionId: varchar("subscription_id").references(() => subscriptionCatalog.id),
  contextData: jsonb("context_data").$type<Record<string, any>>().default({}),
  reasoningTrace: jsonb("reasoning_trace").$type<string[]>().default([]),
  aiConfidence: real("ai_confidence").default(0.0),
  // Enrichment pipeline tracking
  enrichmentStage: text("enrichment_stage").default("pending"), // 'pending', 'ntropy_done', 'agentic_queued', 'agentic_done'
  enrichmentSource: text("enrichment_source"), // Which layer committed the category: 'math_brain', 'ntropy', 'context_hunter', 'sherlock'
  ntropyConfidence: real("ntropy_confidence"), // Ntropy's confidence score (nullable)
  agenticConfidence: real("agentic_confidence"), // Agentic enrichment confidence (nullable)
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userTransactionUnique: unique().on(table.userId, table.trueLayerTransactionId),
}));

// Recurring Patterns - Detected recurring payments from transaction history
export const recurringPatterns = pgTable("recurring_patterns", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  merchantName: text("merchant_name").notNull(), // Normalized merchant name
  frequency: text("frequency").notNull(), // WEEKLY, FORTNIGHTLY, MONTHLY, QUARTERLY, ANNUAL
  avgAmountCents: integer("avg_amount_cents").notNull(), // Average payment amount
  minAmountCents: integer("min_amount_cents"), // Minimum observed amount
  maxAmountCents: integer("max_amount_cents"), // Maximum observed amount
  anchorDay: integer("anchor_day").notNull(), // Day of month/week when payment typically occurs (1-31 for monthly, 1-7 for weekly)
  lastSeenDate: date("last_seen_date").notNull(), // Most recent occurrence
  nextDueDate: date("next_due_date"), // Predicted next payment date
  occurrenceCount: integer("occurrence_count").default(1), // Number of times this pattern was observed
  confidenceScore: real("confidence_score").default(0.0), // Pattern confidence (0-1)
  ukCategory: text("uk_category"), // Category classification (utilities, subscriptions, etc.)
  isActive: boolean("is_active").default(true), // Whether pattern is still active
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  userMerchantUnique: unique().on(table.userId, table.merchantName),
}));

// TypeScript Types
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export type Account = typeof accounts.$inferSelect;
export type InsertAccount = typeof accounts.$inferInsert;

export type DebtBucket = typeof debtBuckets.$inferSelect;
export type InsertDebtBucket = typeof debtBuckets.$inferInsert;

export type Budget = typeof budgets.$inferSelect;
export type InsertBudget = typeof budgets.$inferInsert;

export type Preference = typeof preferences.$inferSelect;
export type InsertPreference = typeof preferences.$inferInsert;

export type Plan = typeof plans.$inferSelect;
export type InsertPlan = typeof plans.$inferInsert;

export type LenderRule = typeof lenderRules.$inferSelect;
export type InsertLenderRule = typeof lenderRules.$inferInsert;

export type LenderProduct = typeof lenderProducts.$inferSelect;
export type InsertLenderProduct = typeof lenderProducts.$inferInsert;

export type TrueLayerItem = typeof trueLayerItems.$inferSelect;
export type InsertTrueLayerItem = typeof trueLayerItems.$inferInsert;

export type EnrichedTransaction = typeof enrichedTransactions.$inferSelect;
export type InsertEnrichedTransaction = typeof enrichedTransactions.$inferInsert;

export type SubscriptionCatalog = typeof subscriptionCatalog.$inferSelect;
export type InsertSubscriptionCatalog = typeof subscriptionCatalog.$inferInsert;

export type NylasGrant = typeof nylasGrants.$inferSelect;
export type InsertNylasGrant = typeof nylasGrants.$inferInsert;

export type RecurringPattern = typeof recurringPatterns.$inferSelect;
export type InsertRecurringPattern = typeof recurringPatterns.$inferInsert;

// Upcoming Bill projection (derived from recurring patterns)
export interface UpcomingBill {
  id: string;
  merchantName: string;
  amountCents: number;
  dueDate: string; // ISO date string
  status: 'PENDING' | 'PAID' | 'OVERDUE';
  frequency: RecurrenceFrequency;
  ukCategory?: string;
  confidenceScore: number;
}

// API Request/Response Types
export interface MinPaymentRule {
  fixedCents: number;
  percentageBps: number;
  includesInterest: boolean;
}

export interface MonthlyResult {
  month: number;
  lenderName: string;
  paymentCents: number;
  interestChargedCents: number;
  endingBalanceCents: number;
}

export interface BucketRequest {
  bucketType: BucketType;
  label?: string;
  balanceCents: number;
  aprBps: number;
  isPromo: boolean;
  promoExpiryDate?: string;
}

export interface AccountRequest {
  lenderName: string;
  productName?: string;
  accountType: AccountType;
  currency?: string;
  currentBalanceCents: number;
  aprStandardBps: number;
  paymentDueDay: number;
  minPaymentRule: MinPaymentRule;
  membershipFeeCents?: number;
  membershipFeeFrequency?: MembershipFeeFrequency;
  promoEndDate?: string;
  promoDurationMonths?: number;
  accountOpenDate?: string;
  notes?: string;
  buckets?: BucketRequest[];
}

export interface AccountWithBuckets extends Account {
  buckets: DebtBucket[];
}

export interface BudgetRequest {
  monthlyBudgetCents: number;
  futureChanges?: Array<[string, number]>;
  lumpSumPayments?: Array<[string, number]>;
}

export interface PreferenceRequest {
  strategy: OptimizationStrategy;
  paymentShape: PaymentShape;
}

export interface PlanRequest {
  accounts: AccountRequest[];
  budget: BudgetRequest;
  preferences: PreferenceRequest;
  planStartDate?: string;
}

export interface PlanScheduleEntry {
  month: number;
  startingBalanceCents: number;
  totalPaymentCents: number;
  payments: Record<string, number>;
}

export interface AccountSchedule {
  accountId: string;
  lenderName: string;
  payoffTimeMonths: number;
}

export interface PlanResponse {
  status: string;
  message?: string;
  plan?: MonthlyResult[];
  planStartDate?: string;
  payoffTimeMonths?: number;
  totalInterestPaidCents?: number;
  schedule?: PlanScheduleEntry[];
  accountSchedules?: AccountSchedule[];
}

export interface LenderRuleDiscoveryRequest {
  lenderName: string;
  country: string;
}

export interface AprInfo {
  purchaseAprBps: number;
  balanceTransferAprBps?: number;
  cashAdvanceAprBps?: number;
}

export interface LenderRuleDiscoveryResponse {
  lenderName: string;
  ruleDescription: string;
  minPaymentRule: MinPaymentRule;
  aprInfo?: AprInfo;
  confidence: "high" | "medium" | "low";
}

export interface TrueLayerAccount {
  account_id: string;
  account_type: string;
  display_name: string;
  currency: string;
  balance?: number;
}

// Zod Schemas for Validation
export const insertUserSchema = createInsertSchema(users, {
  email: z.string().email(),
  password: z.string().min(8),
}).pick({
  email: true,
  password: true,
  firstName: true,
  lastName: true,
  country: true,
  region: true,
  currency: true,
});

export const updateUserProfileSchema = z.object({
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  country: z.string().optional(),
  region: z.string().optional(),
  currency: z.string().optional(),
});

export const insertAccountSchema = createInsertSchema(accounts, {
  currentBalanceCents: z.number().int().min(0),
  aprStandardBps: z.number().int().min(0),
  paymentDueDay: z.number().int().min(1).max(28),
  minPaymentRuleFixedCents: z.number().int().min(0),
  minPaymentRulePercentageBps: z.number().int().min(0),
}).omit({
  id: true,
  userId: true,
  createdAt: true,
}).refine(
  (data) => {
    // CRITICAL FIX: Ensure at least one minimum payment component is non-zero
    // This prevents the solver from allowing $0 payments during promo periods
    return data.minPaymentRuleFixedCents > 0 || data.minPaymentRulePercentageBps > 0;
  },
  {
    message: "At least one minimum payment component must be greater than zero (either fixed amount or percentage)",
    path: ["minPaymentRuleFixedCents"], // This will be the field that shows the error
  }
);

export const insertBudgetSchema = createInsertSchema(budgets, {
  monthlyBudgetCents: z.number().int().min(0),
}).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
});

export const insertPreferenceSchema = createInsertSchema(preferences).omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true,
});

export const insertBucketSchema = createInsertSchema(debtBuckets, {
  balanceCents: z.number().int().min(0),
  aprBps: z.number().int().min(0),
}).omit({
  id: true,
  accountId: true,
  createdAt: true,
});

export const bucketRequestSchema = z.object({
  bucketType: z.nativeEnum(BucketType),
  label: z.string().nullable().optional(),
  balanceCents: z.number().int().min(0),
  aprBps: z.number().int().min(0),
  isPromo: z.boolean().default(false),
  promoExpiryDate: z.string().nullable().optional(),
});

export const accountWithBucketsRequestSchema = z.object({
  lenderName: z.string().min(1),
  accountType: z.nativeEnum(AccountType),
  currency: z.string().default("USD"),
  currentBalanceCents: z.number().int().min(0),
  aprStandardBps: z.number().int().min(0),
  paymentDueDay: z.number().int().min(1).max(28),
  minPaymentRuleFixedCents: z.number().int().min(0).default(0),
  minPaymentRulePercentageBps: z.number().int().min(0).default(0),
  minPaymentRuleIncludesInterest: z.boolean().default(false),
  membershipFeeCents: z.number().int().min(0).default(0),
  membershipFeeFrequency: z.nativeEnum(MembershipFeeFrequency).default(MembershipFeeFrequency.NONE),
  isManualEntry: z.boolean().default(true),
  promoEndDate: z.string().nullable().optional(),
  promoDurationMonths: z.number().int().nullable().optional(),
  accountOpenDate: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  buckets: z.array(bucketRequestSchema).optional(),
}).refine(
  (data) => {
    return data.minPaymentRuleFixedCents > 0 || data.minPaymentRulePercentageBps > 0;
  },
  {
    message: "At least one minimum payment component must be greater than zero",
    path: ["minPaymentRuleFixedCents"],
  }
);

// ============================================
// Find My Budget - TrueLayer Types & Schemas
// ============================================

// Transaction types from TrueLayer API
export type TrueLayerTransactionType = 
  | "CREDIT" 
  | "DEBIT" 
  | "STANDING_ORDER" 
  | "DIRECT_DEBIT" 
  | "FEE";

// TrueLayer transaction classification categories
export type TrueLayerClassification = string[];

export interface TrueLayerTransaction {
  description: string;
  amount: number; // Positive for credits, negative for debits
  transaction_classification: TrueLayerClassification;
  transaction_type: TrueLayerTransactionType;
  date?: string;
}

export interface TrueLayerDirectDebit {
  name: string;
  amount: number;
  status?: string;
  previous_payment_date?: string;
}

export interface TrueLayerStandingOrder {
  name: string;
  amount: number;
  frequency?: string;
}

export interface TrueLayerPersona {
  id: string;
  transactions: TrueLayerTransaction[];
  direct_debits: TrueLayerDirectDebit[];
  standing_orders?: TrueLayerStandingOrder[];
}

// Detected debt payment structure
export interface DetectedDebtPayment {
  description: string;
  amountCents: number;
  type: string;
}

// Breakdown item for budget analysis (amount in dollars, not cents)
export interface BreakdownItem {
  description: string;
  amount: number;
  category?: string;
}

// Legacy type - kept for backwards compatibility
export interface TransactionBreakdownItem {
  description: string;
  amountCents: number;
  category?: string;
}

// Current Month Pacing - for tracking spend/income in the active month
export interface CurrentMonthPacing {
  currentMonthSpendCents: number;
  currentMonthIncomeCents: number;
  projectedMonthSpendCents: number;
  projectedMonthIncomeCents: number;
  daysPassed: number;
  totalDaysInMonth: number;
  monthStartDate: string;
  monthEndDate: string;
}

// Budget Analysis Response - Output from Budget Engine
export interface BudgetAnalysisResponse {
  averageMonthlyIncomeCents: number;
  fixedCostsCents: number; // Rent, Bills, Direct Debits
  variableEssentialsCents: number; // Groceries, Transport
  discretionaryCents: number;
  safeToSpendCents: number; // Income - Fixed - Variable
  detectedDebtPayments: DetectedDebtPayment[]; // Lender payments found with details
  breakdown: {
    income: BreakdownItem[];
    fixedCosts: BreakdownItem[];
    variableEssentials: BreakdownItem[];
    discretionary: BreakdownItem[];
  };
  analysisMonths: number; // Legacy field for backwards compatibility
  closedMonthsAnalyzed?: number; // Number of complete past months used (0 = only active month data)
  currentMonthPacing?: CurrentMonthPacing; // Current month spend/income pacing metrics
}

// Zod schema for budget analysis request
export const budgetAnalyzeRequestSchema = z.object({
  personaId: z.string().optional(),
  transactions: z.array(z.object({
    description: z.string(),
    amount: z.number(),
    transaction_classification: z.array(z.string()),
    transaction_type: z.enum(["CREDIT", "DEBIT", "STANDING_ORDER", "DIRECT_DEBIT", "FEE"]),
    date: z.string().optional(),
  })).optional(),
  direct_debits: z.array(z.object({
    name: z.string(),
    amount: z.number(),
  })).optional(),
});
