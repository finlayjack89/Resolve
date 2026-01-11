import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RefreshCw, Wallet, Building2, TrendingUp, TrendingDown, PiggyBank, AlertCircle, Loader2, Mail, Receipt } from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import { ConnectedAccountTile } from "@/components/connected-account-tile";
import { ConnectBankDialog } from "@/components/connect-bank-dialog";
import { EnrichmentProgressModal } from "@/components/enrichment-progress-modal";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

interface AccountAnalysisSummary {
  averageMonthlyIncomeCents: number;
  employmentIncomeCents: number;
  otherIncomeCents: number;
  sideHustleIncomeCents: number;
  fixedCostsCents: number;
  essentialsCents: number;
  discretionaryCents: number;
  debtPaymentsCents: number;
  availableForDebtCents: number;
  analysisMonths: number;
  lastUpdated: string;
}

interface ConnectedAccountSummary {
  id: string;
  trueLayerAccountId: string;
  institutionName: string;
  institutionLogoUrl: string | null;
  accountName: string;
  accountType: string | null;
  currency: string | null;
  connectionStatus: string | null;
  isSideHustle: boolean | null;
  lastSyncedAt: string | null;
  lastEnrichedAt: string | null;
  lastAnalyzedAt: string | null;
  transactionCount: number;
  analysisSummary: AccountAnalysisSummary | null;
}

interface CombinedFinancesResponse {
  accounts: ConnectedAccountSummary[];
  combined: {
    totalIncomeCents: number;
    employmentIncomeCents: number;
    sideHustleIncomeCents: number;
    otherIncomeCents: number;
    fixedCostsCents: number;
    essentialsCents: number;
    discretionaryCents: number;
    debtPaymentsCents: number;
    availableForDebtCents: number;
    analysisMonths: number;
  };
  budgetForDebt: {
    currentBudgetCents: number | null;
    potentialBudgetCents: number | null;
    suggestedBudgetCents: number;
  };
}

