import { 
  users, accounts, budgets, preferences, plans, lenderRules, trueLayerItems, debtBuckets, enrichedTransactions,
  subscriptionCatalog, nylasGrants, recurringPatterns,
  type User, type InsertUser, 
  type Account, type InsertAccount,
  type Budget, type InsertBudget,
  type Preference, type InsertPreference,
  type Plan, type InsertPlan,
  type LenderRule, type InsertLenderRule,
  type TrueLayerItem, type InsertTrueLayerItem,
  type DebtBucket, type InsertDebtBucket,
  type AccountWithBuckets,
  type EnrichedTransaction, type InsertEnrichedTransaction,
  type SubscriptionCatalog, type InsertSubscriptionCatalog,
  type NylasGrant, type InsertNylasGrant,
  type RecurringPattern, type InsertRecurringPattern
} from "@shared/schema";
import { db } from "./db";
import { eq, and, desc, gte, ilike } from "drizzle-orm";

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByEmail(email: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: string, updates: Partial<User>): Promise<User | undefined>;

  // Account methods
  getAccountsByUserId(userId: string): Promise<Account[]>;
  getAccountsWithBucketsByUserId(userId: string): Promise<AccountWithBuckets[]>;
  getAccount(id: string): Promise<Account | undefined>;
  getAccountWithBuckets(id: string): Promise<AccountWithBuckets | undefined>;
  createAccount(account: InsertAccount): Promise<Account>;
  createAccountWithBuckets(account: InsertAccount, buckets: Omit<InsertDebtBucket, 'accountId'>[]): Promise<AccountWithBuckets>;
  updateAccount(id: string, updates: Partial<Account>): Promise<Account | undefined>;
  updateAccountWithBuckets(id: string, updates: Partial<Account>, buckets?: InsertDebtBucket[]): Promise<AccountWithBuckets | undefined>;
  deleteAccount(id: string): Promise<void>;

  // Bucket methods
  getBucketsByAccountId(accountId: string): Promise<DebtBucket[]>;
  createBucket(bucket: InsertDebtBucket): Promise<DebtBucket>;
  updateBucket(id: string, updates: Partial<DebtBucket>): Promise<DebtBucket | undefined>;
  deleteBucket(id: string): Promise<void>;
  deleteAllBucketsByAccountId(accountId: string): Promise<void>;

  // Budget methods
  getBudgetByUserId(userId: string): Promise<Budget | undefined>;
  createOrUpdateBudget(budget: InsertBudget): Promise<Budget>;

  // Preferences methods
  getPreferencesByUserId(userId: string): Promise<Preference | undefined>;
  createOrUpdatePreferences(prefs: InsertPreference): Promise<Preference>;

  // Plan methods
  getPlansByUserId(userId: string): Promise<Plan[]>;
  getLatestPlan(userId: string): Promise<Plan | undefined>;
  createPlan(plan: InsertPlan): Promise<Plan>;
  deletePlan(id: string): Promise<void>;
  confirmPlan(id: string): Promise<Plan | undefined>;
  deleteUnconfirmedPlans(userId: string): Promise<void>;

  // Lender Rules methods
  getLenderRule(lenderName: string, country: string): Promise<LenderRule | undefined>;
  createLenderRule(rule: InsertLenderRule): Promise<LenderRule>;
  
  // TrueLayer Item methods (multi-account support)
  getTrueLayerItemByUserId(userId: string): Promise<TrueLayerItem | undefined>; // Legacy: returns first item
  getTrueLayerItemsByUserId(userId: string): Promise<TrueLayerItem[]>; // NEW: returns all accounts
  getAllTrueLayerItems(): Promise<TrueLayerItem[]>; // Background sync: get all items across all users
  getTrueLayerItemById(id: string): Promise<TrueLayerItem | undefined>; // NEW: get specific account
  getTrueLayerItemByAccountId(userId: string, trueLayerAccountId: string): Promise<TrueLayerItem | undefined>; // NEW: find by TL account ID
  createTrueLayerItem(item: InsertTrueLayerItem): Promise<TrueLayerItem>;
  updateTrueLayerItem(id: string, updates: Partial<TrueLayerItem>): Promise<TrueLayerItem | undefined>;
  deleteTrueLayerItem(userId: string): Promise<void>; // Legacy: deletes all
  deleteTrueLayerItemById(id: string): Promise<void>; // NEW: delete specific account
  
  // Enriched Transactions methods (multi-account support)
  getEnrichedTransactionById(id: string): Promise<EnrichedTransaction | null>; // Get single transaction by ID
  getEnrichedTransactionsByUserId(userId: string): Promise<EnrichedTransaction[]>;
  getEnrichedTransactionsByItemId(trueLayerItemId: string): Promise<EnrichedTransaction[]>; // NEW: per-account
  getEnrichedTransactionsByItemIdExcludePending(trueLayerItemId: string): Promise<EnrichedTransaction[]>; // UI-safe: excludes pending
  getPendingTransactionsByItemId(trueLayerItemId: string): Promise<EnrichedTransaction[]>; // Background sync: only pending
  getEnrichedTransactionsCount(userId: string): Promise<number>;
  getEnrichedTransactionsCountByItemId(trueLayerItemId: string): Promise<number>; // NEW: per-account
  hasRecentEnrichedTransactions(userId: string, maxAgeHours?: number): Promise<boolean>;
  hasRecentEnrichedTransactionsByItemId(trueLayerItemId: string, maxAgeHours?: number): Promise<boolean>; // NEW: per-account
  saveEnrichedTransactions(transactions: InsertEnrichedTransaction[]): Promise<void>;
  deleteEnrichedTransactionsByUserId(userId: string): Promise<void>;
  deleteEnrichedTransactionsByItemId(trueLayerItemId: string): Promise<void>; // NEW: per-account
  cleanupOrphanedEnrichedTransactions(userId: string): Promise<number>; // NEW: cleanup orphans
  updateEnrichedTransactionReconciliation(id: string, updates: { transactionType?: string; linkedTransactionId?: string | null; excludeFromAnalysis?: boolean; isInternalTransfer?: boolean; ecosystemPairId?: string | null }): Promise<void>; // Reconciliation updates
  updateEnrichedTransactionEnrichment(trueLayerTransactionId: string, updates: { enrichmentStage?: string; agenticConfidence?: number | null; enrichmentSource?: string; isSubscription?: boolean; contextData?: Record<string, any>; reasoningTrace?: string[] }): Promise<void>; // Agentic enrichment updates
  updateEnrichedTransaction(id: string, updates: Partial<EnrichedTransaction>): Promise<void>; // General enriched transaction updates for re-enrichment
  
  // Subscription Catalog methods
  getSubscriptionCatalog(): Promise<SubscriptionCatalog[]>;
  getSubscriptionCatalogById(id: string): Promise<SubscriptionCatalog | undefined>;
  searchSubscriptionCatalog(merchantName: string): Promise<SubscriptionCatalog[]>;
  createSubscriptionCatalogEntry(entry: InsertSubscriptionCatalog): Promise<SubscriptionCatalog>;
  upsertSubscriptionCatalogEntry(entry: InsertSubscriptionCatalog): Promise<SubscriptionCatalog>;
  
  // Nylas Grants methods
  getNylasGrantsByUserId(userId: string): Promise<NylasGrant[]>;
  getNylasGrantById(id: string): Promise<NylasGrant | undefined>;
  getNylasGrantByGrantId(grantId: string): Promise<NylasGrant | undefined>;
  createNylasGrant(grant: InsertNylasGrant): Promise<NylasGrant>;
  deleteNylasGrant(id: string): Promise<void>;
  deleteNylasGrantsByUserId(userId: string): Promise<void>;

  // Recurring Patterns methods
  getRecurringPatternsByUserId(userId: string): Promise<RecurringPattern[]>;
  getRecurringPatternById(id: string): Promise<RecurringPattern | undefined>;
  getActiveRecurringPatternsByUserId(userId: string): Promise<RecurringPattern[]>;
  createRecurringPattern(pattern: InsertRecurringPattern): Promise<RecurringPattern>;
  upsertRecurringPatterns(patterns: InsertRecurringPattern[]): Promise<RecurringPattern[]>;
  updateRecurringPattern(id: string, updates: Partial<RecurringPattern>): Promise<RecurringPattern | undefined>;
  deleteRecurringPattern(id: string): Promise<void>;
  deleteRecurringPatternsByUserId(userId: string): Promise<void>;
}

