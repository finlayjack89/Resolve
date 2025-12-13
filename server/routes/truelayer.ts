import type { Express } from "express";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import {
  generateAuthUrl,
  exchangeCodeForToken,
  refreshAccessToken,
  fetchAccounts,
  fetchAccountBalance,
  fetchAllTransactions,
  fetchAllDirectDebits,
  fetchTransactions,
  fetchDirectDebits,
  encryptToken,
  decryptToken,
} from "../truelayer";
import { z } from "zod";

const REDIRECT_URI = process.env.TRUELAYER_REDIRECT_URI || 
  `${process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:5000'}/api/truelayer/callback`;

export function registerTrueLayerRoutes(app: Express) {
  // Log TrueLayer configuration on startup
  console.log("[TrueLayer] Configuration check:", {
    hasClientId: !!process.env.TRUELAYER_CLIENT_ID,
    hasClientSecret: !!process.env.TRUELAYER_CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
  });

  app.get("/api/truelayer/auth-url", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      console.log("[TrueLayer] Auth URL request from user:", userId);
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Bank connection is not available for guest users. Please create an account." 
        });
      }

      // Check if TrueLayer is configured
      if (!process.env.TRUELAYER_CLIENT_ID || !process.env.TRUELAYER_CLIENT_SECRET) {
        console.error("[TrueLayer] Missing credentials - CLIENT_ID:", !!process.env.TRUELAYER_CLIENT_ID, "CLIENT_SECRET:", !!process.env.TRUELAYER_CLIENT_SECRET);
        return res.status(500).json({
          message: "TrueLayer is not configured. Please add TRUELAYER_CLIENT_ID and TRUELAYER_CLIENT_SECRET to your secrets.",
        });
      }

      // Include return URL in state for proper redirect after OAuth
      const returnUrl = req.query.returnUrl as string || "/budget";
      const state = Buffer.from(JSON.stringify({ userId, returnUrl })).toString("base64");
      const authUrl = generateAuthUrl(REDIRECT_URI, state);

      console.log("[TrueLayer] Generated auth URL successfully, redirect URI:", REDIRECT_URI);
      
      res.json({ authUrl, redirectUri: REDIRECT_URI });
    } catch (error: any) {
      console.error("[TrueLayer] Error generating auth URL:", error);
      res.status(500).json({ 
        message: "Failed to generate authentication URL",
        error: error.message 
      });
    }
  });

  // OAuth callback - now creates/updates per-account TrueLayerItems
  app.get("/api/truelayer/callback", async (req, res) => {
    const { code, state, error: authError } = req.query;
    
    // Extract returnUrl from state early so it's available in catch block
    let returnUrl: string = "/budget";
    let userId: string | null = null;
    if (state && typeof state === "string") {
      try {
        const decoded = JSON.parse(Buffer.from(state, "base64").toString());
        userId = decoded.userId;
        returnUrl = decoded.returnUrl || "/budget";
      } catch (e) {
        console.error("[TrueLayer] Failed to decode state:", e);
      }
    }
    
    try {
      if (authError) {
        console.error("[TrueLayer] Auth callback error:", authError);
        return res.redirect(`${returnUrl}?error=${encodeURIComponent(String(authError))}`);
      }

      if (!code || typeof code !== "string") {
        return res.redirect(`${returnUrl}?error=missing_code`);
      }

      if (!userId) {
        const sessionUser = req.user as any;
        if (sessionUser?.id) {
          userId = sessionUser.id;
        } else {
          return res.redirect("/budget?error=session_expired");
        }
      }

      // Exchange authorization code for tokens
      const tokenResponse = await exchangeCodeForToken(code, REDIRECT_URI);
      const accessToken = tokenResponse.access_token;

      const consentExpiresAt = new Date(
        Date.now() + tokenResponse.expires_in * 1000
      );

      // Fetch accounts from TrueLayer to get account details
      const accountsResponse = await fetchAccounts(accessToken);
      
      if (!accountsResponse.results || accountsResponse.results.length === 0) {
        console.log("[TrueLayer] No accounts returned from TrueLayer");
        return res.redirect("/budget?error=no_accounts");
      }

      console.log(`[TrueLayer] Found ${accountsResponse.results.length} accounts for user ${userId}`);

      let newAccountsCreated = 0;
      let existingAccountsUpdated = 0;

      // Process each account - create or update TrueLayerItem per account
      for (const account of accountsResponse.results) {
        const trueLayerAccountId = account.account_id;
        const institutionName = account.provider?.display_name || "Unknown Bank";
        const accountName = account.display_name || "Current Account";
        const accountType = account.account_type || "current";
        const currency = account.currency || "GBP";

        // Check if this specific account already exists for this user
        const existingItem = await storage.getTrueLayerItemByAccountId(userId as string, trueLayerAccountId);

        if (existingItem) {
          // Update existing account with new tokens
          await storage.updateTrueLayerItem(existingItem.id, {
            accessTokenEncrypted: encryptToken(accessToken),
            refreshTokenEncrypted: tokenResponse.refresh_token 
              ? encryptToken(tokenResponse.refresh_token) 
              : existingItem.refreshTokenEncrypted,
            consentExpiresAt,
            lastSyncedAt: new Date(),
            connectionStatus: "active",
            // Update institution info in case it changed
            institutionName,
            accountName,
            accountType,
            currency,
          });
          existingAccountsUpdated++;
          console.log(`[TrueLayer] Updated existing account: ${institutionName} - ${accountName}`);
          
          // Clear cached enriched transactions for this account on reconnect
          try {
            await storage.deleteEnrichedTransactionsByItemId(existingItem.id);
          } catch (e) {
            // Ignore if no transactions to clear
          }
        } else {
          // Create new TrueLayerItem for this account
          await storage.createTrueLayerItem({
            userId: userId as string,
            trueLayerAccountId,
            institutionName,
            accountName,
            accountType,
            currency,
            accessTokenEncrypted: encryptToken(accessToken),
            refreshTokenEncrypted: tokenResponse.refresh_token 
              ? encryptToken(tokenResponse.refresh_token) 
              : null,
            consentExpiresAt,
            provider: account.provider?.provider_id || null,
            lastSyncedAt: new Date(),
            connectionStatus: "active",
          });
          newAccountsCreated++;
          console.log(`[TrueLayer] Created new account: ${institutionName} - ${accountName}`);
        }
      }

      console.log(`[TrueLayer] Callback complete for user ${userId}: ${newAccountsCreated} new, ${existingAccountsUpdated} updated`);

      res.redirect(`${returnUrl}?connected=true`);
    } catch (error: any) {
      console.error("[TrueLayer] Callback error:", error);
      res.redirect(`${returnUrl}?error=${encodeURIComponent(error.message)}`);
    }
  });

  // Status endpoint - now returns all connected accounts
  app.get("/api/truelayer/status", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      if (userId === "guest-user") {
        return res.json({ 
          connected: false,
          accounts: [],
          message: "Guest users cannot connect bank accounts"
        });
      }

      // Get all TrueLayer items for this user
      const items = await storage.getTrueLayerItemsByUserId(userId);
      
      if (!items || items.length === 0) {
        return res.json({ 
          connected: false,
          accounts: []
        });
      }

      // Map accounts with their status
      const accounts = items.map(item => {
        const isExpired = item.consentExpiresAt && 
          new Date(item.consentExpiresAt) < new Date();
        
        return {
          id: item.id,
          institutionName: item.institutionName,
          accountName: item.accountName,
          accountType: item.accountType,
          currency: item.currency,
          lastSynced: item.lastSyncedAt,
          consentExpires: item.consentExpiresAt,
          needsReauth: isExpired,
          connectionStatus: isExpired ? "expired" : (item.connectionStatus || "active"),
          isSideHustle: item.isSideHustle,
        };
      });

      const anyActive = accounts.some(a => a.connectionStatus === "active");
      const anyNeedsReauth = accounts.some(a => a.needsReauth);

      res.json({
        connected: anyActive,
        accounts,
        needsReauth: anyNeedsReauth,
        totalAccounts: accounts.length,
      });
    } catch (error: any) {
      console.error("[TrueLayer] Status check error:", error);
      res.status(500).json({ 
        message: "Failed to check connection status",
        error: error.message 
      });
    }
  });

  // Disconnect all accounts (legacy behavior)
  app.post("/api/truelayer/disconnect", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Guest users cannot disconnect bank accounts" 
        });
      }

      await storage.deleteTrueLayerItem(userId);
      
      res.json({ 
        success: true, 
        message: "All bank connections removed successfully" 
      });
    } catch (error: any) {
      console.error("[TrueLayer] Disconnect error:", error);
      res.status(500).json({ 
        message: "Failed to disconnect bank",
        error: error.message 
      });
    }
  });

  // Disconnect a specific account by ID
  app.post("/api/truelayer/disconnect/:accountId", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { accountId } = req.params;
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Guest users cannot disconnect bank accounts" 
        });
      }

      // Verify the account belongs to this user
      const item = await storage.getTrueLayerItemById(accountId);
      if (!item || item.userId !== userId) {
        return res.status(404).json({ 
          message: "Account not found" 
        });
      }

      // Delete the TrueLayer item (transactions are now cascade-deleted in storage layer)
      await storage.deleteTrueLayerItemById(accountId);
      
      res.json({ 
        success: true, 
        message: `Disconnected ${item.institutionName} - ${item.accountName}` 
      });
    } catch (error: any) {
      console.error("[TrueLayer] Disconnect account error:", error);
      res.status(500).json({ 
        message: "Failed to disconnect account",
        error: error.message 
      });
    }
  });

  // Get accounts from TrueLayer (live fetch with balances)
  app.get("/api/truelayer/accounts", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Guest users cannot access bank accounts" 
        });
      }

      // Get all TrueLayer items for this user
      const items = await storage.getTrueLayerItemsByUserId(userId);
      
      if (!items || items.length === 0) {
        return res.status(404).json({ 
          message: "No bank accounts connected. Please connect your bank first." 
        });
      }

      // Use the first item's token (all items from same consent have same token)
      const firstItem = items[0];
      let accessToken = decryptToken(firstItem.accessTokenEncrypted);

      const isExpired = firstItem.consentExpiresAt && 
        new Date(firstItem.consentExpiresAt) < new Date();

      if (isExpired && firstItem.refreshTokenEncrypted) {
        try {
          const refreshToken = decryptToken(firstItem.refreshTokenEncrypted);
          const newTokens = await refreshAccessToken(refreshToken);
          
          accessToken = newTokens.access_token;
          
          // Update all items with new tokens
          for (const item of items) {
            await storage.updateTrueLayerItem(item.id, {
              accessTokenEncrypted: encryptToken(newTokens.access_token),
              refreshTokenEncrypted: newTokens.refresh_token 
                ? encryptToken(newTokens.refresh_token) 
                : item.refreshTokenEncrypted,
              consentExpiresAt: new Date(Date.now() + newTokens.expires_in * 1000),
              connectionStatus: "active",
            });
          }
        } catch (refreshError) {
          console.error("[TrueLayer] Token refresh failed:", refreshError);
          // Mark all items as expired
          for (const item of items) {
            await storage.updateTrueLayerItem(item.id, {
              connectionStatus: "expired",
            });
          }
          return res.status(401).json({ 
            message: "Bank connection expired. Please reconnect your bank.",
            needsReauth: true 
          });
        }
      }

      const accountsResponse = await fetchAccounts(accessToken);

      const accountsWithBalance = await Promise.all(
        accountsResponse.results.map(async (account) => {
          try {
            const balanceResponse = await fetchAccountBalance(
              accessToken,
              account.account_id
            );
            
            // Find the corresponding TrueLayerItem
            const dbItem = items.find(i => i.trueLayerAccountId === account.account_id);
            
            return {
              ...account,
              balance: balanceResponse.results[0],
              dbItemId: dbItem?.id,
              isSideHustle: dbItem?.isSideHustle,
            };
          } catch (e) {
            return account;
          }
        })
      );

      // Update lastSyncedAt for all items
      for (const item of items) {
        await storage.updateTrueLayerItem(item.id, {
          lastSyncedAt: new Date(),
        });
      }

      res.json({
        success: true,
        accounts: accountsWithBalance,
      });
    } catch (error: any) {
      console.error("[TrueLayer] Fetch accounts error:", error);
      res.status(500).json({ 
        message: "Failed to fetch bank accounts",
        error: error.message 
      });
    }
  });

  // Sync transactions for a specific account
  app.post("/api/truelayer/sync-transactions/:accountId", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { accountId } = req.params;
      const { days = 90 } = req.body;
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Guest users cannot sync transactions" 
        });
      }

      // Get the specific TrueLayer item
      const item = await storage.getTrueLayerItemById(accountId);
      
      if (!item || item.userId !== userId) {
        return res.status(404).json({ 
          message: "Account not found" 
        });
      }

      let accessToken = decryptToken(item.accessTokenEncrypted);

      const now = new Date();
      const fromDate = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      const from = fromDate.toISOString().split("T")[0];
      const to = now.toISOString().split("T")[0];

      // Fetch transactions for this specific account
      const txResponse = await fetchTransactions(accessToken, item.trueLayerAccountId, from, to);
      const transactions = txResponse.results;
      
      // Fetch direct debits for this account
      let directDebits: any[] = [];
      try {
        const ddResponse = await fetchDirectDebits(accessToken, item.trueLayerAccountId);
        directDebits = ddResponse.results;
      } catch (e) {
        console.log(`[TrueLayer] Could not fetch direct debits for ${item.accountName}`);
      }

      await storage.updateTrueLayerItem(item.id, {
        lastSyncedAt: new Date(),
      });

      console.log(`[TrueLayer] Synced ${transactions.length} transactions and ${directDebits.length} direct debits for ${item.institutionName} - ${item.accountName}`);

      res.json({
        success: true,
        accountId: item.id,
        accountName: `${item.institutionName} - ${item.accountName}`,
        transactionCount: transactions.length,
        directDebitCount: directDebits.length,
        transactions,
        directDebits,
      });
    } catch (error: any) {
      console.error("[TrueLayer] Sync transactions error:", error);
      res.status(500).json({ 
        message: "Failed to sync transactions",
        error: error.message 
      });
    }
  });

  // Sync transactions for all accounts (legacy endpoint)
  app.post("/api/truelayer/sync-transactions", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { days = 90 } = req.body;
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Guest users cannot sync transactions" 
        });
      }

      const items = await storage.getTrueLayerItemsByUserId(userId);
      
      if (!items || items.length === 0) {
        return res.status(404).json({ 
          message: "No bank accounts connected. Please connect your bank first." 
        });
      }

      // Use first item's token (same consent = same token)
      let accessToken = decryptToken(items[0].accessTokenEncrypted);

      const transactions = await fetchAllTransactions(
        accessToken, 
        Math.min(Math.max(days, 30), 365)
      );
      
      const directDebits = await fetchAllDirectDebits(accessToken);

      // Update lastSyncedAt for all items
      for (const item of items) {
        await storage.updateTrueLayerItem(item.id, {
          lastSyncedAt: new Date(),
        });
      }

      console.log(`[TrueLayer] Synced ${transactions.length} transactions and ${directDebits.length} direct debits for user ${userId}`);

      res.json({
        success: true,
        transactionCount: transactions.length,
        directDebitCount: directDebits.length,
        transactions,
        directDebits,
      });
    } catch (error: any) {
      console.error("[TrueLayer] Sync transactions error:", error);
      res.status(500).json({ 
        message: "Failed to sync transactions",
        error: error.message 
      });
    }
  });

  // Update account preferences (e.g., isSideHustle flag)
  app.patch("/api/truelayer/account/:accountId", requireAuth, async (req, res) => {
    try {
      const userId = (req.user as any).id;
      const { accountId } = req.params;
      const { isSideHustle } = req.body;
      
      if (userId === "guest-user") {
        return res.status(403).json({ 
          message: "Guest users cannot update account settings" 
        });
      }

      // Verify the account belongs to this user
      const item = await storage.getTrueLayerItemById(accountId);
      if (!item || item.userId !== userId) {
        return res.status(404).json({ 
          message: "Account not found" 
        });
      }

      const updates: any = {};
      if (typeof isSideHustle === "boolean") {
        updates.isSideHustle = isSideHustle;
      }

      const updated = await storage.updateTrueLayerItem(accountId, updates);
      
      res.json({ 
        success: true,
        account: {
          id: updated?.id,
          institutionName: updated?.institutionName,
          accountName: updated?.accountName,
          isSideHustle: updated?.isSideHustle,
        }
      });
    } catch (error: any) {
      console.error("[TrueLayer] Update account error:", error);
      res.status(500).json({ 
        message: "Failed to update account",
        error: error.message 
      });
    }
  });
}
