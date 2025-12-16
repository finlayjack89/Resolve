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

// Current Finances - Per-account analysis summary (stored as JSONB)
export interface AccountAnalysisSummary {
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
  analysisMonths: number;
  lastUpdated: string;
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

// Subscription Catalog - Master list of known subscription products for intelligent detection
export const subscriptionCatalog = pgTable("subscription_catalog", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  merchantName: text("merchant_name").notNull(),
  productName: text("product_name").notNull(),
  amountCents: integer("amount_cents"), // Stored in cents for precision
  currency: text("currency").default("GBP"),
  recurrencePeriod: text("recurrence_period"), // "Monthly", "Annual", "Weekly"
  subscriptionType: text("subscription_type"), // "Subscription", "Utility", etc.
  category: text("category"), // "Entertainment", "Health", "Transport", etc.
  isVerified: boolean("is_verified").default(false), // TRUE if verified by human or high-confidence AI
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => ({
  merchantProductUnique: unique().on(table.merchantName, table.productName, table.amountCents),
}));

// Reasoning Trace Interface - Stores the "Why" for AI categorization
export interface ReasoningTrace {
  steps: Array<{
    step: string; // e.g., "Bank Data", "Subscription Check", "Category Mapping"
    detail: string; // e.g., "Matched Netflix £12.99 to Standard plan"
    confidence?: number;
  }>;
  finalCategory: string;
  finalConfidence: number;
  timestamp: string;
}

// Context Data Interface - Stores external enrichment data
export interface ContextData {
  eventName?: string; // "Taylor Swift Concert"
  routeStart?: string; // "Euston"
  routeEnd?: string; // "Wembley Stadium"
  itemsPurchased?: string[];
  receiptFound?: boolean;
  sourceType?: "email" | "calendar" | "macro_event";
}

// TrueLayer Integration Tables - Supports multiple bank accounts per user
export const trueLayerItems = pgTable("truelayer_items", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  trueLayerAccountId: text("truelayer_account_id").notNull(), // TrueLayer's account_id
  institutionName: text("institution_name").notNull(), // Bank name (e.g., "Barclays", "HSBC")
  institutionLogoUrl: text("institution_logo_url"), // Bank logo URL from TrueLayer
  accountName: text("account_name").notNull(), // Account display name (e.g., "Current Account")
  accountType: text("account_type"), // current, savings, etc.
  currency: text("currency").default("GBP"),
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
  connectionStatus: text("connection_status").default("active"), // 'active', 'expired', 'error'
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userAccountUnique: unique().on(table.userId, table.trueLayerAccountId),
}));

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
  masterCategory: text("master_category"), // PRD Master Taxonomy: bills_utilities, subscriptions, transport, etc.
  transactionDate: date("transaction_date").notNull(),
  currency: text("currency").default("GBP"),
  // Reconciliation fields for transfer/refund detection
  transactionType: text("transaction_type").default("regular"), // 'regular', 'transfer', 'refund', 'reversal'
  linkedTransactionId: varchar("linked_transaction_id"), // Links refund to original expense, or transfer to counterpart
  excludeFromAnalysis: boolean("exclude_from_analysis").default(false), // True for transfers/reversals that shouldn't count
  // Subscription Detection fields (PRD Module A)
  isSubscription: boolean("is_subscription").default(false), // TRUE if matched to subscription catalog
  subscriptionId: varchar("subscription_id").references(() => subscriptionCatalog.id), // Links to subscription_catalog
  // AI Reasoning fields (PRD - Reasoning Traces)
  reasoningTrace: jsonb("reasoning_trace").$type<ReasoningTrace>(), // Stores the "Why" for categorization
  contextData: jsonb("context_data").$type<ContextData>(), // Stores external enrichment (email, events)
  aiConfidenceScore: real("ai_confidence_score"), // 0.0 to 1.0 confidence in categorization
  // User Correction tracking
  userCorrectedCategory: text("user_corrected_category"), // If user overrode the AI category
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => ({
  userTransactionUnique: unique().on(table.userId, table.trueLayerTransactionId),
}));

// Email Connections - Stores Nylas OAuth grants/tokens for email access
export const emailConnections = pgTable("email_connections", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  provider: varchar("provider").notNull().default("nylas"), // e.g., "nylas"
  grantId: varchar("grant_id").notNull(), // Nylas grant ID
  email: varchar("email").notNull(),
  accessToken: text("access_token").notNull(), // Encrypted
  refreshToken: text("refresh_token"), // Optional, encrypted
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

// Email Receipts - Stores parsed receipt emails for transaction matching
export const emailReceipts = pgTable("email_receipts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  connectionId: varchar("connection_id").notNull().references(() => emailConnections.id, { onDelete: "cascade" }),
  nylasMessageId: varchar("nylas_message_id").notNull().unique(),
  senderEmail: varchar("sender_email"),
  subject: varchar("subject"),
  receivedAt: timestamp("received_at"),
  merchantName: varchar("merchant_name"), // Extracted from receipt
  amountCents: integer("amount_cents"), // Extracted from receipt
  currency: varchar("currency"), // Extracted from receipt
  rawBody: text("raw_body"),
  parsedData: jsonb("parsed_data").$type<Record<string, any>>(), // Full extraction
  matchedTransactionId: varchar("matched_transaction_id"), // Links to enriched_transactions
  createdAt: timestamp("created_at").defaultNow(),
});

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

export type SubscriptionCatalog = typeof subscriptionCatalog.$inferSelect;
export type InsertSubscriptionCatalog = typeof subscriptionCatalog.$inferInsert;

export type TrueLayerItem = typeof trueLayerItems.$inferSelect;
export type InsertTrueLayerItem = typeof trueLayerItems.$inferInsert;

export type EnrichedTransaction = typeof enrichedTransactions.$inferSelect;
export type InsertEnrichedTransaction = typeof enrichedTransactions.$inferInsert;

export type EmailConnection = typeof emailConnections.$inferSelect;
export type InsertEmailConnection = typeof emailConnections.$inferInsert;

export type EmailReceipt = typeof emailReceipts.$inferSelect;
export type InsertEmailReceipt = typeof emailReceipts.$inferInsert;

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
  analysisMonths: number;
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