type BucketInput = Omit<InsertDebtBucket, 'accountId'>;

export class DatabaseStorage implements IStorage {
  // User methods
  async getUser(id: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.email, email));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    const [user] = await db.update(users).set(updates).where(eq(users.id, id)).returning();
    return user || undefined;
  }

  // Account methods
  async getAccountsByUserId(userId: string): Promise<Account[]> {
    return await db.select().from(accounts).where(eq(accounts.userId, userId));
  }

  async getAccount(id: string): Promise<Account | undefined> {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
    return account || undefined;
  }

  async createAccount(account: InsertAccount): Promise<Account> {
    const [newAccount] = await db.insert(accounts).values(account).returning();
    return newAccount;
  }

  async updateAccount(id: string, updates: Partial<Account>): Promise<Account | undefined> {
    const [account] = await db.update(accounts).set(updates).where(eq(accounts.id, id)).returning();
    return account || undefined;
  }

  async deleteAccount(id: string): Promise<void> {
    await db.delete(accounts).where(eq(accounts.id, id));
  }

  async getAccountsWithBucketsByUserId(userId: string): Promise<AccountWithBuckets[]> {
    const accountList = await db.select().from(accounts).where(eq(accounts.userId, userId));
    const result: AccountWithBuckets[] = [];
    for (const account of accountList) {
      const buckets = await db.select().from(debtBuckets).where(eq(debtBuckets.accountId, account.id));
      result.push({ ...account, buckets });
    }
    return result;
  }

  async getAccountWithBuckets(id: string): Promise<AccountWithBuckets | undefined> {
    const [account] = await db.select().from(accounts).where(eq(accounts.id, id));
    if (!account) return undefined;
    const buckets = await db.select().from(debtBuckets).where(eq(debtBuckets.accountId, id));
    return { ...account, buckets };
  }

  async createAccountWithBuckets(account: InsertAccount, buckets: BucketInput[]): Promise<AccountWithBuckets> {
    const [newAccount] = await db.insert(accounts).values(account).returning();
    const createdBuckets: DebtBucket[] = [];
    for (const bucket of buckets) {
      const [newBucket] = await db.insert(debtBuckets).values({ ...bucket, accountId: newAccount.id }).returning();
      createdBuckets.push(newBucket);
    }
    return { ...newAccount, buckets: createdBuckets };
  }

  async updateAccountWithBuckets(id: string, updates: Partial<Account>, buckets?: InsertDebtBucket[]): Promise<AccountWithBuckets | undefined> {
    const [updatedAccount] = await db.update(accounts).set(updates).where(eq(accounts.id, id)).returning();
    if (!updatedAccount) return undefined;
    
    if (buckets !== undefined) {
      await db.delete(debtBuckets).where(eq(debtBuckets.accountId, id));
      const createdBuckets: DebtBucket[] = [];
      for (const bucket of buckets) {
        const [newBucket] = await db.insert(debtBuckets).values({ ...bucket, accountId: id }).returning();
        createdBuckets.push(newBucket);
      }
      return { ...updatedAccount, buckets: createdBuckets };
    }
    
    const existingBuckets = await db.select().from(debtBuckets).where(eq(debtBuckets.accountId, id));
    return { ...updatedAccount, buckets: existingBuckets };
  }

  // Bucket methods
  async getBucketsByAccountId(accountId: string): Promise<DebtBucket[]> {
    return await db.select().from(debtBuckets).where(eq(debtBuckets.accountId, accountId));
  }

  async createBucket(bucket: InsertDebtBucket): Promise<DebtBucket> {
    const [newBucket] = await db.insert(debtBuckets).values(bucket).returning();
    return newBucket;
  }

  async updateBucket(id: string, updates: Partial<DebtBucket>): Promise<DebtBucket | undefined> {
    const [bucket] = await db.update(debtBuckets).set(updates).where(eq(debtBuckets.id, id)).returning();
    return bucket || undefined;
  }

  async deleteBucket(id: string): Promise<void> {
    await db.delete(debtBuckets).where(eq(debtBuckets.id, id));
  }

  async deleteAllBucketsByAccountId(accountId: string): Promise<void> {
    await db.delete(debtBuckets).where(eq(debtBuckets.accountId, accountId));
  }

  // Budget methods
  async getBudgetByUserId(userId: string): Promise<Budget | undefined> {
    const [budget] = await db.select().from(budgets).where(eq(budgets.userId, userId));
    return budget || undefined;
  }

  async createOrUpdateBudget(budget: InsertBudget): Promise<Budget> {
    const existing = await this.getBudgetByUserId(budget.userId);
    if (existing) {
      const [updated] = await db.update(budgets).set(budget).where(eq(budgets.userId, budget.userId)).returning();
      return updated;
    } else {
      const [newBudget] = await db.insert(budgets).values(budget).returning();
      return newBudget;
    }
  }

  // Preferences methods
  async getPreferencesByUserId(userId: string): Promise<Preference | undefined> {
    const [prefs] = await db.select().from(preferences).where(eq(preferences.userId, userId));
    return prefs || undefined;
  }

  async createOrUpdatePreferences(prefs: InsertPreference): Promise<Preference> {
    const existing = await this.getPreferencesByUserId(prefs.userId);
    if (existing) {
      const [updated] = await db.update(preferences).set(prefs).where(eq(preferences.userId, prefs.userId)).returning();
      return updated;
    } else {
      const [newPrefs] = await db.insert(preferences).values(prefs).returning();
      return newPrefs;
    }
  }

  // Plan methods
  async getPlansByUserId(userId: string): Promise<Plan[]> {
    return await db.select().from(plans).where(eq(plans.userId, userId)).orderBy(desc(plans.createdAt));
  }

  async getLatestPlan(userId: string): Promise<Plan | undefined> {
    const [plan] = await db.select().from(plans).where(eq(plans.userId, userId)).orderBy(desc(plans.createdAt)).limit(1);
    return plan || undefined;
  }

  async createPlan(plan: InsertPlan): Promise<Plan> {
    const [newPlan] = await db.insert(plans).values(plan).returning();
    return newPlan;
  }

  async deletePlan(id: string): Promise<void> {
    await db.delete(plans).where(eq(plans.id, id));
  }

  async confirmPlan(id: string): Promise<Plan | undefined> {
    const [plan] = await db.update(plans).set({ confirmed: true }).where(eq(plans.id, id)).returning();
    return plan || undefined;
  }

  async deleteUnconfirmedPlans(userId: string): Promise<void> {
    await db.delete(plans).where(and(eq(plans.userId, userId), eq(plans.confirmed, false)));
  }

  // Lender Rules methods
  async getLenderRule(lenderName: string, country: string): Promise<LenderRule | undefined> {
    const [rule] = await db.select().from(lenderRules).where(
      and(eq(lenderRules.lenderName, lenderName), eq(lenderRules.country, country))
    );
    return rule || undefined;
  }

  async createLenderRule(rule: InsertLenderRule): Promise<LenderRule> {
    const [newRule] = await db.insert(lenderRules).values(rule).returning();
    return newRule;
  }
  
  // TrueLayer Item methods (multi-account support)
  async getTrueLayerItemByUserId(userId: string): Promise<TrueLayerItem | undefined> {
    // Legacy: returns first item for backwards compatibility
    const [item] = await db.select().from(trueLayerItems).where(eq(trueLayerItems.userId, userId));
    return item || undefined;
  }
  
  async getTrueLayerItemsByUserId(userId: string): Promise<TrueLayerItem[]> {
    return await db.select().from(trueLayerItems).where(eq(trueLayerItems.userId, userId));
  }
  
  async getAllTrueLayerItems(): Promise<TrueLayerItem[]> {
    return await db.select().from(trueLayerItems);
  }
  
  async getTrueLayerItemById(id: string): Promise<TrueLayerItem | undefined> {
    const [item] = await db.select().from(trueLayerItems).where(eq(trueLayerItems.id, id));
    return item || undefined;
  }
  
  async getTrueLayerItemByAccountId(userId: string, trueLayerAccountId: string): Promise<TrueLayerItem | undefined> {
    const [item] = await db.select().from(trueLayerItems).where(
      and(eq(trueLayerItems.userId, userId), eq(trueLayerItems.trueLayerAccountId, trueLayerAccountId))
    );
    return item || undefined;
  }
  
  async createTrueLayerItem(item: InsertTrueLayerItem): Promise<TrueLayerItem> {
    const [newItem] = await db.insert(trueLayerItems).values(item).returning();
    return newItem;
  }
  
  async updateTrueLayerItem(id: string, updates: Partial<TrueLayerItem>): Promise<TrueLayerItem | undefined> {
    const [item] = await db.update(trueLayerItems).set(updates).where(eq(trueLayerItems.id, id)).returning();
    return item || undefined;
  }

  async deleteTrueLayerItem(userId: string): Promise<void> {
    // Legacy: deletes all items for user
    // First delete all enriched transactions for this user to prevent orphans
    await this.deleteEnrichedTransactionsByUserId(userId);
    // Then delete all TrueLayer items
    await db.delete(trueLayerItems).where(eq(trueLayerItems.userId, userId));
  }
  
  async deleteTrueLayerItemById(id: string): Promise<void> {
    // First delete enriched transactions for this specific account to prevent orphans
    await this.deleteEnrichedTransactionsByItemId(id);
    // Then delete the TrueLayer item
    await db.delete(trueLayerItems).where(eq(trueLayerItems.id, id));
  }
  
  // Enriched Transactions methods (multi-account support)
  async getEnrichedTransactionById(id: string): Promise<EnrichedTransaction | null> {
    const [transaction] = await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.id, id));
    return transaction || null;
  }
  
  async getEnrichedTransactionsByUserId(userId: string): Promise<EnrichedTransaction[]> {
    return await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.userId, userId));
  }
  
  async getEnrichedTransactionsByItemId(trueLayerItemId: string): Promise<EnrichedTransaction[]> {
    return await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.trueLayerItemId, trueLayerItemId));
  }
  
  async getEnrichedTransactionsByItemIdExcludePending(trueLayerItemId: string): Promise<EnrichedTransaction[]> {
    // Returns only fully enriched transactions for UI display
    // Excludes transactions that are still pending enrichment
    const all = await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.trueLayerItemId, trueLayerItemId));
    return all.filter(tx => tx.enrichmentStage !== "pending" && tx.enrichmentStage !== "pending_enrichment");
  }
  
  async getPendingTransactionsByItemId(trueLayerItemId: string): Promise<EnrichedTransaction[]> {
    // Returns only pending transactions for background sync enrichment
    const all = await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.trueLayerItemId, trueLayerItemId));
    return all.filter(tx => tx.enrichmentStage === "pending" || tx.enrichmentStage === "pending_enrichment");
  }
  
  async getEnrichedTransactionsCount(userId: string): Promise<number> {
    const transactions = await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.userId, userId));
    return transactions.length;
  }
  
  async getEnrichedTransactionsCountByItemId(trueLayerItemId: string): Promise<number> {
    const transactions = await db.select().from(enrichedTransactions).where(eq(enrichedTransactions.trueLayerItemId, trueLayerItemId));
    return transactions.length;
  }
  
  async hasRecentEnrichedTransactions(userId: string, maxAgeHours: number = 24): Promise<boolean> {
    const cutoffDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const [transaction] = await db.select()
      .from(enrichedTransactions)
      .where(
        and(
          eq(enrichedTransactions.userId, userId),
          gte(enrichedTransactions.createdAt, cutoffDate)
        )
      )
      .limit(1);
    return !!transaction;
  }
  
  async hasRecentEnrichedTransactionsByItemId(trueLayerItemId: string, maxAgeHours: number = 24): Promise<boolean> {
    const cutoffDate = new Date(Date.now() - maxAgeHours * 60 * 60 * 1000);
    const [transaction] = await db.select()
      .from(enrichedTransactions)
      .where(
        and(
          eq(enrichedTransactions.trueLayerItemId, trueLayerItemId),
          gte(enrichedTransactions.createdAt, cutoffDate)
        )
      )
      .limit(1);
    return !!transaction;
  }
  
  async saveEnrichedTransactions(transactions: InsertEnrichedTransaction[]): Promise<void> {
    if (transactions.length === 0) return;
    
    // Use onConflictDoUpdate to upsert transactions
    // Include ALL enrichment fields so updates from enrichment pipeline are persisted
    for (const tx of transactions) {
      await db.insert(enrichedTransactions)
        .values(tx)
        .onConflictDoUpdate({
          target: [enrichedTransactions.userId, enrichedTransactions.trueLayerTransactionId],
          set: {
            trueLayerItemId: tx.trueLayerItemId,
            ntropyTransactionId: tx.ntropyTransactionId,
            merchantCleanName: tx.merchantCleanName,
            merchantLogoUrl: tx.merchantLogoUrl,
            merchantWebsiteUrl: tx.merchantWebsiteUrl,
            labels: tx.labels,
            isRecurring: tx.isRecurring,
            recurrenceFrequency: tx.recurrenceFrequency,
            recurrenceDay: tx.recurrenceDay,
            budgetCategory: tx.budgetCategory,
            ukCategory: tx.ukCategory,
            // Enrichment pipeline fields - CRITICAL for updating raw -> enriched
            enrichmentStage: tx.enrichmentStage,
            enrichmentSource: tx.enrichmentSource,
            ntropyConfidence: tx.ntropyConfidence,
            agenticConfidence: tx.agenticConfidence,
            reasoningTrace: tx.reasoningTrace,
            contextData: tx.contextData,
            isSubscription: tx.isSubscription,
            subscriptionId: tx.subscriptionId,
            // Reconciliation fields
            transactionType: tx.transactionType,
            linkedTransactionId: tx.linkedTransactionId,
            excludeFromAnalysis: tx.excludeFromAnalysis,
            createdAt: new Date(),
          },
        });
    }
  }
  
  async deleteEnrichedTransactionsByUserId(userId: string): Promise<void> {
    await db.delete(enrichedTransactions).where(eq(enrichedTransactions.userId, userId));
  }
  
  async deleteEnrichedTransactionsByItemId(trueLayerItemId: string): Promise<void> {
    await db.delete(enrichedTransactions).where(eq(enrichedTransactions.trueLayerItemId, trueLayerItemId));
  }
  
  async cleanupOrphanedEnrichedTransactions(userId: string): Promise<number> {
    // Find all valid TrueLayer item IDs for this user
    const validItems = await this.getTrueLayerItemsByUserId(userId);
    const validItemIds = new Set(validItems.map(item => item.id));
    
    // Get all enriched transactions for this user
    const allTransactions = await this.getEnrichedTransactionsByUserId(userId);
    
    // Find orphaned transactions (no trueLayerItemId or invalid trueLayerItemId)
    const orphanedIds: string[] = [];
    for (const tx of allTransactions) {
      if (!tx.trueLayerItemId || !validItemIds.has(tx.trueLayerItemId)) {
        orphanedIds.push(tx.id);
      }
    }
    
    // Delete orphaned transactions
    if (orphanedIds.length > 0) {
      for (const id of orphanedIds) {
        await db.delete(enrichedTransactions).where(eq(enrichedTransactions.id, id));
      }
      console.log(`[Storage] Cleaned up ${orphanedIds.length} orphaned enriched transactions for user ${userId.substring(0, 8)}...`);
    }
    
    return orphanedIds.length;
  }
  
  async updateEnrichedTransactionReconciliation(id: string, updates: { transactionType?: string; linkedTransactionId?: string | null; excludeFromAnalysis?: boolean; isInternalTransfer?: boolean; ecosystemPairId?: string | null }): Promise<void> {
    const updateObj: any = {};
    if (updates.transactionType !== undefined) {
      updateObj.transactionType = updates.transactionType;
    }
    if (updates.linkedTransactionId !== undefined) {
      updateObj.linkedTransactionId = updates.linkedTransactionId;
    }
    if (updates.excludeFromAnalysis !== undefined) {
      updateObj.excludeFromAnalysis = updates.excludeFromAnalysis;
    }
    if (updates.isInternalTransfer !== undefined) {
      updateObj.isInternalTransfer = updates.isInternalTransfer;
    }
    if (updates.ecosystemPairId !== undefined) {
      updateObj.ecosystemPairId = updates.ecosystemPairId;
    }
    if (Object.keys(updateObj).length > 0) {
      await db.update(enrichedTransactions).set(updateObj).where(eq(enrichedTransactions.id, id));
    }
  }
  
  async updateEnrichedTransactionEnrichment(trueLayerTransactionId: string, updates: { enrichmentStage?: string; agenticConfidence?: number | null; enrichmentSource?: string; isSubscription?: boolean; contextData?: Record<string, any>; reasoningTrace?: string[] }): Promise<void> {
    const updateObj: any = {};
    if (updates.enrichmentStage !== undefined) {
      updateObj.enrichmentStage = updates.enrichmentStage;
    }
    if (updates.agenticConfidence !== undefined) {
      updateObj.agenticConfidence = updates.agenticConfidence;
    }
    if (updates.enrichmentSource !== undefined) {
      updateObj.enrichmentSource = updates.enrichmentSource;
    }
    if (updates.isSubscription !== undefined) {
      updateObj.isSubscription = updates.isSubscription;
    }
    if (updates.contextData !== undefined) {
      updateObj.contextData = updates.contextData;
    }
    if (updates.reasoningTrace !== undefined) {
      updateObj.reasoningTrace = updates.reasoningTrace;
    }
    if (Object.keys(updateObj).length > 0) {
      await db.update(enrichedTransactions).set(updateObj).where(eq(enrichedTransactions.trueLayerTransactionId, trueLayerTransactionId));
    }
  }
  
  async updateEnrichedTransaction(id: string, updates: Partial<EnrichedTransaction>): Promise<void> {
    const updateObj: any = {};
    if (updates.merchantCleanName !== undefined) updateObj.merchantCleanName = updates.merchantCleanName;
    if (updates.merchantLogoUrl !== undefined) updateObj.merchantLogoUrl = updates.merchantLogoUrl;
    if (updates.merchantWebsiteUrl !== undefined) updateObj.merchantWebsiteUrl = updates.merchantWebsiteUrl;
    if (updates.labels !== undefined) updateObj.labels = updates.labels;
    if (updates.isRecurring !== undefined) updateObj.isRecurring = updates.isRecurring;
    if (updates.recurrenceFrequency !== undefined) updateObj.recurrenceFrequency = updates.recurrenceFrequency;
    if (updates.budgetCategory !== undefined) updateObj.budgetCategory = updates.budgetCategory;
    if (updates.ukCategory !== undefined) updateObj.ukCategory = updates.ukCategory;
    if (updates.enrichmentSource !== undefined) updateObj.enrichmentSource = updates.enrichmentSource;
    if (updates.ntropyConfidence !== undefined) updateObj.ntropyConfidence = updates.ntropyConfidence;
    if (updates.reasoningTrace !== undefined) updateObj.reasoningTrace = updates.reasoningTrace;
    if (updates.excludeFromAnalysis !== undefined) updateObj.excludeFromAnalysis = updates.excludeFromAnalysis;
    if (updates.transactionType !== undefined) updateObj.transactionType = updates.transactionType;
    if (updates.linkedTransactionId !== undefined) updateObj.linkedTransactionId = updates.linkedTransactionId;
    if (updates.isInternalTransfer !== undefined) updateObj.isInternalTransfer = updates.isInternalTransfer;
    if (updates.ecosystemPairId !== undefined) updateObj.ecosystemPairId = updates.ecosystemPairId;
    if (updates.enrichmentStage !== undefined) updateObj.enrichmentStage = updates.enrichmentStage;
    if (updates.agenticConfidence !== undefined) updateObj.agenticConfidence = updates.agenticConfidence;
    if (Object.keys(updateObj).length > 0) {
      await db.update(enrichedTransactions).set(updateObj).where(eq(enrichedTransactions.id, id));
    }
  }
  
  // Subscription Catalog methods
  async getSubscriptionCatalog(): Promise<SubscriptionCatalog[]> {
    return await db.select().from(subscriptionCatalog);
  }
  
  async getSubscriptionCatalogById(id: string): Promise<SubscriptionCatalog | undefined> {
    const [entry] = await db.select().from(subscriptionCatalog).where(eq(subscriptionCatalog.id, id));
    return entry || undefined;
  }
  
  async searchSubscriptionCatalog(merchantName: string): Promise<SubscriptionCatalog[]> {
    return await db.select().from(subscriptionCatalog)
      .where(ilike(subscriptionCatalog.merchantName, `%${merchantName}%`));
  }
  
  async createSubscriptionCatalogEntry(entry: InsertSubscriptionCatalog): Promise<SubscriptionCatalog> {
    const [newEntry] = await db.insert(subscriptionCatalog).values(entry).returning();
    return newEntry;
  }
  
  async upsertSubscriptionCatalogEntry(entry: InsertSubscriptionCatalog): Promise<SubscriptionCatalog> {
    const [upsertedEntry] = await db.insert(subscriptionCatalog)
      .values(entry)
      .onConflictDoUpdate({
        target: [subscriptionCatalog.merchantName, subscriptionCatalog.productName],
        set: {
          amountCents: entry.amountCents,
          currency: entry.currency,
          recurrence: entry.recurrence,
          category: entry.category,
          confidenceScore: entry.confidenceScore,
        },
      })
      .returning();
    return upsertedEntry;
  }
  
  // Nylas Grants methods
  async getNylasGrantsByUserId(userId: string): Promise<NylasGrant[]> {
    return await db.select().from(nylasGrants).where(eq(nylasGrants.userId, userId));
  }
  
  async getNylasGrantById(id: string): Promise<NylasGrant | undefined> {
    const [grant] = await db.select().from(nylasGrants).where(eq(nylasGrants.id, id));
    return grant || undefined;
  }
  
  async getNylasGrantByGrantId(grantId: string): Promise<NylasGrant | undefined> {
    const [grant] = await db.select().from(nylasGrants).where(eq(nylasGrants.grantId, grantId));
    return grant || undefined;
  }
  
  async createNylasGrant(grant: InsertNylasGrant): Promise<NylasGrant> {
    // Use upsert - if grant_id already exists, update the user association and email
    const [newGrant] = await db.insert(nylasGrants)
      .values(grant)
      .onConflictDoUpdate({
        target: nylasGrants.grantId,
        set: {
          userId: grant.userId,
          emailAddress: grant.emailAddress,
          provider: grant.provider,
        }
      })
      .returning();
    return newGrant;
  }
  
  async deleteNylasGrant(id: string): Promise<void> {
    await db.delete(nylasGrants).where(eq(nylasGrants.id, id));
  }
  
  async deleteNylasGrantsByUserId(userId: string): Promise<void> {
    await db.delete(nylasGrants).where(eq(nylasGrants.userId, userId));
  }

  // Recurring Patterns methods
  async getRecurringPatternsByUserId(userId: string): Promise<RecurringPattern[]> {
    return await db.select().from(recurringPatterns).where(eq(recurringPatterns.userId, userId));
  }

  async getRecurringPatternById(id: string): Promise<RecurringPattern | undefined> {
    const [pattern] = await db.select().from(recurringPatterns).where(eq(recurringPatterns.id, id));
    return pattern || undefined;
  }

  async getActiveRecurringPatternsByUserId(userId: string): Promise<RecurringPattern[]> {
    return await db.select().from(recurringPatterns).where(
      and(eq(recurringPatterns.userId, userId), eq(recurringPatterns.isActive, true))
    );
  }

  async createRecurringPattern(pattern: InsertRecurringPattern): Promise<RecurringPattern> {
    const [newPattern] = await db.insert(recurringPatterns).values(pattern).returning();
    return newPattern;
  }

  async upsertRecurringPatterns(patterns: InsertRecurringPattern[]): Promise<RecurringPattern[]> {
    if (patterns.length === 0) return [];

    const results: RecurringPattern[] = [];

    for (const pattern of patterns) {
      const [existing] = await db.select().from(recurringPatterns).where(
        and(
          eq(recurringPatterns.userId, pattern.userId),
          eq(recurringPatterns.merchantName, pattern.merchantName)
        )
      );

      if (existing) {
        const [updated] = await db.update(recurringPatterns)
          .set({
            frequency: pattern.frequency,
            avgAmountCents: pattern.avgAmountCents,
            minAmountCents: pattern.minAmountCents,
            maxAmountCents: pattern.maxAmountCents,
            anchorDay: pattern.anchorDay,
            lastSeenDate: pattern.lastSeenDate,
            nextDueDate: pattern.nextDueDate,
            occurrenceCount: pattern.occurrenceCount,
            confidenceScore: pattern.confidenceScore,
            ukCategory: pattern.ukCategory,
            isActive: pattern.isActive,
            updatedAt: new Date(),
          })
          .where(eq(recurringPatterns.id, existing.id))
          .returning();
        results.push(updated);
      } else {
        const [created] = await db.insert(recurringPatterns).values(pattern).returning();
        results.push(created);
      }
    }

    return results;
  }

  async updateRecurringPattern(id: string, updates: Partial<RecurringPattern>): Promise<RecurringPattern | undefined> {
    const [pattern] = await db.update(recurringPatterns)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(recurringPatterns.id, id))
      .returning();
    return pattern || undefined;
  }

  async deleteRecurringPattern(id: string): Promise<void> {
    await db.delete(recurringPatterns).where(eq(recurringPatterns.id, id));
  }

  async deleteRecurringPatternsByUserId(userId: string): Promise<void> {
    await db.delete(recurringPatterns).where(eq(recurringPatterns.userId, userId));
  }
}

