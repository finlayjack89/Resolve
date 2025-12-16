/**
 * Transaction Analysis API Routes
 * 
 * Provides endpoints for transaction reasoning traces, user corrections,
 * and subscription detection features.
 */

import type { Express } from "express";
import { z } from "zod";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import type { EnrichedTransaction, SubscriptionCatalog, ReasoningTrace, ContextData } from "@shared/schema";
import { 
  MasterCategory,
  getMasterCategoryConfig,
  getAllMasterCategories,
} from "../services/category-mapping";

const correctCategorySchema = z.object({
  masterCategory: z.nativeEnum(MasterCategory),
  reason: z.string().optional(),
});

export interface TransactionTraceResponse {
  transactionId: string;
  merchantName: string | null;
  amountCents: number;
  transactionDate: string | null;
  masterCategory: string | null;
  aiConfidenceScore: number | null;
  reasoningTrace: ReasoningTrace | null;
  contextData: ContextData | null;
  isSubscription: boolean | null;
  subscriptionDetails: {
    id: string;
    productName: string;
    merchantName: string;
    category: string | null;
  } | null;
  userCorrectedCategory: string | null;
}

export interface DetectedSubscriptionResponse {
  transactionId: string;
  merchantName: string | null;
  merchantLogo: string | null;
  productName: string;
  amountCents: number;
  frequency: string | null;
  category: string | null;
  lastTransactionDate: string | null;
  transactionCount: number;
}

export interface MasterCategoryResponse {
  id: string;
  displayName: string;
  icon: string;
  color: string;
  description: string;
}