export default function CurrentFinances() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const searchString = useSearch();
  const [refreshingAccountId, setRefreshingAccountId] = useState<string | null>(null);
  const [removingAccountId, setRemovingAccountId] = useState<string | null>(null);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [showEnrichmentModal, setShowEnrichmentModal] = useState(false);
  const [enrichmentJobId, setEnrichmentJobId] = useState<string | null>(null);
  const [showEmailPromptModal, setShowEmailPromptModal] = useState(false);
  const [isConnectingEmail, setIsConnectingEmail] = useState(false);

  const { data: nylasGrantStatus, refetch: refetchNylasGrants } = useQuery<{
    nylas_available: boolean;
    has_grants: boolean;
    message: string;
  }>({
    queryKey: ["/api/nylas/grants", user?.id],
    enabled: !!user?.id && user.id !== "guest-user",
  });

  // Handle OAuth callback - check for ?connected=true or ?email_connected=true in URL
  useEffect(() => {
    const params = new URLSearchParams(searchString);
    if (params.get("connected") === "true") {
      // Close the connect dialog if it was open
      setShowConnectDialog(false);
      // Clear URL params
      setLocation("/current-finances", { replace: true });
      // Start enrichment process
      startEnrichmentAfterConnection();
    } else if (params.get("email_connected") === "true") {
      // Clear URL params
      setLocation("/current-finances", { replace: true });
      setIsConnectingEmail(false);
      // Refresh grants status
      refetchNylasGrants();
      toast({
        title: "Email Connected",
        description: "Your email has been connected for enhanced receipt matching.",
      });
    } else if (params.get("error")) {
      const error = params.get("error");
      setLocation("/current-finances", { replace: true });
      setIsConnectingEmail(false);
      toast({
        title: "Connection Failed",
        description: error || "Failed to connect",
        variant: "destructive",
      });
    }
  }, [searchString]);

  const startEnrichmentAfterConnection = async () => {
    try {
      const response = await apiRequest("POST", "/api/budget/start-enrichment", { forceRefresh: true });
      const data = await response.json();
      
      if (data.cached) {
        // Cached enrichment exists - just refresh queries
        queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
        toast({ title: "Analysis ready", description: "Using cached transaction analysis." });
        return;
      }
      
      if (data.jobId) {
        // Start enrichment with progress modal
        setEnrichmentJobId(data.jobId);
        setShowEnrichmentModal(true);
      }
    } catch (error: any) {
      toast({
        title: "Enrichment Failed",
        description: error.message || "Failed to analyze transactions",
        variant: "destructive",
      });
    }
  };

  const handleConnectBank = () => {
    if (user?.id === "guest-user") {
      toast({
        title: "Account Required",
        description: "Please create an account to connect your bank.",
        variant: "destructive",
      });
      return;
    }
    setShowConnectDialog(true);
  };

  const handleEnrichmentComplete = async (result: any) => {
    setShowEnrichmentModal(false);
    setEnrichmentJobId(null);
    queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
    toast({
      title: "Analysis Complete",
      description: "Your transactions have been analyzed successfully.",
    });
    
    // Check if user already has Nylas grants - if not, show the email connection prompt
    const grantsResult = await refetchNylasGrants();
    if (grantsResult.data && !grantsResult.data.has_grants && grantsResult.data.nylas_available) {
      // Small delay to let the user see the success toast first
      setTimeout(() => {
        setShowEmailPromptModal(true);
      }, 1000);
    }
  };

  const handleConnectEmail = async () => {
    if (user?.id === "guest-user") {
      toast({
        title: "Sign in required",
        description: "Please sign in to connect your email for enhanced receipt matching",
        variant: "destructive",
      });
      return;
    }

    setIsConnectingEmail(true);
    try {
      const response = await apiRequest("GET", `/api/nylas/auth-url?user_id=${user?.id}&redirect_uri=${encodeURIComponent(window.location.origin + "/current-finances?email_connected=true")}`);
      const data = await response.json();
      
      if (data.auth_url) {
        window.location.href = data.auth_url;
      } else {
        throw new Error(data.error || "Failed to start email connection");
      }
    } catch (error: any) {
      setIsConnectingEmail(false);
      toast({
        title: "Connection Error",
        description: error.message || "Failed to connect email",
        variant: "destructive",
      });
    }
  };

  const handleEnrichmentError = (error: string) => {
    setShowEnrichmentModal(false);
    setEnrichmentJobId(null);
    toast({
      title: "Analysis Failed",
      description: error || "Failed to analyze transactions",
      variant: "destructive",
    });
  };

  const handleCancelEnrichment = async () => {
    if (enrichmentJobId) {
      try {
        await apiRequest("POST", `/api/budget/cancel-enrichment/${enrichmentJobId}`);
      } catch (e) {
        // Ignore cancel errors
      }
    }
  };

  const handleRemoveAccount = async (accountId: string, institutionName: string) => {
    if (!confirm(`Are you sure you want to remove ${institutionName}? This will delete all transaction data and analysis for this account.`)) {
      return;
    }

    setRemovingAccountId(accountId);
    try {
      await apiRequest("DELETE", `/api/truelayer/item/${accountId}`);
      // Invalidate both the combined query and the specific account query to clear stale cache
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/account", accountId] });
      toast({
        title: "Account Removed",
        description: `${institutionName} has been disconnected and all data removed.`,
      });
    } catch (error: any) {
      console.error("Remove account error:", error);
      toast({
        title: "Removal Failed",
        description: error.message || "Could not remove the account.",
        variant: "destructive",
      });
    } finally {
      setRemovingAccountId(null);
    }
  };

  const { data, isLoading, refetch } = useQuery<CombinedFinancesResponse>({
    queryKey: ["/api/current-finances/combined"],
    queryFn: async () => {
      const response = await fetch("/api/current-finances/combined", { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch finances");
      return response.json();
    },
  });

  const analyzeMutation = useMutation({
    mutationFn: async (accountId: string) => {
      setRefreshingAccountId(accountId);
      // Use re-enrich endpoint to process existing transactions through full cascade
      // This doesn't require TrueLayer connection and triggers Nylas context hunting for low-confidence transactions
      const response = await apiRequest("POST", `/api/current-finances/account/${accountId}/re-enrich`);
      return response.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
      const message = data.transactionsUpdated 
        ? `Re-enriched ${data.transactionsUpdated} transactions through the full cascade.`
        : "Account transactions have been re-analyzed.";
      toast({ title: "Analysis complete", description: message });
    },
    onError: () => {
      toast({ title: "Analysis failed", description: "Could not re-analyze transactions.", variant: "destructive" });
    },
    onSettled: () => {
      setRefreshingAccountId(null);
    },
  });

  const accounts = data?.accounts || [];
  const combined = data?.combined;
  const budgetForDebt = data?.budgetForDebt;
  const currency = user?.currency || "GBP";

  return (
    <div className="min-h-screen bg-background">
      <main className="container mx-auto max-w-7xl px-4 py-8">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold" data-testid="text-page-title">Current Finances</h1>
            <p className="text-muted-foreground mt-2">
              Your connected bank accounts and spending analysis
            </p>
          </div>
          <Button
            onClick={() => refetch()}
            variant="outline"
            disabled={isLoading}
            data-testid="button-refresh-all"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${isLoading ? "animate-spin" : ""}`} />
            Refresh All
          </Button>
        </div>

        {/* Combined Summary Cards */}
        {combined && (
          <div className="grid gap-4 mb-8 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Total Income</CardTitle>
                <TrendingUp className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold text-green-600 dark:text-green-400" data-testid="text-total-income">
                  {formatCurrency(combined.totalIncomeCents, currency)}
                </p>
                <p className="text-xs text-muted-foreground">per month (avg)</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Fixed Costs</CardTitle>
                <Building2 className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold" data-testid="text-fixed-costs">
                  {formatCurrency(combined.fixedCostsCents, currency)}
                </p>
                <p className="text-xs text-muted-foreground">rent, utilities, subscriptions</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Essentials</CardTitle>
                <Wallet className="h-4 w-4 text-amber-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold" data-testid="text-essentials">
                  {formatCurrency(combined.essentialsCents, currency)}
                </p>
                <p className="text-xs text-muted-foreground">groceries, transport, healthcare</p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Available for Debt</CardTitle>
                <PiggyBank className="h-4 w-4 text-primary" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold text-primary" data-testid="text-available-for-debt">
                  {formatCurrency(combined.availableForDebtCents, currency)}
                </p>
                <p className="text-xs text-muted-foreground">after fixed costs & essentials</p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Budget Suggestion Card */}
        {budgetForDebt && budgetForDebt.suggestedBudgetCents > 0 && (
          <Card className="mb-8 border-primary/20 bg-primary/5">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <PiggyBank className="h-5 w-5" />
                Suggested Debt Repayment Budget
              </CardTitle>
              <CardDescription>
                Based on your spending patterns, here's how much you could put toward debt each month
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-end gap-6">
                <div>
                  <p className="text-sm text-muted-foreground">Suggested Monthly Budget</p>
                  <p className="text-3xl font-mono font-bold text-primary" data-testid="text-suggested-budget">
                    {formatCurrency(budgetForDebt.suggestedBudgetCents, currency)}
                  </p>
                </div>
                {budgetForDebt.currentBudgetCents !== null && (
                  <div>
                    <p className="text-sm text-muted-foreground">Current Budget</p>
                    <p className="text-2xl font-mono font-semibold" data-testid="text-current-budget">
                      {formatCurrency(budgetForDebt.currentBudgetCents, currency)}
                    </p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Loading State */}
        {isLoading && (
          <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <Card key={i} className="animate-pulse">
                <CardHeader>
                  <div className="h-10 w-10 bg-muted rounded-full" />
                  <div className="h-6 bg-muted rounded w-3/4 mt-2" />
                  <div className="h-4 bg-muted rounded w-1/2 mt-2" />
                </CardHeader>
                <CardContent>
                  <div className="h-8 bg-muted rounded w-2/3" />
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {/* Empty State */}
        {!isLoading && accounts.length === 0 && (
          <Card className="text-center py-16">
            <CardHeader>
              <div className="flex justify-center mb-4">
                <div className="rounded-full bg-muted p-6">
                  <Building2 className="h-12 w-12 text-muted-foreground" />
                </div>
              </div>
              <CardTitle className="text-2xl">No bank accounts connected</CardTitle>
              <CardDescription className="text-base mt-2">
                Connect your bank account via Open Banking to see your spending analysis
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                onClick={handleConnectBank}
                className="h-12 px-8"
                data-testid="button-connect-bank"
              >
                <Building2 className="mr-2 h-4 w-4" />
                Connect Your Bank
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Connected Accounts Grid */}
        {!isLoading && accounts.length > 0 && (
          <>
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-semibold">Connected Accounts</h2>
              <div className="flex items-center gap-4">
                <span className="text-sm text-muted-foreground" data-testid="text-account-count">{accounts.length} account{accounts.length !== 1 ? "s" : ""}</span>
                <Button
                  onClick={handleConnectBank}
                  variant="outline"
                  data-testid="button-add-another-bank"
                >
                  <Building2 className="mr-2 h-4 w-4" />
                  Add Another Bank
                </Button>
              </div>
            </div>
            <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
              {accounts.map((account) => (
                <ConnectedAccountTile
                  key={account.id}
                  account={account}
                  currency={currency}
                  isRefreshing={refreshingAccountId === account.id}
                  onRefresh={() => analyzeMutation.mutate(account.id)}
                  onRemove={() => handleRemoveAccount(account.id, account.institutionName)}
                  isRemoving={removingAccountId === account.id}
                />
              ))}
            </div>
          </>
        )}

        {/* Discretionary Spending Insight */}
        {combined && combined.discretionaryCents > 0 && (
          <Card className="mt-8">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <TrendingDown className="h-5 w-5 text-amber-500" />
                Discretionary Spending
              </CardTitle>
              <CardDescription>
                Non-essential spending that could potentially be reduced
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap items-center gap-4">
                <div>
                  <p className="text-2xl font-mono font-bold" data-testid="text-discretionary">
                    {formatCurrency(combined.discretionaryCents, currency)}
                  </p>
                  <p className="text-sm text-muted-foreground">per month</p>
                </div>
                {combined.debtPaymentsCents > 0 && (
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <AlertCircle className="h-4 w-4" />
                    <span>You're already paying {formatCurrency(combined.debtPaymentsCents, currency)}/month toward existing debt</span>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}
      </main>

      {/* Connect Bank Account Dialog */}
      <ConnectBankDialog
        open={showConnectDialog}
        onOpenChange={setShowConnectDialog}
        returnUrl="/current-finances"
      />

      {/* Enrichment Progress Modal */}
      <EnrichmentProgressModal
        open={showEnrichmentModal}
        onOpenChange={setShowEnrichmentModal}
        jobId={enrichmentJobId}
        onComplete={handleEnrichmentComplete}
        onError={handleEnrichmentError}
        onCancel={handleCancelEnrichment}
      />

      {/* Nylas Email Connection Prompt Modal */}
      <Dialog open={showEmailPromptModal} onOpenChange={setShowEmailPromptModal}>
        <DialogContent className="sm:max-w-md" data-testid="dialog-email-prompt">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Mail className="h-5 w-5 text-primary" />
              Enhance Your Transaction Matching
            </DialogTitle>
            <DialogDescription className="pt-2">
              Connect your email to automatically match receipts with your transactions for more accurate expense tracking.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="flex items-start gap-3">
              <Receipt className="h-5 w-5 text-green-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium">Automatic Receipt Matching</p>
                <p className="text-sm text-muted-foreground">
                  We'll scan your email for receipts and match them with bank transactions
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <TrendingUp className="h-5 w-5 text-blue-500 mt-0.5 flex-shrink-0" />
              <div>
                <p className="text-sm font-medium">Better Subscription Detection</p>
                <p className="text-sm text-muted-foreground">
                  Identify recurring charges and subscription services more accurately
                </p>
              </div>
            </div>
          </div>
          <DialogFooter className="flex-col sm:flex-row gap-2">
            <Button
              variant="outline"
              onClick={() => setShowEmailPromptModal(false)}
              data-testid="button-email-maybe-later"
            >
              Maybe Later
            </Button>
            <Button
              onClick={handleConnectEmail}
              disabled={isConnectingEmail}
              data-testid="button-email-connect"
            >
              {isConnectingEmail ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Connecting...
                </>
              ) : (
                <>
                  <Mail className="mr-2 h-4 w-4" />
                  Connect Email
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
