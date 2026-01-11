import { encryptToken, decryptToken } from "./encryption";

const TRUELAYER_CLIENT_ID = process.env.TRUELAYER_CLIENT_ID;
const TRUELAYER_CLIENT_SECRET = process.env.TRUELAYER_CLIENT_SECRET;

// Environment detection for sandbox vs production
const IS_PRODUCTION = process.env.NODE_ENV === "production";

// Production mode - use real TrueLayer endpoints
// Set USE_TRUELAYER_SANDBOX=true in environment to test with Mock Bank
const USE_SANDBOX = process.env.USE_TRUELAYER_SANDBOX === "true";

// TrueLayer endpoints - using sandbox for Mock Bank testing
const AUTH_URL = USE_SANDBOX 
  ? "https://auth.truelayer-sandbox.com" 
  : "https://auth.truelayer.com";
const API_URL = USE_SANDBOX 
  ? "https://api.truelayer-sandbox.com" 
  : "https://api.truelayer.com";

// Provider selection - real UK banks for production, mock bank for sandbox testing
const CURRENT_ACCOUNT_PROVIDERS = USE_SANDBOX ? "uk-cs-mock" : "uk-ob-all uk-oauth-all";

// Credit card specific providers - these support the cards scope
const CREDIT_CARD_PROVIDERS = USE_SANDBOX 
  ? "uk-cs-mock" 
  : "uk-ob-all uk-oauth-all";

// Scopes for different connection types
const CURRENT_ACCOUNT_SCOPES = "accounts balance transactions direct_debits offline_access";
const CREDIT_CARD_SCOPES = "cards balance transactions offline_access";

export interface TrueLayerTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
  scope?: string;
}

export interface TrueLayerAccountResponse {
  results: Array<{
    account_id: string;
    account_type: string;
    display_name: string;
    currency: string;
    account_number?: {
      iban?: string;
      number?: string;
      sort_code?: string;
    };
    provider?: {
      display_name?: string;
      provider_id?: string;
    };
  }>;
}

export interface TrueLayerBalanceResponse {
  results: Array<{
    currency: string;
    available: number;
    current: number;
    overdraft?: number;
    update_timestamp: string;
  }>;
}

export interface TrueLayerTransactionResponse {
  results: Array<{
    transaction_id: string;
    timestamp: string;
    description: string;
    amount: number;
    currency: string;
    transaction_type: string;
    transaction_category: string;
    transaction_classification: string[];
    merchant_name?: string;
    running_balance?: {
      amount: number;
      currency: string;
    };
    meta?: {
      bank_transaction_id?: string;
      provider_category?: string;
    };
  }>;
}

export interface TrueLayerDirectDebitResponse {
  results: Array<{
    direct_debit_id: string;
    name: string;
    status: string;
    previous_payment_date?: string;
    previous_payment_amount?: number;
    currency?: string;
  }>;
}

export type ConnectionType = "current_account" | "credit_card";

export function generateAuthUrl(
  redirectUri: string, 
  state?: string, 
  connectionType: ConnectionType = "current_account",
  providerId?: string
): string {
  if (!TRUELAYER_CLIENT_ID) {
    throw new Error("TRUELAYER_CLIENT_ID environment variable is not set");
  }

  const isCard = connectionType === "credit_card";
  const scopes = isCard ? CREDIT_CARD_SCOPES : CURRENT_ACCOUNT_SCOPES;
  const providers = providerId || (isCard ? CREDIT_CARD_PROVIDERS : CURRENT_ACCOUNT_PROVIDERS);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: TRUELAYER_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: scopes,
    providers: providers,
  });

  if (state) {
    params.append("state", state);
  }

  console.log(`[TrueLayer] Generating ${connectionType} auth URL with providers: ${providers}, scopes: ${scopes}, mode: ${USE_SANDBOX ? 'sandbox' : 'live'}`);
  
  return `${AUTH_URL}/?${params.toString()}`;
}