export function registerTransactionRoutes(app: Express): void {
  
  app.get("/api/transactions/:id/trace", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const transactionId = req.params.id;
      
      const transaction = await storage.getEnrichedTransactionById(transactionId);
      
      if (!transaction) {
        return res.status(404).json({ message: "Transaction not found" });
      }
      
      if (transaction.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      let subscriptionDetails: TransactionTraceResponse['subscriptionDetails'] = null;
      if (transaction.subscriptionId) {
        const subscriptions = await storage.getAllSubscriptions();
        const sub = subscriptions.find(s => s.id === transaction.subscriptionId);
        if (sub) {
          subscriptionDetails = {
            id: sub.id,
            productName: sub.productName,
            merchantName: sub.merchantName,
            category: sub.category,
          };
        }
      }
      
      const txDate = transaction.transactionDate;
      const dateStr = txDate ? new Date(txDate).toISOString() : null;
      
      const response: TransactionTraceResponse = {
        transactionId: transaction.id,
        merchantName: transaction.merchantCleanName,
        amountCents: transaction.amountCents,
        transactionDate: dateStr,
        masterCategory: transaction.masterCategory,
        aiConfidenceScore: transaction.aiConfidenceScore,
        reasoningTrace: transaction.reasoningTrace,
        contextData: transaction.contextData,
        isSubscription: transaction.isSubscription,
        subscriptionDetails,
        userCorrectedCategory: transaction.userCorrectedCategory,
      };
      
      res.json(response);
    } catch (error: any) {
      console.error("[TransactionRoutes] Error fetching trace:", error);
      res.status(500).json({ message: error.message || "Failed to fetch transaction trace" });
    }
  });
  
  app.post("/api/transactions/:id/correct", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const transactionId = req.params.id;
      
      const validation = correctCategorySchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({ 
          message: "Invalid request body",
          errors: validation.error.errors 
        });
      }
      
      const { masterCategory, reason } = validation.data;
      
      const transaction = await storage.getEnrichedTransactionById(transactionId);
      
      if (!transaction) {
        return res.status(404).json({ message: "Transaction not found" });
      }
      
      if (transaction.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      const existingTrace = transaction.reasoningTrace || { 
        steps: [], 
        finalCategory: '', 
        finalConfidence: 0, 
        timestamp: new Date().toISOString() 
      };
      
      const updatedTrace: ReasoningTrace = {
        ...existingTrace,
        steps: [
          ...existingTrace.steps,
          {
            step: "User Correction",
            detail: `User corrected category to ${getMasterCategoryConfig(masterCategory).displayName}${reason ? `: ${reason}` : ''}`,
            confidence: 1.0,
          }
        ],
        finalCategory: masterCategory,
        finalConfidence: 1.0,
        timestamp: new Date().toISOString(),
      };
      
      const updated = await storage.updateEnrichedTransactionCategories(transactionId, {
        userCorrectedCategory: masterCategory,
        masterCategory: masterCategory,
        reasoningTrace: updatedTrace,
        aiConfidenceScore: 1.0,
      });
      
      if (!updated) {
        return res.status(500).json({ message: "Failed to update transaction" });
      }
      
      res.json({ 
        message: "Category corrected successfully",
        transaction: {
          id: updated.id,
          masterCategory: updated.masterCategory,
          userCorrectedCategory: updated.userCorrectedCategory,
        }
      });
    } catch (error: any) {
      console.error("[TransactionRoutes] Error correcting category:", error);
      res.status(500).json({ message: error.message || "Failed to correct category" });
    }
  });
  
  app.get("/api/subscriptions", requireAuth, async (req, res) => {
    try {
      const subscriptions = await storage.getAllSubscriptions();
      
      const response = subscriptions.map(sub => ({
        id: sub.id,
        productName: sub.productName,
        merchantName: sub.merchantName,
        amountCents: sub.amountCents,
        currency: sub.currency,
        recurrencePeriod: sub.recurrencePeriod,
        subscriptionType: sub.subscriptionType,
        category: sub.category,
        isVerified: sub.isVerified,
      }));
      
      res.json({ subscriptions: response });
    } catch (error: any) {
      console.error("[TransactionRoutes] Error fetching subscriptions:", error);
      res.status(500).json({ message: error.message || "Failed to fetch subscriptions" });
    }
  });
  
  app.get("/api/subscriptions/detected", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      const allTransactions = await storage.getEnrichedTransactionsByUserId(userId);
      const subscriptionTransactions = allTransactions.filter(tx => tx.isSubscription);
      
      const subscriptions = await storage.getAllSubscriptions();
      const subscriptionMap = new Map(subscriptions.map(s => [s.id, s]));
      
      const groupedBySubscription = new Map<string, EnrichedTransaction[]>();
      
      for (const tx of subscriptionTransactions) {
        const key = tx.subscriptionId || tx.merchantCleanName || tx.originalDescription;
        const existing = groupedBySubscription.get(key) || [];
        existing.push(tx);
        groupedBySubscription.set(key, existing);
      }
      
      const response: DetectedSubscriptionResponse[] = [];
      
      const entries = Array.from(groupedBySubscription.entries());
      for (const [key, transactions] of entries) {
        const latestTx = transactions.sort((a: EnrichedTransaction, b: EnrichedTransaction) => {
          const dateA = a.transactionDate ? new Date(a.transactionDate).getTime() : 0;
          const dateB = b.transactionDate ? new Date(b.transactionDate).getTime() : 0;
          return dateB - dateA;
        })[0];
        
        const subscription = latestTx.subscriptionId 
          ? subscriptionMap.get(latestTx.subscriptionId) 
          : null;
        
        const txDate = latestTx.transactionDate;
        const dateStr = txDate ? (typeof txDate === 'string' ? txDate : new Date(txDate).toISOString()) : null;
        
        response.push({
          transactionId: latestTx.id,
          merchantName: latestTx.merchantCleanName,
          merchantLogo: latestTx.merchantLogoUrl,
          productName: subscription?.productName || latestTx.merchantCleanName || 'Unknown',
          amountCents: latestTx.amountCents,
          frequency: subscription?.recurrencePeriod || latestTx.recurrenceFrequency,
          category: subscription?.category || latestTx.masterCategory,
          lastTransactionDate: dateStr,
          transactionCount: transactions.length,
        });
      }
      
      response.sort((a, b) => {
        const dateA = a.lastTransactionDate ? new Date(a.lastTransactionDate).getTime() : 0;
        const dateB = b.lastTransactionDate ? new Date(b.lastTransactionDate).getTime() : 0;
        return dateB - dateA;
      });
      
      res.json({ subscriptions: response });
    } catch (error: any) {
      console.error("[TransactionRoutes] Error fetching detected subscriptions:", error);
      res.status(500).json({ message: error.message || "Failed to fetch detected subscriptions" });
    }
  });
  
  app.get("/api/categories/master", requireAuth, async (req, res) => {
    try {
      const categories = getAllMasterCategories();
      
      const response: MasterCategoryResponse[] = categories.map(cat => {
        const config = getMasterCategoryConfig(cat);
        return {
          id: cat,
          displayName: config.displayName,
          icon: config.icon,
          color: config.color,
          description: config.description,
        };
      });
      
      res.json({ categories: response });
    } catch (error: any) {
      console.error("[TransactionRoutes] Error fetching master categories:", error);
      res.status(500).json({ message: error.message || "Failed to fetch categories" });
    }
  });

  // Phase 2: Subscription Detective - LangGraph Agent Integration
  app.post("/api/transactions/:id/classify-subscription", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const transactionId = req.params.id;
      
      const transaction = await storage.getEnrichedTransactionById(transactionId);
      
      if (!transaction) {
        return res.status(404).json({ message: "Transaction not found" });
      }
      
      if (transaction.userId !== userId) {
        return res.status(403).json({ message: "Access denied" });
      }
      
      // Call Python FastAPI subscription detective endpoint
      const pythonResponse = await fetch("http://127.0.0.1:8000/classify-subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          transaction_id: transactionId,
          merchant_name: transaction.merchantCleanName || transaction.originalDescription || "Unknown",
          amount_cents: transaction.amountCents,
          currency: "GBP",
          description: transaction.originalDescription,
        }),
      });
      
      if (!pythonResponse.ok) {
        const errorText = await pythonResponse.text();
        console.error("[TransactionRoutes] Python classify-subscription error:", errorText);
        return res.status(502).json({ message: "Subscription classification service unavailable" });
      }
      
      const classification = await pythonResponse.json();
      
      // Update transaction with classification results
      if (classification.is_subscription) {
        const existingTrace = transaction.reasoningTrace || { 
          steps: [], 
          finalCategory: '', 
          finalConfidence: 0, 
          timestamp: new Date().toISOString() 
        };
        
        const updatedTrace: ReasoningTrace = {
          ...existingTrace,
          steps: [
            ...existingTrace.steps,
            ...classification.reasoning_trace.map((step: { step: string; detail: string }) => ({
              step: step.step,
              detail: step.detail,
              confidence: classification.confidence,
            })),
          ],
          finalCategory: classification.is_subscription ? MasterCategory.SUBSCRIPTIONS : existingTrace.finalCategory,
          finalConfidence: classification.confidence,
          timestamp: new Date().toISOString(),
        };
        
        await storage.updateEnrichedTransactionCategories(transactionId, {
          isSubscription: classification.is_subscription,
          masterCategory: classification.is_subscription ? MasterCategory.SUBSCRIPTIONS : (transaction.masterCategory ?? undefined),
          aiConfidenceScore: classification.confidence,
          reasoningTrace: updatedTrace,
        });
      }
      
      res.json({
        transactionId: classification.transaction_id,
        isSubscription: classification.is_subscription,
        productName: classification.product_name,
        confidence: classification.confidence,
        reasoningTrace: classification.reasoning_trace,
      });
    } catch (error: any) {
      console.error("[TransactionRoutes] Error classifying subscription:", error);
      res.status(500).json({ message: error.message || "Failed to classify subscription" });
    }
  });
}
