import type { Express } from "express";
import { requireAuth } from "../auth";
import { storage } from "../storage";
import { getUpcomingBillsForCurrentMonth } from "../services/frequency-detection";
import type { UpcomingBill } from "@shared/schema";

export function registerProjectionsRoutes(app: Express): void {
  app.get("/api/projections/upcoming", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const patterns = await storage.getActiveRecurringPatternsByUserId(userId);

      const transactions = await storage.getEnrichedTransactionsByUserId(userId);

      const { upcomingBills, paidBills } = getUpcomingBillsForCurrentMonth(patterns, transactions);

      const today = new Date();
      const currentMonthEnd = new Date(today.getFullYear(), today.getMonth() + 1, 0);

      const totalUpcomingCents = upcomingBills.reduce((sum, bill) => sum + bill.amountCents, 0);
      const totalPaidCents = paidBills.reduce((sum, bill) => sum + bill.amountCents, 0);

      return res.json({
        upcomingBills: upcomingBills as UpcomingBill[],
        paidBills: paidBills as UpcomingBill[],
        summary: {
          totalUpcomingCount: upcomingBills.length,
          totalPaidCount: paidBills.length,
          totalUpcomingCents,
          totalPaidCents,
          monthEndDate: currentMonthEnd.toISOString().split('T')[0],
        },
      });
    } catch (error: any) {
      console.error("[Projections] Error fetching upcoming bills:", error);
      return res.status(500).json({ error: error.message || "Failed to fetch upcoming bills" });
    }
  });

  app.get("/api/projections/patterns", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const patterns = await storage.getRecurringPatternsByUserId(userId);

      return res.json({
        patterns,
        totalCount: patterns.length,
        activeCount: patterns.filter(p => p.isActive).length,
      });
    } catch (error: any) {
      console.error("[Projections] Error fetching recurring patterns:", error);
      return res.status(500).json({ error: error.message || "Failed to fetch recurring patterns" });
    }
  });

  app.delete("/api/projections/patterns/:id", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;

      const pattern = await storage.getRecurringPatternById(id);
      if (!pattern) {
        return res.status(404).json({ error: "Pattern not found" });
      }
      if (pattern.userId !== userId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      await storage.deleteRecurringPattern(id);

      return res.json({ success: true });
    } catch (error: any) {
      console.error("[Projections] Error deleting pattern:", error);
      return res.status(500).json({ error: error.message || "Failed to delete pattern" });
    }
  });

  app.patch("/api/projections/patterns/:id/deactivate", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any)?.id;
      if (!userId) {
        return res.status(401).json({ error: "Unauthorized" });
      }

      const { id } = req.params;

      const pattern = await storage.getRecurringPatternById(id);
      if (!pattern) {
        return res.status(404).json({ error: "Pattern not found" });
      }
      if (pattern.userId !== userId) {
        return res.status(403).json({ error: "Forbidden" });
      }

      const updated = await storage.updateRecurringPattern(id, { isActive: false });

      return res.json({ pattern: updated });
    } catch (error: any) {
      console.error("[Projections] Error deactivating pattern:", error);
      return res.status(500).json({ error: error.message || "Failed to deactivate pattern" });
    }
  });
}