// Guest mode in-memory storage
class GuestStorageWrapper implements IStorage {
  private dbStorage: DatabaseStorage;
  private guestData: {
    accounts: Account[];
    buckets: DebtBucket[];
    budget: Budget | null;
    preferences: Preference | null;
    plans: Plan[];
  };

  constructor(dbStorage: DatabaseStorage) {
    this.dbStorage = dbStorage;
    this.guestData = {
      accounts: [],
      buckets: [],
      budget: null,
      preferences: null,
      plans: [],
    };
  }

  private isGuest(userId: string): boolean {
    return userId === "guest-user";
  }

  // User methods - pass through to database
  async getUser(id: string): Promise<User | undefined> {
    return this.dbStorage.getUser(id);
  }

  async getUserByEmail(email: string): Promise<User | undefined> {
    return this.dbStorage.getUserByEmail(email);
  }

  async createUser(user: InsertUser): Promise<User> {
    return this.dbStorage.createUser(user);
  }

  async updateUser(id: string, updates: Partial<User>): Promise<User | undefined> {
    return this.dbStorage.updateUser(id, updates);
  }

  // Account methods - use memory for guest
  async getAccountsByUserId(userId: string): Promise<Account[]> {
    if (this.isGuest(userId)) {
      return this.guestData.accounts;
    }
    return this.dbStorage.getAccountsByUserId(userId);
  }