export async function exchangeCodeForToken(
  code: string,
  redirectUri: string
): Promise<TrueLayerTokenResponse> {
  if (!TRUELAYER_CLIENT_ID || !TRUELAYER_CLIENT_SECRET) {
    throw new Error("TrueLayer credentials are not configured");
  }

  const response = await fetch(`${AUTH_URL}/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: TRUELAYER_CLIENT_ID,
      client_secret: TRUELAYER_CLIENT_SECRET,
      redirect_uri: redirectUri,
      code,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Token exchange failed:", errorData);
    throw new Error(`Token exchange failed: ${response.status}`);
  }

  return response.json();
}

export async function refreshAccessToken(
  refreshToken: string
): Promise<TrueLayerTokenResponse> {
  if (!TRUELAYER_CLIENT_ID || !TRUELAYER_CLIENT_SECRET) {
    throw new Error("TrueLayer credentials are not configured");
  }

  const response = await fetch(`${AUTH_URL}/connect/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: TRUELAYER_CLIENT_ID,
      client_secret: TRUELAYER_CLIENT_SECRET,
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Token refresh failed:", errorData);
    throw new Error(`Token refresh failed: ${response.status}`);
  }

  return response.json();
}

export async function fetchAccounts(
  accessToken: string
): Promise<TrueLayerAccountResponse> {
  const response = await fetch(`${API_URL}/data/v1/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch accounts failed:", errorData);
    throw new Error(`Failed to fetch accounts: ${response.status}`);
  }

  return response.json();
}

export async function fetchAccountBalance(
  accessToken: string,
  accountId: string
): Promise<TrueLayerBalanceResponse> {
  const response = await fetch(
    `${API_URL}/data/v1/accounts/${accountId}/balance`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch balance failed:", errorData);
    throw new Error(`Failed to fetch balance: ${response.status}`);
  }

  return response.json();
}

/**
 * Calculate the dynamic date range for fetching transactions.
 * Returns the 1st of the 4th month ago to today, giving us 3 complete months + current MTD.
 * 
 * Example for Dec 13th:
 * - Dynamic from: Sept 1st
 * - Dynamic to: Dec 13th
 * - Gives: 3 complete months (Sept, Oct, Nov) + partial December as "MTD"
 */
export function calculateDynamicDateRange(): { from: string; to: string } {
  const now = new Date();
  
  // Go back to 1st of 4th month ago (to get 3 complete months)
  // Example: If today is Dec 13, we want Sept 1
  const fromDate = new Date(now.getFullYear(), now.getMonth() - 3, 1);
  
  return {
    from: fromDate.toISOString().split("T")[0],
    to: now.toISOString().split("T")[0]
  };
}

export async function fetchTransactions(
  accessToken: string,
  accountId: string,
  fromDate?: string,
  toDate?: string
): Promise<TrueLayerTransactionResponse> {
  // Use dynamic date range by default (3 complete months + MTD)
  const dynamicRange = calculateDynamicDateRange();
  const from = fromDate || dynamicRange.from;
  const to = toDate || dynamicRange.to;

  const response = await fetch(
    `${API_URL}/data/v1/accounts/${accountId}/transactions?from=${from}&to=${to}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch transactions failed:", errorData);
    throw new Error(`Failed to fetch transactions: ${response.status}`);
  }

  return response.json();
}

export async function fetchAllTransactions(
  accessToken: string,
  useDynamicRange: boolean = true
): Promise<TrueLayerTransactionResponse["results"]> {
  const accountsResponse = await fetchAccounts(accessToken);
  const allTransactions: TrueLayerTransactionResponse["results"] = [];

  // Use dynamic date range (3 complete months + MTD) or fallback to 90 days
  const { from, to } = useDynamicRange 
    ? calculateDynamicDateRange()
    : (() => {
        const now = new Date();
        const fromDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        return {
          from: fromDate.toISOString().split("T")[0],
          to: now.toISOString().split("T")[0]
        };
      })();

  for (const account of accountsResponse.results) {
    try {
      const txResponse = await fetchTransactions(
        accessToken,
        account.account_id,
        from,
        to
      );
      allTransactions.push(...txResponse.results);
    } catch (error) {
      console.error(
        `[TrueLayer] Failed to fetch transactions for account ${account.account_id}:`,
        error
      );
    }
  }

  return allTransactions;
}

export async function fetchDirectDebits(
  accessToken: string,
  accountId: string
): Promise<TrueLayerDirectDebitResponse> {
  const response = await fetch(
    `${API_URL}/data/v1/accounts/${accountId}/direct_debits`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch direct debits failed:", errorData);
    throw new Error(`Failed to fetch direct debits: ${response.status}`);
  }

  return response.json();
}

export async function fetchAllDirectDebits(
  accessToken: string
): Promise<TrueLayerDirectDebitResponse["results"]> {
  const accountsResponse = await fetchAccounts(accessToken);
  const allDirectDebits: TrueLayerDirectDebitResponse["results"] = [];

  for (const account of accountsResponse.results) {
    try {
      const ddResponse = await fetchDirectDebits(accessToken, account.account_id);
      allDirectDebits.push(...ddResponse.results);
    } catch (error) {
      console.error(
        `[TrueLayer] Failed to fetch direct debits for account ${account.account_id}:`,
        error
      );
    }
  }

  return allDirectDebits;
}

