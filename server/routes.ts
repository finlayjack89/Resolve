import type { Express } from "express";
import { createServer, type Server } from "http";
import passport from "passport";
import { storage } from "./storage";
import { setupAuth, requireAuth, hashPassword } from "./auth";
import { discoverLenderRule, generatePlanExplanation, answerPlanQuestion, getStatementBucketGuidance, chatStatementGuidance } from "./anthropic";
import { 
  insertUserSchema, updateUserProfileSchema, insertAccountSchema, insertBudgetSchema, 
  insertPreferenceSchema, accountWithBucketsRequestSchema,
  type InsertAccount, type InsertBudget, type InsertDebtBucket, AccountType, BucketType
} from "@shared/schema";
import { randomUUID } from "crypto";
import { buildStructuredPlan } from "./plan-transformer";
import { registerLenderRuleRoutes } from "./routes/lender-rules";
import { registerLenderProductRoutes } from "./routes/lender-products";
import { registerBudgetAnalysisRoutes } from "./routes/budget-analysis";
import { registerTrueLayerRoutes } from "./routes/truelayer";
import { registerCurrentFinancesRoutes } from "./routes/current-finances";
import { registerTransactionRoutes } from "./routes/transactions";
import emailRoutes from "./routes/email";

// Helper function to retry fetch requests with exponential backoff
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 3,
  initialDelayMs: number = 500
): Promise<Response> {
  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, options);
      return response; // Success - return response (even if not ok, let caller handle)
    } catch (error: any) {
      lastError = error;
      
      // Don't retry if this is the last attempt
      if (attempt < maxRetries - 1) {
        const delayMs = initialDelayMs * Math.pow(2, attempt);
        console.log(`[Retry] Attempt ${attempt + 1} failed, retrying in ${delayMs}ms...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    }
  }
  
  // All retries exhausted
  throw lastError || new Error("Max retries exceeded");
}

// Enum mapping functions to translate frontend values to Python backend values
// These functions accept both snake_case (frontend) and human-readable (database) formats
function mapAccountTypeToPython(frontendValue: string): string {
  const mapping: Record<string, string> = {
    // Snake_case keys (from frontend forms)
    "credit_card": "Credit Card",
    "bnpl": "Buy Now, Pay Later",
    "loan": "Loan",
    // Human-readable keys (from database storage)
    "Credit Card": "Credit Card",
    "Buy Now, Pay Later": "Buy Now, Pay Later",
    "Loan": "Loan",
  };
  if (!mapping[frontendValue]) {
    throw new Error(`Unknown account type: ${frontendValue}. Expected one of: credit_card, bnpl, loan`);
  }
  return mapping[frontendValue];
}

function mapStrategyToPython(frontendValue: string): string {
  const mapping: Record<string, string> = {
    // Snake_case keys (from frontend)
    "minimize_interest": "Minimize Total Interest",
    "minimize_spend": "Minimize Monthly Spend",
    "maximize_speed": "Pay Off ASAP with Max Budget",
    "promo_windows": "Pay Off Within Promo Windows",
    "minimize_spend_to_clear_promos": "Minimize Spend to Clear Promos",
    // Human-readable keys (from database)
    "Minimize Total Interest": "Minimize Total Interest",
    "Minimize Monthly Spend": "Minimize Monthly Spend",
    "Pay Off ASAP with Max Budget": "Pay Off ASAP with Max Budget",
    "Pay Off Within Promo Windows": "Pay Off Within Promo Windows",
    "Minimize Spend to Clear Promos": "Minimize Spend to Clear Promos",
  };
  if (!mapping[frontendValue]) {
    throw new Error(`Unknown strategy: ${frontendValue}. Expected one of: minimize_interest, minimize_spend, maximize_speed, promo_windows, minimize_spend_to_clear_promos`);
  }
  return mapping[frontendValue];
}

function mapPaymentShapeToPython(frontendValue: string): string {
  const mapping: Record<string, string> = {
    // Snake_case keys (from frontend)
    "standard": "Linear (Same Amount Per Account)",
    "optimized": "Optimized (Variable Amounts)",
    // Human-readable keys (from database)
    "Linear (Same Amount Per Account)": "Linear (Same Amount Per Account)",
    "Optimized (Variable Amounts)": "Optimized (Variable Amounts)",
  };
  if (!mapping[frontendValue]) {
    throw new Error(`Unknown payment shape: ${frontendValue}. Expected one of: standard, optimized`);
  }
  return mapping[frontendValue];
}

export async function registerRoutes(app: Express): Promise<Server> {
  setupAuth(app);
  
  // Register modular routes
  registerLenderRuleRoutes(app);
  registerLenderProductRoutes(app);
  registerBudgetAnalysisRoutes(app);
  registerTrueLayerRoutes(app);
  registerCurrentFinancesRoutes(app);
  registerTransactionRoutes(app);
  app.use("/api/email", emailRoutes);

  // ==================== Auth Routes ====================
  app.post("/api/auth/signup", async (req, res, next) => {
    try {
      const validatedData = insertUserSchema.parse(req.body);
      
      // Check if user exists
      const existing = await storage.getUserByEmail(validatedData.email);
      if (existing) {
        return res.status(400).send({ message: "User already exists" });
      }

      // Hash password and create user
      const hashedPassword = await hashPassword(validatedData.password);
      const user = await storage.createUser({
        ...validatedData,
        id: randomUUID(),
        password: hashedPassword,
      });

      // Auto-login after signup
      req.login(user, (err) => {
        if (err) {
          return next(err);
        }
        // Explicitly save session to ensure it persists on first login attempt
        req.session.save((saveErr) => {
          if (saveErr) {
            return next(saveErr);
          }
          const { password: _, ...userWithoutPassword } = user;
          res.json(userWithoutPassword);
        });
      });
    } catch (error: any) {
      res.status(400).send({ message: error.message || "Signup failed" });
    }
  });

  app.post("/api/auth/login", (req, res, next) => {
    passport.authenticate("local", (err: any, user: any, info: any) => {
      if (err) {
        return next(err);
      }
      if (!user) {
        return res.status(401).send({ message: info?.message || "Login failed" });
      }
      req.login(user, (err) => {
        if (err) {
          return next(err);
        }
        // Explicitly save session to ensure it persists on first login attempt
        req.session.save((saveErr) => {
          if (saveErr) {
            return next(saveErr);
          }
          const { password: _, ...userWithoutPassword } = user;
          res.json(userWithoutPassword);
        });
      });
    })(req, res, next);
  });

  app.post("/api/auth/logout", async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (userId) {
        await storage.deleteUnconfirmedPlans(userId);
      }
      req.logout((err) => {
        if (err) {
          return res.status(500).send({ message: "Logout failed" });
        }
        res.json({ message: "Logged out successfully" });
      });
    } catch (error: any) {
      req.logout((err) => {
        if (err) {
          return res.status(500).send({ message: "Logout failed" });
        }
        res.json({ message: "Logged out successfully" });
      });
    }
  });

  app.post("/api/auth/guest", (req, res, next) => {
    // Create a guest user session with empty location data to force onboarding
    const guestUser = {
      id: "guest-user",
      email: "guest@example.com",
      firstName: "Guest",
      lastName: "User",
      country: null,
      region: null,
      currency: null,
      createdAt: new Date(),
    };
    
    req.login(guestUser, (err) => {
      if (err) {
        return res.status(500).send({ message: "Guest login failed" });
      }
      // Explicitly save session to ensure it persists
      req.session.save((saveErr) => {
        if (saveErr) {
          return next(saveErr);
        }
        res.json(guestUser);
      });
    });
  });

  app.get("/api/auth/me", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).send({ message: "Not authenticated" });
    }
    const { password: _, ...userWithoutPassword } = req.user as any;
    res.json(userWithoutPassword);
  });

  // ==================== User Profile Routes ====================
  app.patch("/api/user/profile", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const validatedData = updateUserProfileSchema.parse(req.body);
      
      // Handle guest user specially (update session, not database)
      if (userId === "guest-user") {
        const updatedGuestUser = { ...req.user, ...validatedData };
        
        // Use Promise wrapper for req.login
        await new Promise((resolve, reject) => {
          req.login(updatedGuestUser, (err) => {
            if (err) reject(err);
            else resolve(undefined);
          });
        });
        
        const { password: _, ...userWithoutPassword } = updatedGuestUser as any;
        return res.json(userWithoutPassword);
      }
      
      // Regular user - update database
      const updatedUser = await storage.updateUser(userId, validatedData);
      
      if (!updatedUser) {
        return res.status(404).send({ message: "User not found" });
      }

      // Update session with latest data
      await new Promise((resolve, reject) => {
        req.login(updatedUser, (err) => {
          if (err) reject(err);
          else resolve(undefined);
        });
      });
      
      const { password: _, ...userWithoutPassword } = updatedUser as any;
      res.json(userWithoutPassword);
    } catch (error: any) {
      console.error("Profile update error:", error);
      res.status(400).send({ message: error.message || "Failed to update profile" });
    }
  });

  // ==================== Account Routes ====================
  app.get("/api/accounts", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const withBuckets = req.query.withBuckets === 'true';
      
      if (withBuckets) {
        const accounts = await storage.getAccountsWithBucketsByUserId(userId);
        res.json(accounts);
      } else {
        const accounts = await storage.getAccountsByUserId(userId);
        res.json(accounts);
      }
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch accounts" });
    }
  });

  app.get("/api/accounts/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = (req.user as any).id;
      const withBuckets = req.query.withBuckets === 'true';
      
      if (withBuckets) {
        const account = await storage.getAccountWithBuckets(id);
        if (!account || account.userId !== userId) {
          return res.status(404).send({ message: "Account not found" });
        }
        res.json(account);
      } else {
        const account = await storage.getAccount(id);
        if (!account || account.userId !== userId) {
          return res.status(404).send({ message: "Account not found" });
        }
        res.json(account);
      }
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch account" });
    }
  });

  app.post("/api/accounts", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { buckets, ...accountData } = req.body;
      
      // Check if this is a credit card with buckets
      if (buckets && Array.isArray(buckets) && buckets.length > 0) {
        const validatedData = accountWithBucketsRequestSchema.parse(req.body);
        
        // Prepare buckets for insertion (accountId will be added by storage layer)
        const bucketsToInsert = validatedData.buckets?.map((bucket: any) => ({
          bucketType: bucket.bucketType,
          label: bucket.label || null,
          balanceCents: bucket.balanceCents,
          aprBps: bucket.aprBps,
          isPromo: bucket.isPromo,
          promoExpiryDate: bucket.promoExpiryDate || null,
        })) || [];
        
        const account = await storage.createAccountWithBuckets({
          lenderName: validatedData.lenderName,
          accountType: validatedData.accountType,
          currency: validatedData.currency,
          currentBalanceCents: validatedData.currentBalanceCents,
          aprStandardBps: validatedData.aprStandardBps,
          paymentDueDay: validatedData.paymentDueDay,
          minPaymentRuleFixedCents: validatedData.minPaymentRuleFixedCents,
          minPaymentRulePercentageBps: validatedData.minPaymentRulePercentageBps,
          minPaymentRuleIncludesInterest: validatedData.minPaymentRuleIncludesInterest,
          membershipFeeCents: validatedData.membershipFeeCents || 0,
          membershipFeeFrequency: validatedData.membershipFeeFrequency || "none",
          isManualEntry: validatedData.isManualEntry,
          promoEndDate: validatedData.promoEndDate || null,
          promoDurationMonths: validatedData.promoDurationMonths || null,
          accountOpenDate: validatedData.accountOpenDate || null,
          notes: validatedData.notes || null,
          userId,
        }, bucketsToInsert);

        res.json(account);
      } else {
        // Traditional account creation (no buckets or non-credit card)
        const validatedData = insertAccountSchema.parse(accountData);
        
        const account = await storage.createAccount({
          ...validatedData,
          userId,
        });

        res.json(account);
      }
    } catch (error: any) {
      console.error("Account creation error:", error);
      res.status(400).send({ message: error.message || "Failed to create account" });
    }
  });

  app.patch("/api/accounts/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = (req.user as any).id;
      const { buckets, ...accountData } = req.body;
      
      // Verify ownership
      const existing = await storage.getAccount(id);
      if (!existing || existing.userId !== userId) {
        return res.status(404).send({ message: "Account not found" });
      }

      // If buckets are provided, use the with-buckets update
      if (buckets !== undefined) {
        const bucketsToInsert: InsertDebtBucket[] = buckets.map((bucket: any) => ({
          bucketType: bucket.bucketType,
          label: bucket.label || null,
          balanceCents: bucket.balanceCents,
          aprBps: bucket.aprBps,
          isPromo: bucket.isPromo || false,
          promoExpiryDate: bucket.promoExpiryDate || null,
        }));
        
        const updated = await storage.updateAccountWithBuckets(id, accountData, bucketsToInsert);
        res.json(updated);
      } else {
        const updated = await storage.updateAccount(id, accountData);
        res.json(updated);
      }
    } catch (error: any) {
      res.status(400).send({ message: error.message || "Failed to update account" });
    }
  });

  app.delete("/api/accounts/:id", requireAuth, async (req, res) => {
    try {
      const { id } = req.params;
      const userId = (req.user as any).id;
      
      // Verify ownership
      const existing = await storage.getAccount(id);
      if (!existing || existing.userId !== userId) {
        return res.status(404).send({ message: "Account not found" });
      }

      await storage.deleteAccount(id);
      res.json({ message: "Account deleted" });
    } catch (error: any) {
      res.status(400).send({ message: error.message || "Failed to delete account" });
    }
  });

  // ==================== Bucket Routes ====================
  app.get("/api/accounts/:accountId/buckets", requireAuth, async (req, res) => {
    try {
      const { accountId } = req.params;
      const userId = (req.user as any).id;
      
      // Verify ownership
      const account = await storage.getAccount(accountId);
      if (!account || account.userId !== userId) {
        return res.status(404).send({ message: "Account not found" });
      }

      const buckets = await storage.getBucketsByAccountId(accountId);
      res.json(buckets);
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch buckets" });
    }
  });

  // ==================== Budget Routes ====================
  // Helper function to sanitize budget data - ensures arrays and filters out invalid tuples
  const sanitizeBudgetData = (data: any) => {
    const sanitized = { ...data };
    
    // Ensure futureChanges is always an array before filtering
    if (!Array.isArray(sanitized.futureChanges)) {
      console.log('[sanitizeBudgetData] futureChanges was not an array, resetting to []:', typeof sanitized.futureChanges);
      sanitized.futureChanges = [];
    } else {
      // Filter futureChanges to remove any tuples with null/undefined values
      sanitized.futureChanges = sanitized.futureChanges.filter((item: any) => {
        if (!Array.isArray(item) || item.length !== 2) return false;
        const [date, amount] = item;
        return date != null && amount != null && typeof amount === 'number' && amount > 0;
      });
    }
    
    // Ensure lumpSumPayments is always an array before filtering
    if (!Array.isArray(sanitized.lumpSumPayments)) {
      console.log('[sanitizeBudgetData] lumpSumPayments was not an array, resetting to []:', typeof sanitized.lumpSumPayments);
      sanitized.lumpSumPayments = [];
    } else {
      // Filter lumpSumPayments to remove any tuples with null/undefined values
      sanitized.lumpSumPayments = sanitized.lumpSumPayments.filter((item: any) => {
        if (!Array.isArray(item) || item.length !== 2) return false;
        const [date, amount] = item;
        return date != null && amount != null && typeof amount === 'number' && amount > 0;
      });
    }
    
    return sanitized;
  };

  app.get("/api/budget", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const budget = await storage.getBudgetByUserId(userId);
      if (!budget) {
        return res.status(404).send({ message: "Budget not found" });
      }
      // Sanitize before sending to prevent corrupted data from causing frontend issues
      res.json(sanitizeBudgetData(budget));
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch budget" });
    }
  });

  app.post("/api/budget", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const validatedData = insertBudgetSchema.parse(req.body);
      
      // Sanitize data before storing to filter out any null/invalid entries
      const sanitizedData = sanitizeBudgetData(validatedData);
      
      const budget = await storage.createOrUpdateBudget({
        ...sanitizedData,
        userId,
      } as InsertBudget);

      res.json(sanitizeBudgetData(budget));
    } catch (error: any) {
      res.status(400).send({ message: error.message || "Failed to save budget" });
    }
  });

  app.patch("/api/budget", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const validatedData = insertBudgetSchema.partial().parse(req.body);
      
      // Get existing budget to merge with updates
      const existing = await storage.getBudgetByUserId(userId);
      if (!existing) {
        return res.status(404).send({ message: "Budget not found" });
      }

      // Sanitize merged data before storing
      const mergedData = {
        ...existing,
        ...validatedData,
        userId,
      };
      const sanitizedData = sanitizeBudgetData(mergedData);

      const budget = await storage.createOrUpdateBudget(sanitizedData as InsertBudget);

      res.json(sanitizeBudgetData(budget));
    } catch (error: any) {
      res.status(400).send({ message: error.message || "Failed to update budget" });
    }
  });

  // ==================== Preferences Routes ====================
  app.get("/api/preferences", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const prefs = await storage.getPreferencesByUserId(userId);
      if (!prefs) {
        return res.status(404).send({ message: "Preferences not found" });
      }
      res.json(prefs);
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch preferences" });
    }
  });

  app.post("/api/preferences", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const validatedData = insertPreferenceSchema.parse(req.body);
      
      const prefs = await storage.createOrUpdatePreferences({
        ...validatedData,
        userId,
      });

      res.json(prefs);
    } catch (error: any) {
      res.status(400).send({ message: error.message || "Failed to save preferences" });
    }
  });

  // ==================== Lender Rules Routes (AI) ====================
  app.post("/api/lender-rules/discover", requireAuth, async (req, res) => {
    try {
      const { lenderName, country } = req.body;
      
      if (!lenderName || !country) {
        return res.status(400).send({ message: "lenderName and country are required" });
      }

      // Check cache first
      const existing = await storage.getLenderRule(lenderName, country);
      if (existing) {
        // Format as LenderRuleDiscoveryResponse
        return res.json({
          lenderName: existing.lenderName,
          ruleDescription: existing.ruleDescription || '',
          minPaymentRule: {
            fixedCents: existing.fixedCents || 0,
            percentageBps: existing.percentageBps || 0,
            includesInterest: existing.includesInterest || false,
          },
          confidence: 'high',
        });
      }

      // Discover using AI
      const result = await discoverLenderRule(lenderName, country);
      
      // Save to database
      await storage.createLenderRule({
        id: randomUUID(),
        lenderName: result.lenderName,
        country,
        ruleDescription: result.ruleDescription,
        fixedCents: result.minPaymentRule.fixedCents,
        percentageBps: result.minPaymentRule.percentageBps,
        includesInterest: result.minPaymentRule.includesInterest,
      });

      // Return the properly formatted response
      res.json(result);
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to discover lender rule" });
    }
  });

  // ==================== Statement Guidance Routes (AI) ====================
  app.post("/api/statement-guidance", requireAuth, async (req, res) => {
    try {
      const { bankName, country = "UK" } = req.body;
      
      if (!bankName) {
        return res.status(400).send({ message: "bankName is required" });
      }

      const result = await getStatementBucketGuidance(bankName, country);
      res.json(result);
    } catch (error: any) {
      console.error("[Statement Guidance] Error:", error);
      res.status(500).send({ message: error.message || "Failed to get statement guidance" });
    }
  });

  app.post("/api/statement-guidance/chat", requireAuth, async (req, res) => {
    try {
      const { bankName, message, conversationHistory = [] } = req.body;
      
      if (!bankName || !message) {
        return res.status(400).send({ message: "bankName and message are required" });
      }

      if (typeof message !== 'string' || message.trim().length === 0) {
        return res.status(400).send({ message: "message cannot be empty" });
      }

      const validHistory = Array.isArray(conversationHistory) 
        ? conversationHistory.filter((m: any) => 
            m && typeof m.content === 'string' && m.content.trim().length > 0 &&
            (m.role === 'user' || m.role === 'assistant')
          )
        : [];

      const response = await chatStatementGuidance(bankName, message.trim(), validHistory);
      res.json({ response });
    } catch (error: any) {
      console.error("[Statement Guidance Chat] Error:", error);
      res.status(500).send({ message: error.message || "Failed to get chat response" });
    }
  });

  // ==================== Plan Generation Routes ====================
  app.post("/api/plans/generate", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { accounts, budget, preferences, planStartDate } = req.body;

      if (!accounts || !budget || !preferences) {
        return res.status(400).send({ message: "Missing required data" });
      }

      // Transform data to match Python FastAPI schema (snake_case) and map enum values
      const portfolioInput = {
        accounts: accounts.map((acc: any, index: number) => ({
          account_id: `acc_${index}`,
          lender_name: acc.lenderName,
          account_type: mapAccountTypeToPython(acc.accountType),
          current_balance_cents: acc.currentBalanceCents,
          apr_standard_bps: acc.aprStandardBps,
          payment_due_day: acc.paymentDueDay,
          min_payment_rule_type: "GREATER_OF",
          min_payment_rule: {
            // CRITICAL FIX: Frontend sends nested minPaymentRule object, not flat fields
            fixed_cents: acc.minPaymentRule?.fixedCents || 0,
            percentage_bps: acc.minPaymentRule?.percentageBps || 0,
            includes_interest: acc.minPaymentRule?.includesInterest || false,
          },
          promo_end_date: acc.promoEndDate || null,
          promo_duration_months: acc.promoDurationMonths || null,
          account_open_date: acc.accountOpenDate || planStartDate,
          notes: acc.notes || "",
        })),
        budget: {
          monthly_budget_cents: budget.monthlyBudgetCents,
          // Python expects List[Tuple[date, int]] - arrays of 2-element arrays
          // futureChanges is ALREADY in the correct format: [["2026-05-05", 75000]]
          // No mapping needed - just pass it through!
          future_changes: budget.futureChanges || [],
          // Python expects List[Tuple[date, int]] - arrays of 2-element arrays
          // lumpSumPayments is ALREADY in the correct format: [["2026-05-05", 10000]]
          // Note: targetLenderName is ignored for now (not supported by solver)
          lump_sum_payments: budget.lumpSumPayments || [],
        },
        preferences: {
          strategy: mapStrategyToPython(preferences.strategy),
          payment_shape: mapPaymentShapeToPython(preferences.paymentShape),
        },
        plan_start_date: planStartDate || new Date().toISOString().split('T')[0],
      };

      // LOG: Verify minimum payment rules are being sent correctly
      console.log('[DEBUG] Sending to Python solver - Account minimum payment rules:');
      portfolioInput.accounts.forEach((acc: any) => {
        console.log(`  ${acc.lender_name}: fixed=$${acc.min_payment_rule.fixed_cents/100}, percentage=${acc.min_payment_rule.percentage_bps}bps`);
      });

      // Call Python FastAPI backend with retry logic
      const pythonBackendUrl = process.env.PYTHON_BACKEND_URL || "http://127.0.0.1:8000";
      console.log(`[Plan Generation] Calling Python backend at ${pythonBackendUrl}/generate-plan`);
      
      let pythonResponse;
      try {
        pythonResponse = await fetchWithRetry(`${pythonBackendUrl}/generate-plan`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(portfolioInput),
        }, 3, 500); // 3 retries with 500ms initial delay (exponential backoff)
      } catch (fetchError: any) {
        console.error("[Plan Generation] Failed to reach Python backend after retries:", {
          url: `${pythonBackendUrl}/generate-plan`,
          error: fetchError.message,
          errorType: fetchError.code || fetchError.name,
          stack: fetchError.stack
        });
        
        // Provide more helpful error messages based on error type
        let userMessage = "Could not connect to optimization engine.";
        if (fetchError.code === "ECONNREFUSED") {
          userMessage = "Optimization engine is not available. It may be starting up or experiencing issues.";
        } else if (fetchError.code === "ETIMEDOUT") {
          userMessage = "Connection to optimization engine timed out. Please try again.";
        } else if (fetchError.name === "AbortError") {
          userMessage = "Request to optimization engine was aborted. Please try again.";
        }
        
        return res.status(500).send({ 
          message: userMessage,
          status: "ERROR"
        });
      }

      if (!pythonResponse.ok) {
        let errorMessage = "Python solver failed";
        let errorDetail = null;
        try {
          const errorData = await pythonResponse.json();
          errorDetail = errorData.detail;
          errorMessage = JSON.stringify(errorData.detail || errorData) || errorMessage;
          console.error("Python backend error:", JSON.stringify(errorData, null, 2));
        } catch (e) {
          errorMessage = `Solver returned ${pythonResponse.status}`;
        }
        console.error("Python backend request failed:", {
          status: pythonResponse.status,
          url: `${pythonBackendUrl}/generate-plan`,
          error: errorMessage
        });
        return res.status(400).send({ 
          message: errorMessage,
          status: "ERROR",
          detail: errorDetail
        });
      }

      const pythonResult = await pythonResponse.json();

      // LOG 1: Raw Python solver output
      console.log('[DEBUG] Raw pythonResult from solver:', JSON.stringify({
        status: pythonResult.status,
        planLength: pythonResult.plan?.length,
        firstFewResults: pythonResult.plan?.slice(0, 10).map((r: any) => ({
          month: r.month,
          lender_name: r.lender_name,
          payment_cents: r.payment_cents,
          ending_balance_cents: r.ending_balance_cents,
        }))
      }, null, 2));

      // Validate solver response
      if (!pythonResult.status) {
        return res.status(500).send({ 
          message: "Invalid response from solver",
          status: "ERROR" 
        });
      }

      // Transform Python response back to our schema
      let planData: any[] = [];
      let status = pythonResult.status;
      let errorMessage = pythonResult.error_message || null;

      if (pythonResult.status === "OPTIMAL" && pythonResult.plan) {
        planData = pythonResult.plan.map((result: any) => ({
          month: result.month,
          lenderName: result.lender_name,
          paymentCents: result.payment_cents,
          interestChargedCents: result.interest_charged_cents,
          principalPaidCents: result.principal_paid_cents,
          endingBalanceCents: result.ending_balance_cents,
        }));

        // LOG 2: Transformed planData (after mapping)
        console.log('[DEBUG] Transformed planData (first 10):', JSON.stringify(
          planData.slice(0, 10).map(r => ({
            month: r.month,
            lenderName: r.lenderName,
            paymentCents: r.paymentCents,
            endingBalanceCents: r.endingBalanceCents,
          })),
          null,
          2
        ));
      } else if (pythonResult.status === "INFEASIBLE") {
        return res.status(400).send({
          message: errorMessage || "Budget too low to cover minimum payments. Please increase your monthly budget.",
          status: "INFEASIBLE"
        });
      } else if (pythonResult.status === "UNBOUNDED") {
        return res.status(400).send({
          message: errorMessage || "Optimization problem is unbounded. Please check your account data.",
          status: "UNBOUNDED"
        });
      } else {
        return res.status(500).send({
          message: errorMessage || "Solver failed with unknown error",
          status: pythonResult.status
        });
      }

      // Calculate totals for AI explanation
      const totalDebt = accounts.reduce((sum: number, acc: any) => sum + acc.currentBalanceCents, 0);
      const totalInterest = planData.reduce((sum: number, r: any) => sum + r.interestChargedCents, 0);
      const payoffMonths = planData.length > 0 ? Math.max(...planData.map((r: any) => r.month)) : 0;

      // Generate AI explanation
      const explanation = await generatePlanExplanation(
        preferences.strategy,
        totalDebt,
        totalInterest,
        payoffMonths,
        accounts.length
      );

      // Fetch actual accounts from database to get Account[] objects with IDs
      const dbAccounts = await storage.getAccountsByUserId(userId);
      
      // Build structured plan data for dashboard
      const startDate = planStartDate || new Date().toISOString().split('T')[0];
      const structuredPlan = buildStructuredPlan(planData, dbAccounts, startDate);
      
      console.log('[Plan Generation] Structured plan data:', JSON.stringify({
        payoffTimeMonths: structuredPlan.payoffTimeMonths,
        totalInterestPaidCents: structuredPlan.totalInterestPaidCents,
        scheduleEntries: structuredPlan.schedule.length,
        accountSchedules: structuredPlan.accountSchedules.length
      }, null, 2));

      // LOG 3: planData before saving to database
      console.log('[DEBUG] planData before database save (first 10):', JSON.stringify(
        planData.slice(0, 10).map(r => ({
          month: r.month,
          lenderName: r.lenderName,
          paymentCents: r.paymentCents,
          endingBalanceCents: r.endingBalanceCents,
        })),
        null,
        2
      ));

      // Save plan
      const plan = await storage.createPlan({
        id: randomUUID(),
        userId,
        planStartDate: startDate,
        planData,
        status,
        explanation,
        createdAt: new Date(),
      });

      // LOG 4: Verify what was saved to database
      console.log('[DEBUG] Plan saved to database with id:', plan.id);
      console.log('[DEBUG] plan.planData from database (first 10):', JSON.stringify(
        (plan.planData || []).slice(0, 10).map((r: any) => ({
          month: r.month,
          lenderName: r.lenderName,
          paymentCents: r.paymentCents,
          endingBalanceCents: r.endingBalanceCents,
        })),
        null,
        2
      ));

      // Return enriched plan response with structured data
      res.json({
        ...plan,
        ...structuredPlan,
        plan: planData,
      });
    } catch (error: any) {
      console.error("Plan generation error:", error);
      res.status(500).send({ message: error.message || "Failed to generate plan" });
    }
  });

  app.get("/api/plans/latest", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const plan = await storage.getLatestPlan(userId);
      
      if (!plan) {
        return res.status(404).send({ message: "No plan found" });
      }

      // LOG 5: Retrieved planData from database
      console.log('[DEBUG] Retrieved plan from database, id:', plan.id);
      console.log('[DEBUG] plan.planData from database (first 10):', JSON.stringify(
        (plan.planData || []).slice(0, 10).map((r: any) => ({
          month: r.month,
          lenderName: r.lenderName,
          paymentCents: r.paymentCents,
          endingBalanceCents: r.endingBalanceCents,
        })),
        null,
        2
      ));

      // Fetch accounts to rebuild structured plan data
      const accounts = await storage.getAccountsByUserId(userId);
      
      // Rebuild structured plan data from planData
      const structuredPlan = buildStructuredPlan(
        plan.planData || [],
        accounts,
        plan.planStartDate || new Date().toISOString().split('T')[0]
      );

      // LOG 6: Final response being sent to client
      console.log('[DEBUG] Sending response to client with planData (first 10):', JSON.stringify(
        (plan.planData || []).slice(0, 10).map((r: any) => ({
          month: r.month,
          lenderName: r.lenderName,
          paymentCents: r.paymentCents,
          endingBalanceCents: r.endingBalanceCents,
        })),
        null,
        2
      ));

      // Return enriched plan with structured data
      res.json({
        ...plan,
        ...structuredPlan,
        plan: plan.planData,
      });
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch plan" });
    }
  });

  app.get("/api/plans", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const plans = await storage.getPlansByUserId(userId);
      res.json(plans);
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to fetch plans" });
    }
  });

  app.post("/api/plans/validate", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const latestPlan = await storage.getLatestPlan(userId);
      
      if (!latestPlan || !latestPlan.planData) {
        return res.json({ message: "No plan to validate", deleted: false });
      }

      // Get all current accounts
      const accounts = await storage.getAccountsByUserId(userId);
      const currentLenderNames = accounts.map(acc => acc.lenderName);

      // Extract lender names from plan
      const planLenderNames = Array.from(
        new Set((latestPlan.planData as any[]).map((r: any) => r.lenderName))
      );

      // Check if all lenders in the plan still have accounts
      const allLendersExist = planLenderNames.every(lender => 
        currentLenderNames.includes(lender)
      );

      // If any lender no longer exists, delete the plan
      if (!allLendersExist) {
        await storage.deletePlan(latestPlan.id);
        return res.json({ 
          message: "Plan was outdated and has been deleted. Some accounts were removed from your portfolio.",
          deleted: true 
        });
      }

      res.json({ message: "Plan is current", deleted: false });
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to validate plan" });
    }
  });

  app.post("/api/plans/:id/confirm", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const planId = req.params.id;
      
      const plans = await storage.getPlansByUserId(userId);
      const plan = plans.find(p => p.id === planId);
      
      if (!plan) {
        return res.status(404).send({ message: "Plan not found" });
      }

      const confirmedPlan = await storage.confirmPlan(planId);
      
      res.json({ message: "Plan confirmed and saved!", plan: confirmedPlan });
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to confirm plan" });
    }
  });

  app.post("/api/plans/:id/delete", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const planId = req.params.id;
      
      // Verify the plan belongs to the user
      const plans = await storage.getPlansByUserId(userId);
      const plan = plans.find(p => p.id === planId);
      
      if (!plan) {
        return res.status(404).send({ message: "Plan not found" });
      }

      // Delete the plan (accounts are NOT affected)
      await storage.deletePlan(planId);
      
      res.json({ message: "Plan deleted successfully. Your accounts remain unchanged." });
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to delete plan" });
    }
  });

  app.post("/api/plans/explain", requireAuth, async (req, res) => {
    try {
      const { question, planData, explanation, conversationHistory } = req.body;

      if (!question) {
        return res.status(400).send({ message: "Question is required" });
      }

      const answer = await answerPlanQuestion(question, planData, explanation, conversationHistory || []);
      
      res.json({ answer });
    } catch (error: any) {
      res.status(500).send({ message: error.message || "Failed to answer question" });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

// Note: Mock plan generation removed - now using Python FastAPI backend integration