  async getAccount(id: string): Promise<Account | undefined> {
    // Check guest data first
    const guestAccount = this.guestData.accounts.find(a => a.id === id);
    if (guestAccount) return guestAccount;
    return this.dbStorage.getAccount(id);
  }

  async createAccount(account: InsertAccount): Promise<Account> {
    if (this.isGuest(account.userId)) {
      const newAccount = { 
        ...account, 
        id: `guest-account-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        createdAt: new Date() 
      } as Account;
      this.guestData.accounts.push(newAccount);
      return newAccount;
    }
    return this.dbStorage.createAccount(account);
  }

  async updateAccount(id: string, updates: Partial<Account>): Promise<Account | undefined> {
    const guestIdx = this.guestData.accounts.findIndex(a => a.id === id);
    if (guestIdx !== -1) {
      this.guestData.accounts[guestIdx] = { ...this.guestData.accounts[guestIdx], ...updates };
      return this.guestData.accounts[guestIdx];
    }
    return this.dbStorage.updateAccount(id, updates);
  }

  async deleteAccount(id: string): Promise<void> {
    const guestIdx = this.guestData.accounts.findIndex(a => a.id === id);
    if (guestIdx !== -1) {
      this.guestData.accounts.splice(guestIdx, 1);
      this.guestData.buckets = this.guestData.buckets.filter(b => b.accountId !== id);
      return;
    }
    return this.dbStorage.deleteAccount(id);
  }

  async getAccountsWithBucketsByUserId(userId: string): Promise<AccountWithBuckets[]> {
    if (this.isGuest(userId)) {
      return this.guestData.accounts.map(acc => ({
        ...acc,
        buckets: this.guestData.buckets.filter(b => b.accountId === acc.id)
      }));
    }
    return this.dbStorage.getAccountsWithBucketsByUserId(userId);
  }

  async getAccountWithBuckets(id: string): Promise<AccountWithBuckets | undefined> {
    const guestAccount = this.guestData.accounts.find(a => a.id === id);
    if (guestAccount) {
      return {
        ...guestAccount,
        buckets: this.guestData.buckets.filter(b => b.accountId === id)
      };
    }
    return this.dbStorage.getAccountWithBuckets(id);
  }

  async createAccountWithBuckets(account: InsertAccount, buckets: BucketInput[]): Promise<AccountWithBuckets> {
    if (this.isGuest(account.userId)) {
      const accountId = `guest-account-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const newAccount = { 
        ...account, 
        id: accountId,
        createdAt: new Date() 
      } as Account;
      this.guestData.accounts.push(newAccount);
      
      const createdBuckets: DebtBucket[] = buckets.map((bucket, idx) => ({
        ...bucket,
        id: `guest-bucket-${Date.now()}-${idx}`,
        accountId,
        createdAt: new Date()
      } as DebtBucket));
      this.guestData.buckets.push(...createdBuckets);
      
      return { ...newAccount, buckets: createdBuckets };
    }
    return this.dbStorage.createAccountWithBuckets(account, buckets);
  }

  async updateAccountWithBuckets(id: string, updates: Partial<Account>, buckets?: InsertDebtBucket[]): Promise<AccountWithBuckets | undefined> {
    const guestIdx = this.guestData.accounts.findIndex(a => a.id === id);
    if (guestIdx !== -1) {
      this.guestData.accounts[guestIdx] = { ...this.guestData.accounts[guestIdx], ...updates };
      
      if (buckets !== undefined) {
        this.guestData.buckets = this.guestData.buckets.filter(b => b.accountId !== id);
        const createdBuckets: DebtBucket[] = buckets.map((bucket, idx) => ({
          ...bucket,
          id: `guest-bucket-${Date.now()}-${idx}`,
          accountId: id,
          createdAt: new Date()
        } as DebtBucket));
        this.guestData.buckets.push(...createdBuckets);
        return { ...this.guestData.accounts[guestIdx], buckets: createdBuckets };
      }
      
      return {
        ...this.guestData.accounts[guestIdx],
        buckets: this.guestData.buckets.filter(b => b.accountId === id)
      };
    }
    return this.dbStorage.updateAccountWithBuckets(id, updates, buckets);
  }

  // Bucket methods
  async getBucketsByAccountId(accountId: string): Promise<DebtBucket[]> {
    const isGuestAccount = this.guestData.accounts.some(a => a.id === accountId);
    if (isGuestAccount) {
      return this.guestData.buckets.filter(b => b.accountId === accountId);
    }
    return this.dbStorage.getBucketsByAccountId(accountId);
  }

  async createBucket(bucket: InsertDebtBucket): Promise<DebtBucket> {
    const isGuestAccount = this.guestData.accounts.some(a => a.id === bucket.accountId);
    if (isGuestAccount) {
      const newBucket = {
        ...bucket,
        id: `guest-bucket-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        createdAt: new Date()
      } as DebtBucket;
      this.guestData.buckets.push(newBucket);
      return newBucket;
    }
    return this.dbStorage.createBucket(bucket);
  }

  async updateBucket(id: string, updates: Partial<DebtBucket>): Promise<DebtBucket | undefined> {
    const guestIdx = this.guestData.buckets.findIndex(b => b.id === id);
    if (guestIdx !== -1) {
      this.guestData.buckets[guestIdx] = { ...this.guestData.buckets[guestIdx], ...updates };
      return this.guestData.buckets[guestIdx];
    }
    return this.dbStorage.updateBucket(id, updates);
  }

  async deleteBucket(id: string): Promise<void> {
    const guestIdx = this.guestData.buckets.findIndex(b => b.id === id);
    if (guestIdx !== -1) {
      this.guestData.buckets.splice(guestIdx, 1);
      return;
    }
    return this.dbStorage.deleteBucket(id);
  }

  async deleteAllBucketsByAccountId(accountId: string): Promise<void> {
    const isGuestAccount = this.guestData.accounts.some(a => a.id === accountId);
    if (isGuestAccount) {
      this.guestData.buckets = this.guestData.buckets.filter(b => b.accountId !== accountId);
      return;
    }
    return this.dbStorage.deleteAllBucketsByAccountId(accountId);
  }

  // Budget methods - use memory for guest
  async getBudgetByUserId(userId: string): Promise<Budget | undefined> {
    if (this.isGuest(userId)) {
      return this.guestData.budget || undefined;
    }
    return this.dbStorage.getBudgetByUserId(userId);
  }

  async createOrUpdateBudget(budget: InsertBudget): Promise<Budget> {
    if (this.isGuest(budget.userId)) {
      const newBudget = { ...budget, id: "guest-budget", createdAt: new Date() } as Budget;
      this.guestData.budget = newBudget;
      return newBudget;
    }
    return this.dbStorage.createOrUpdateBudget(budget);
  }

  // Preferences methods - use memory for guest
  async getPreferencesByUserId(userId: string): Promise<Preference | undefined> {
    if (this.isGuest(userId)) {
      return this.guestData.preferences || undefined;
    }
    return this.dbStorage.getPreferencesByUserId(userId);
  }

  async createOrUpdatePreferences(prefs: InsertPreference): Promise<Preference> {
    if (this.isGuest(prefs.userId)) {
      const newPrefs = { ...prefs, id: "guest-prefs", createdAt: new Date() } as Preference;
      this.guestData.preferences = newPrefs;
      return newPrefs;
    }
    return this.dbStorage.createOrUpdatePreferences(prefs);
  }

  // Plan methods - use memory for guest
  async getPlansByUserId(userId: string): Promise<Plan[]> {
    if (this.isGuest(userId)) {
      return this.guestData.plans;
    }
    return this.dbStorage.getPlansByUserId(userId);
  }

  async getLatestPlan(userId: string): Promise<Plan | undefined> {
    if (this.isGuest(userId)) {
      return this.guestData.plans[this.guestData.plans.length - 1] || undefined;
    }
    return this.dbStorage.getLatestPlan(userId);
  }

  async createPlan(plan: InsertPlan): Promise<Plan> {
    if (this.isGuest(plan.userId)) {
      const newPlan = { ...plan, createdAt: new Date() } as Plan;
      this.guestData.plans.push(newPlan);
      return newPlan;
    }
    return this.dbStorage.createPlan(plan);
  }

  async deletePlan(id: string): Promise<void> {
    const planToDelete = this.guestData.plans.find(p => p.id === id);
    if (planToDelete) {
      this.guestData.plans = this.guestData.plans.filter(p => p.id !== id);
      return;
    }
    return this.dbStorage.deletePlan(id);
  }

  async confirmPlan(id: string): Promise<Plan | undefined> {
    const guestIdx = this.guestData.plans.findIndex(p => p.id === id);
    if (guestIdx !== -1) {
      this.guestData.plans[guestIdx] = { ...this.guestData.plans[guestIdx], confirmed: true };
      return this.guestData.plans[guestIdx];
    }
    return this.dbStorage.confirmPlan(id);
  }

  async deleteUnconfirmedPlans(userId: string): Promise<void> {
    if (this.isGuest(userId)) {
      this.guestData.plans = this.guestData.plans.filter(p => p.confirmed);
      return;
    }
    return this.dbStorage.deleteUnconfirmedPlans(userId);
  }

  // Lender Rules - pass through to database (shared)
  async getLenderRule(lenderName: string, country: string): Promise<LenderRule | undefined> {
    return this.dbStorage.getLenderRule(lenderName, country);
  }

  async createLenderRule(rule: InsertLenderRule): Promise<LenderRule> {
    return this.dbStorage.createLenderRule(rule);
  }
  
  // TrueLayer Items - pass through to database (not guest specific)
  async getTrueLayerItemByUserId(userId: string): Promise<TrueLayerItem | undefined> {
    if (this.isGuest(userId)) return undefined;
    return this.dbStorage.getTrueLayerItemByUserId(userId);
  }
  
  async getTrueLayerItemsByUserId(userId: string): Promise<TrueLayerItem[]> {
    if (this.isGuest(userId)) return [];
    return this.dbStorage.getTrueLayerItemsByUserId(userId);
  }
  
  async getAllTrueLayerItems(): Promise<TrueLayerItem[]> {
    return this.dbStorage.getAllTrueLayerItems();
  }
  
  async getTrueLayerItemById(id: string): Promise<TrueLayerItem | undefined> {
    return this.dbStorage.getTrueLayerItemById(id);
  }
  
  async getTrueLayerItemByAccountId(userId: string, trueLayerAccountId: string): Promise<TrueLayerItem | undefined> {
    if (this.isGuest(userId)) return undefined;
    return this.dbStorage.getTrueLayerItemByAccountId(userId, trueLayerAccountId);
  }
  
  async createTrueLayerItem(item: InsertTrueLayerItem): Promise<TrueLayerItem> {
    if (this.isGuest(item.userId)) {
      throw new Error("Guest users cannot connect bank accounts");
    }
    return this.dbStorage.createTrueLayerItem(item);
  }
  
  async updateTrueLayerItem(id: string, updates: Partial<TrueLayerItem>): Promise<TrueLayerItem | undefined> {
    return this.dbStorage.updateTrueLayerItem(id, updates);
  }

  async deleteTrueLayerItem(userId: string): Promise<void> {
    if (this.isGuest(userId)) return;
    return this.dbStorage.deleteTrueLayerItem(userId);
  }
  
  async deleteTrueLayerItemById(id: string): Promise<void> {
    return this.dbStorage.deleteTrueLayerItemById(id);
  }
  
  // Enriched Transactions methods - pass through to database (guest users can't use this)
  async getEnrichedTransactionById(id: string): Promise<EnrichedTransaction | null> {
    return this.dbStorage.getEnrichedTransactionById(id);
  }
  
  async getEnrichedTransactionsByUserId(userId: string): Promise<EnrichedTransaction[]> {
    if (this.isGuest(userId)) return [];
    return this.dbStorage.getEnrichedTransactionsByUserId(userId);
  }
  
  async getEnrichedTransactionsByItemId(trueLayerItemId: string): Promise<EnrichedTransaction[]> {
    return this.dbStorage.getEnrichedTransactionsByItemId(trueLayerItemId);
  }
  
  async getEnrichedTransactionsByItemIdExcludePending(trueLayerItemId: string): Promise<EnrichedTransaction[]> {
    return this.dbStorage.getEnrichedTransactionsByItemIdExcludePending(trueLayerItemId);
  }
  
  async getPendingTransactionsByItemId(trueLayerItemId: string): Promise<EnrichedTransaction[]> {
    return this.dbStorage.getPendingTransactionsByItemId(trueLayerItemId);
  }
  
  async getEnrichedTransactionsCount(userId: string): Promise<number> {
    if (this.isGuest(userId)) return 0;
    return this.dbStorage.getEnrichedTransactionsCount(userId);
  }
  
  async getEnrichedTransactionsCountByItemId(trueLayerItemId: string): Promise<number> {
    return this.dbStorage.getEnrichedTransactionsCountByItemId(trueLayerItemId);
  }
  
  async hasRecentEnrichedTransactions(userId: string, maxAgeHours?: number): Promise<boolean> {
    if (this.isGuest(userId)) return false;
    return this.dbStorage.hasRecentEnrichedTransactions(userId, maxAgeHours);
  }
  
  async hasRecentEnrichedTransactionsByItemId(trueLayerItemId: string, maxAgeHours?: number): Promise<boolean> {
    return this.dbStorage.hasRecentEnrichedTransactionsByItemId(trueLayerItemId, maxAgeHours);
  }
  
  async saveEnrichedTransactions(transactions: InsertEnrichedTransaction[]): Promise<void> {
    const validTransactions = transactions.filter(tx => !this.isGuest(tx.userId));
    if (validTransactions.length === 0) return;
    return this.dbStorage.saveEnrichedTransactions(validTransactions);
  }
  
  async deleteEnrichedTransactionsByUserId(userId: string): Promise<void> {
    if (this.isGuest(userId)) return;
    return this.dbStorage.deleteEnrichedTransactionsByUserId(userId);
  }
  
  async deleteEnrichedTransactionsByItemId(trueLayerItemId: string): Promise<void> {
    return this.dbStorage.deleteEnrichedTransactionsByItemId(trueLayerItemId);
  }
  
  async cleanupOrphanedEnrichedTransactions(userId: string): Promise<number> {
    if (this.isGuest(userId)) return 0;
    return this.dbStorage.cleanupOrphanedEnrichedTransactions(userId);
  }
  
  async updateEnrichedTransactionReconciliation(id: string, updates: { transactionType?: string; linkedTransactionId?: string | null; excludeFromAnalysis?: boolean; isInternalTransfer?: boolean; ecosystemPairId?: string | null }): Promise<void> {
    return this.dbStorage.updateEnrichedTransactionReconciliation(id, updates);
  }
  
  async updateEnrichedTransactionEnrichment(trueLayerTransactionId: string, updates: { enrichmentStage?: string; agenticConfidence?: number | null; enrichmentSource?: string; isSubscription?: boolean; contextData?: Record<string, any>; reasoningTrace?: string[] }): Promise<void> {
    return this.dbStorage.updateEnrichedTransactionEnrichment(trueLayerTransactionId, updates);
  }
  
  async updateEnrichedTransaction(id: string, updates: Partial<EnrichedTransaction>): Promise<void> {
    return this.dbStorage.updateEnrichedTransaction(id, updates);
  }
  
  // Subscription Catalog methods - pass through to database (shared data)
  async getSubscriptionCatalog(): Promise<SubscriptionCatalog[]> {
    return this.dbStorage.getSubscriptionCatalog();
  }
  
  async getSubscriptionCatalogById(id: string): Promise<SubscriptionCatalog | undefined> {
    return this.dbStorage.getSubscriptionCatalogById(id);
  }
  
  async searchSubscriptionCatalog(merchantName: string): Promise<SubscriptionCatalog[]> {
    return this.dbStorage.searchSubscriptionCatalog(merchantName);
  }
  
  async createSubscriptionCatalogEntry(entry: InsertSubscriptionCatalog): Promise<SubscriptionCatalog> {
    return this.dbStorage.createSubscriptionCatalogEntry(entry);
  }
  
  async upsertSubscriptionCatalogEntry(entry: InsertSubscriptionCatalog): Promise<SubscriptionCatalog> {
    return this.dbStorage.upsertSubscriptionCatalogEntry(entry);
  }
  
  // Nylas Grants methods - pass through to database (guest users can't use this)
  async getNylasGrantsByUserId(userId: string): Promise<NylasGrant[]> {
    if (this.isGuest(userId)) return [];
    return this.dbStorage.getNylasGrantsByUserId(userId);
  }
  
  async getNylasGrantById(id: string): Promise<NylasGrant | undefined> {
    return this.dbStorage.getNylasGrantById(id);
  }
  
  async getNylasGrantByGrantId(grantId: string): Promise<NylasGrant | undefined> {
    return this.dbStorage.getNylasGrantByGrantId(grantId);
  }
  
  async createNylasGrant(grant: InsertNylasGrant): Promise<NylasGrant> {
    if (this.isGuest(grant.userId)) {
      throw new Error("Guest users cannot connect email accounts");
    }
    return this.dbStorage.createNylasGrant(grant);
  }
  
  async deleteNylasGrant(id: string): Promise<void> {
    return this.dbStorage.deleteNylasGrant(id);
  }
  
  async deleteNylasGrantsByUserId(userId: string): Promise<void> {
    if (this.isGuest(userId)) return;
    return this.dbStorage.deleteNylasGrantsByUserId(userId);
  }

  // Recurring Patterns methods - pass through to database (guest users can't use this)
  async getRecurringPatternsByUserId(userId: string): Promise<RecurringPattern[]> {
    if (this.isGuest(userId)) return [];
    return this.dbStorage.getRecurringPatternsByUserId(userId);
  }

  async getRecurringPatternById(id: string): Promise<RecurringPattern | undefined> {
    return this.dbStorage.getRecurringPatternById(id);
  }

  async getActiveRecurringPatternsByUserId(userId: string): Promise<RecurringPattern[]> {
    if (this.isGuest(userId)) return [];
    return this.dbStorage.getActiveRecurringPatternsByUserId(userId);
  }

  async createRecurringPattern(pattern: InsertRecurringPattern): Promise<RecurringPattern> {
    if (this.isGuest(pattern.userId)) {
      throw new Error("Guest users cannot create recurring patterns");
    }
    return this.dbStorage.createRecurringPattern(pattern);
  }

  async upsertRecurringPatterns(patterns: InsertRecurringPattern[]): Promise<RecurringPattern[]> {
    if (patterns.length === 0) return [];
    if (patterns.some(p => this.isGuest(p.userId))) {
      throw new Error("Guest users cannot create recurring patterns");
    }
    return this.dbStorage.upsertRecurringPatterns(patterns);
  }

  async updateRecurringPattern(id: string, updates: Partial<RecurringPattern>): Promise<RecurringPattern | undefined> {
    return this.dbStorage.updateRecurringPattern(id, updates);
  }

  async deleteRecurringPattern(id: string): Promise<void> {
    return this.dbStorage.deleteRecurringPattern(id);
  }

  async deleteRecurringPatternsByUserId(userId: string): Promise<void> {
    if (this.isGuest(userId)) return;
    return this.dbStorage.deleteRecurringPatternsByUserId(userId);
  }
}

export const storage = new GuestStorageWrapper(new DatabaseStorage());
