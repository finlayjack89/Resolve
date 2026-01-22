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
  fetchCards,
  fetchCardBalance,
  fetchCardTransactions,
  encryptToken,
  decryptToken,
  ConnectionType,
} from "../truelayer";
import { z } from "zod";

const REDIRECT_URI = process.env.TRUELAYER_REDIRECT_URI || 
  `${process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:5000'}/api/truelayer/callback`;

// Helper function to convert TrueLayer error codes to user-friendly messages
function getReadableErrorMessage(errorCode: string): string {
  const errorMessages: Record<string, string> = {
    "access_denied": "Connection was cancelled or denied. Please try again.",
    "invalid_scope": "This provider doesn't support the requested data access. Please try a different provider.",
    "endpoint_not_supported": "This provider doesn't support credit card data. Please select a credit card provider.",
    "sca_exceeded": "Security verification expired. Please reconnect to continue.",
    "consent_revoked": "Bank connection was revoked. Please reconnect your account.",
    "provider_error": "There was a problem with the bank. Please try again later.",
    "server_error": "Connection failed. Please try again.",
    "temporarily_unavailable": "This provider is temporarily unavailable. Please try again later.",
    "user_cancelled": "Connection was cancelled. Please try again when ready.",
    "no_accounts": "No accounts found with this provider.",
    "missing_code": "Authentication failed. Please try again.",
    "session_expired": "Your session expired. Please log in and try again.",
  };
  
  return errorMessages[errorCode] || `Connection failed: ${errorCode}. Please try again.`;
}

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
      const connectionType = (req.query.connectionType as ConnectionType) || "current_account";
      const providerId = req.query.providerId as string | undefined;
      
      console.log("[TrueLayer] Auth URL request from user:", userId, "connectionType:", connectionType);
      
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

      // Include return URL and connectionType in state for proper handling in callback
      const returnUrl = req.query.returnUrl as string || "/budget";
      const state = Buffer.from(JSON.stringify({ userId, returnUrl, connectionType })).toString("base64");
      const authUrl = generateAuthUrl(REDIRECT_URI, state, connectionType, providerId);

      console.log("[TrueLayer] Generated auth URL successfully for", connectionType, "redirect URI:", REDIRECT_URI);
      
      res.json({ authUrl, redirectUri: REDIRECT_URI, connectionType });
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
    
    // Extract returnUrl and connectionType from state early so it's available in catch block
    let returnUrl: string = "/budget";
    let userId: string | null = null;
    let connectionType: ConnectionType = "current_account";
    
    if (state && typeof state === "string") {
      try {
        const decoded = JSON.parse(Buffer.from(state, "base64").toString());
        userId = decoded.userId;
        returnUrl = decoded.returnUrl || "/budget";
        connectionType = decoded.connectionType || "current_account";
      } catch (e) {
        console.error("[TrueLayer] Failed to decode state:", e);
      }
    }
    
    try {
      if (authError) {
        console.error("[TrueLayer] Auth callback error:", authError);
        const errorMessage = getReadableErrorMessage(String(authError));
        return res.redirect(`${returnUrl}?error=${encodeURIComponent(errorMessage)}`);
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

      let newAccountsCreated = 0;
      let existingAccountsUpdated = 0;
      let processedAccountIds: string[] = [];

      // Handle differently based on connection type
      if (connectionType === "credit_card") {
        // CREDIT CARD CONNECTION - use /cards endpoint
        console.log(`[TrueLayer] Processing credit card connection for user ${userId}`);
        
        const cardsResponse = await fetchCards(accessToken);
        
        if (!cardsResponse.results || cardsResponse.results.length === 0) {
          console.log("[TrueLayer] No credit cards returned from TrueLayer");
          return res.redirect(`${returnUrl}?error=${encodeURIComponent("No credit cards found with this provider. Please check you selected the correct provider for your credit card.")}`);
        }

        console.log(`[TrueLayer] Found ${cardsResponse.results.length} credit cards for user ${userId}`);

        // Process each card
        for (const card of cardsResponse.results) {
          const trueLayerAccountId = card.account_id;
          const institutionName = card.provider?.display_name || "Unknown Issuer";
          const accountName = card.display_name || "Credit Card";
          const currency = card.currency || "GBP";

          // Fetch balance for this card
          let currentBalanceCents: number | null = null;
          let availableCreditCents: number | null = null;
          let creditLimitCents: number | null = null;
          
          try {
            const balanceResponse = await fetchCardBalance(accessToken, trueLayerAccountId);
            if (balanceResponse.results && balanceResponse.results.length > 0) {
              const balance = balanceResponse.results[0];
              // Safely convert to cents with null checks to avoid NaN
              if (typeof balance.current === 'number' && !isNaN(balance.current)) {
                currentBalanceCents = Math.round(balance.current * 100);
              }
              if (typeof balance.available === 'number' && !isNaN(balance.available)) {
                availableCreditCents = Math.round(balance.available * 100);
              }
              if (typeof balance.credit_limit === 'number' && !isNaN(balance.credit_limit)) {
                creditLimitCents = Math.round(balance.credit_limit * 100);
              } else if (currentBalanceCents !== null && availableCreditCents !== null) {
                // Calculate credit limit from current + available if not provided
                creditLimitCents = currentBalanceCents + availableCreditCents;
              }
            }
          } catch (balanceError) {
            console.log(`[TrueLayer] Could not fetch balance for card ${trueLayerAccountId}:`, balanceError);
          }

          // Check if this specific card already exists for this user
          const existingItem = await storage.getTrueLayerItemByAccountId(userId as string, trueLayerAccountId);

          if (existingItem) {
            // Update existing card with new tokens - set to STAGED for batch processing
            await storage.updateTrueLayerItem(existingItem.id, {
              accessTokenEncrypted: encryptToken(accessToken),
              refreshTokenEncrypted: tokenResponse.refresh_token 
                ? encryptToken(tokenResponse.refresh_token) 
                : existingItem.refreshTokenEncrypted,
              consentExpiresAt,
              connectionStatus: "active",
              connectionError: null,
              processingStatus: "STAGED",
              institutionName,
              accountName,
              accountType: "credit_card",
              connectionType: "credit_card",
              currency,
              cardNetwork: card.card_network || null,
              partialPan: card.partial_card_number || null,
              cardType: card.card_type || null,
              currentBalanceCents,
              availableCreditCents,
              creditLimitCents,
            });
            existingAccountsUpdated++;
            processedAccountIds.push(trueLayerAccountId);
            console.log(`[TrueLayer] Updated existing credit card: ${institutionName} - ${accountName} (****${card.partial_card_number || "????"})`);
            
            try {
              await storage.deleteEnrichedTransactionsByItemId(existingItem.id);
            } catch (e) {
              // Ignore if no transactions to clear
            }
          } else {
            // Create new TrueLayerItem for this card - set to STAGED for batch processing
            await storage.createTrueLayerItem({
              userId: userId as string,
              trueLayerAccountId,
              institutionName,
              accountName,
              accountType: "credit_card",
              connectionType: "credit_card",
              currency,
              cardNetwork: card.card_network || null,
              partialPan: card.partial_card_number || null,
              cardType: card.card_type || null,
              currentBalanceCents,
              availableCreditCents,
              creditLimitCents,
              accessTokenEncrypted: encryptToken(accessToken),
              refreshTokenEncrypted: tokenResponse.refresh_token 
                ? encryptToken(tokenResponse.refresh_token) 
                : null,
              consentExpiresAt,
              provider: card.provider?.provider_id || null,
              lastSyncedAt: null,
              connectionStatus: "active",
              connectionError: null,
              processingStatus: "STAGED",
            });
            newAccountsCreated++;
            processedAccountIds.push(trueLayerAccountId);
            console.log(`[TrueLayer] Created new credit card: ${institutionName} - ${accountName} (****${card.partial_card_number || "????"})`);
          }
        }

        console.log(`[TrueLayer] Credit card callback complete for user ${userId}: ${newAccountsCreated} new, ${existingAccountsUpdated} updated`);

      } else {
        // CURRENT ACCOUNT CONNECTION - use /accounts endpoint (existing logic)
        console.log(`[TrueLayer] Processing current account connection for user ${userId}`);
        
        const accountsResponse = await fetchAccounts(accessToken);
        
        if (!accountsResponse.results || accountsResponse.results.length === 0) {
          console.log("[TrueLayer] No accounts returned from TrueLayer");
          return res.redirect(`${returnUrl}?error=${encodeURIComponent("No current accounts found with this provider.")}`);
        }

        console.log(`[TrueLayer] Found ${accountsResponse.results.length} accounts for user ${userId}`);

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
            // Update existing account with new tokens - set to STAGED for batch processing
            await storage.updateTrueLayerItem(existingItem.id, {
              accessTokenEncrypted: encryptToken(accessToken),
              refreshTokenEncrypted: tokenResponse.refresh_token 
                ? encryptToken(tokenResponse.refresh_token) 
                : existingItem.refreshTokenEncrypted,
              consentExpiresAt,
              connectionStatus: "active",
              connectionError: null,
              processingStatus: "STAGED",
              institutionName,
              accountName,
              accountType,
              connectionType: "current_account",
              currency,
            });
            existingAccountsUpdated++;
            processedAccountIds.push(trueLayerAccountId);
            console.log(`[TrueLayer] Updated existing account: ${institutionName} - ${accountName}`);
            
            try {
              await storage.deleteEnrichedTransactionsByItemId(existingItem.id);
            } catch (e) {
              // Ignore if no transactions to clear
            }
          } else {
            // Create new TrueLayerItem for this account - set to STAGED for batch processing
            await storage.createTrueLayerItem({
              userId: userId as string,
              trueLayerAccountId,
              institutionName,
              accountName,
              accountType,
              connectionType: "current_account",
              currency,
              accessTokenEncrypted: encryptToken(accessToken),
              refreshTokenEncrypted: tokenResponse.refresh_token 
                ? encryptToken(tokenResponse.refresh_token) 
                : null,
              consentExpiresAt,
              provider: account.provider?.provider_id || null,
              lastSyncedAt: null,
              connectionStatus: "active",
              connectionError: null,
              processingStatus: "STAGED",
            });
            newAccountsCreated++;
            processedAccountIds.push(trueLayerAccountId);
            console.log(`[TrueLayer] Created new account: ${institutionName} - ${accountName}`);
          }
        }

        console.log(`[TrueLayer] Callback complete for user ${userId}: ${newAccountsCreated} new, ${existingAccountsUpdated} updated`);
      }

      // STAGED ONBOARDING: Do NOT fetch transactions here
      // Transaction fetching is now deferred to the batch initialization endpoint
      // This allows users to connect multiple accounts before triggering analysis
      console.log(`[TrueLayer] Staged onboarding: ${processedAccountIds.length} accounts ready for batch initialization`);

      res.redirect(`${returnUrl}?connected=true&type=${connectionType}`);
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

      // Map accounts with their status (including credit card specific info)
      const accounts = items.map(item => {
        const isExpired = item.consentExpiresAt && 
          new Date(item.consentExpiresAt) < new Date();
        
        return {
          id: item.id,
          institutionName: item.institutionName,
          accountName: item.accountName,
          accountType: item.accountType,
          connectionType: item.connectionType || "current_account",
          currency: item.currency,
          lastSynced: item.lastSyncedAt,
          consentExpires: item.consentExpiresAt,
          needsReauth: isExpired,
          connectionStatus: isExpired ? "expired" : (item.connectionStatus || "active"),
          connectionError: item.connectionError,
          isSideHustle: item.isSideHustle,
          processingStatus: item.processingStatus || "STAGED",
          // Credit card specific fields
          cardNetwork: item.cardNetwork,
          partialPan: item.partialPan,
          cardType: item.cardType,
          currentBalanceCents: item.currentBalanceCents,
          availableCreditCents: item.availableCreditCents,
          creditLimitCents: item.creditLimitCents,
        };
      });

      const anyActive = accounts.some(a => 
        a.connectionStatus === "active" || 
        a.connectionStatus === "connected" || 
        a.connectionStatus === "pending_enrichment"
      );
      const anyNeedsReauth = accounts.some(a => a.needsReauth);

      const stagedCount = accounts.filter(a => a.processingStatus === "STAGED").length;
      const analyzingCount = accounts.filter(a => a.processingStatus === "ANALYZING").length;
      const activeCount = accounts.filter(a => a.processingStatus === "ACTIVE").length;
      const errorCount = accounts.filter(a => a.processingStatus === "ERROR").length;

      res.json({
        connected: anyActive,
        accounts,
        needsReauth: anyNeedsReauth,
        totalAccounts: accounts.length,
        stagedCount,
        analyzingCount,
        activeCount,
        errorCount,
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
        true // useDynamicRange
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