// ============================================
// CREDIT CARD API FUNCTIONS (using /cards endpoints)
// ============================================

export interface TrueLayerCardResponse {
  results: Array<{
    account_id: string;
    card_network: string; // VISA, MASTERCARD, AMEX
    card_type: string; // CREDIT, CHARGE
    currency: string;
    display_name: string;
    partial_card_number: string; // Last 4 digits
    name_on_card?: string;
    valid_from?: string;
    valid_to?: string;
    update_timestamp?: string;
    provider?: {
      display_name?: string;
      provider_id?: string;
    };
  }>;
}

export interface TrueLayerCardBalanceResponse {
  results: Array<{
    currency: string;
    current: number; // Amount currently owed
    available: number; // Available credit remaining
    credit_limit?: number;
    last_statement_date?: string;
    last_statement_balance?: number;
    payment_due?: number;
    payment_due_date?: string;
    update_timestamp: string;
  }>;
}

export interface TrueLayerCardTransactionResponse {
  results: Array<{
    transaction_id: string;
    timestamp: string;
    description: string;
    amount: number;
    currency: string;
    transaction_type: string;
    transaction_category: string;
    transaction_classification: string[];
    merchant_name?: string;
    meta?: {
      bank_transaction_id?: string;
      provider_category?: string;
    };
  }>;
}

export async function fetchCards(
  accessToken: string
): Promise<TrueLayerCardResponse> {
  console.log("[TrueLayer] Fetching credit cards from /data/v1/cards...");
  
  const response = await fetch(`${API_URL}/data/v1/cards`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch cards failed:", errorData);
    
    if (response.status === 404) {
      console.log("[TrueLayer] No cards found for this connection");
      return { results: [] };
    }
    
    throw new Error(`Failed to fetch cards: ${response.status} - ${errorData}`);
  }

  const data = await response.json();
  console.log(`[TrueLayer] Found ${data.results?.length || 0} credit cards`);
  return data;
}

export async function fetchCardBalance(
  accessToken: string,
  cardId: string
): Promise<TrueLayerCardBalanceResponse> {
  const response = await fetch(
    `${API_URL}/data/v1/cards/${cardId}/balance`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch card balance failed:", errorData);
    throw new Error(`Failed to fetch card balance: ${response.status}`);
  }

  return response.json();
}

export async function fetchCardTransactions(
  accessToken: string,
  cardId: string,
  fromDate?: string,
  toDate?: string
): Promise<TrueLayerCardTransactionResponse> {
  const dynamicRange = calculateDynamicDateRange();
  const from = fromDate || dynamicRange.from;
  const to = toDate || dynamicRange.to;

  console.log(`[TrueLayer] Fetching card transactions for ${cardId} from ${from} to ${to}`);

  const response = await fetch(
    `${API_URL}/data/v1/cards/${cardId}/transactions?from=${from}&to=${to}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    const errorData = await response.text();
    console.error("[TrueLayer] Fetch card transactions failed:", errorData);
    throw new Error(`Failed to fetch card transactions: ${response.status}`);
  }

  const data = await response.json();
  console.log(`[TrueLayer] Fetched ${data.results?.length || 0} card transactions`);
  return data;
}

export async function fetchAllCardTransactions(
  accessToken: string,
  useDynamicRange: boolean = true
): Promise<TrueLayerCardTransactionResponse["results"]> {
  const cardsResponse = await fetchCards(accessToken);
  const allTransactions: TrueLayerCardTransactionResponse["results"] = [];

  const { from, to } = useDynamicRange 
    ? calculateDynamicDateRange()
    : (() => {
        const now = new Date();
        const fromDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        return {
          from: fromDate.toISOString().split("T")[0],
          to: now.toISOString().split("T")[0]
        };
      })();

  for (const card of cardsResponse.results) {
    try {
      const txResponse = await fetchCardTransactions(
        accessToken,
        card.account_id,
        from,
        to
      );
      allTransactions.push(...txResponse.results);
    } catch (error) {
      console.error(
        `[TrueLayer] Failed to fetch transactions for card ${card.account_id}:`,
        error
      );
    }
  }

  return allTransactions;
}

export { encryptToken, decryptToken };
