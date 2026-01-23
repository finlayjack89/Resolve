import { useState, useEffect, useCallback } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useToast } from "@/hooks/use-toast";
import { 
  ArrowRight, 
  Building2, 
  CreditCard, 
  Loader2, 
  Check, 
  Info,
  Landmark,
  Shield,
  Zap,
  Clock,
  AlertCircle,
  Plus,
  RefreshCw,
  Wallet,
  TrendingUp,
  Calendar,
  Link2,
  Receipt
} from "lucide-react";
import { queryClient } from "@/lib/queryClient";

interface TrueLayerAccount {
  id: string;
  institutionName: string;
  institutionLogoUrl?: string | null;
  accountName: string;
  connectionType: string;
  processingStatus: string;
}

interface TrueLayerStatus {
  connected: boolean;
  accounts: TrueLayerAccount[];
  totalAccounts: number;
  stagedCount: number;
  analyzingCount: number;
  activeCount: number;
  errorCount: number;
}

interface AnalysisResult {
  totalTransactions: number;
  ghostPairsDetected: number;
  recurringPatternsDetected: number;
  accountsAnalyzed: number;
}

interface Merchant {
  name: string;
  logoUrl: string;
  category: string;
}

interface AnalysisInsights {
  merchants: Merchant[];
  ghostPairsCount: number;
  recurringPatternsCount: number;
  recentDetections: Array<{
    type: string;
    date: string;
    description: string;
    amount: number;
  }>;
  stats: {
    totalTransactions: number;
    analyzedTransactions: number;
    excludedTransactions: number;
  };
  patterns: Array<{
    merchantName: string;
    frequency: string;
    avgAmount: number;
  }>;
}

interface StagedOnboardingWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAnalysisComplete?: () => void;
}

const ANALYSIS_STAGES = [
  { id: "connecting", label: "Connecting to your bank", icon: Link2 },
  { id: "fetching", label: "Fetching transaction history", icon: Receipt },
  { id: "transfers", label: "Detecting internal transfers", icon: RefreshCw },
  { id: "patterns", label: "Identifying recurring payments", icon: Calendar },
  { id: "analyzing", label: "Calculating your budget", icon: TrendingUp },
  { id: "complete", label: "Analysis complete", icon: Check },
];

const INSIGHT_MESSAGES = [
  "Looking for transfers between your accounts...",
  "Identifying subscription payments...",
  "Detecting salary income patterns...",
  "Finding recurring bills...",
  "Categorizing your spending...",
  "Calculating monthly averages...",
  "Building your Safe-to-Spend calculation...",
];

export function StagedOnboardingWizard({ open, onOpenChange, onAnalysisComplete }: StagedOnboardingWizardProps) {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const [wizardStep, setWizardStep] = useState<"info" | "lobby" | "analyzing" | "results">("info");
  const [isConnecting, setIsConnecting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentStageIndex, setCurrentStageIndex] = useState(0);
  const [currentInsightIndex, setCurrentInsightIndex] = useState(0);
  const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
  const [progressPercent, setProgressPercent] = useState(0);
  const [visibleMerchantIndex, setVisibleMerchantIndex] = useState(0);

  const { data: trueLayerStatus, refetch: refetchStatus } = useQuery<TrueLayerStatus>({
    queryKey: ["/api/truelayer/status"],
    enabled: open,
    refetchInterval: open && (wizardStep === "lobby" || wizardStep === "analyzing") ? 2000 : false,
  });
  
  // Poll for analysis insights during and after analysis
  const { data: insights } = useQuery<AnalysisInsights>({
    queryKey: ["/api/finances/analysis-insights"],
    enabled: open && (wizardStep === "analyzing" || wizardStep === "results"),
    refetchInterval: wizardStep === "analyzing" ? 2000 : false,
  });

  const bankAccounts = trueLayerStatus?.accounts?.filter(a => a.connectionType === "current_account") || [];
  const creditCards = trueLayerStatus?.accounts?.filter(a => a.connectionType === "credit_card") || [];
  const stagedCount = trueLayerStatus?.stagedCount || 0;
  const analyzingCount = trueLayerStatus?.analyzingCount || 0;
  const activeCount = trueLayerStatus?.activeCount || 0;
  const hasAnyAccounts = (trueLayerStatus?.accounts?.length || 0) > 0;

  // Auto-advance to lobby if accounts exist
  useEffect(() => {
    if (open && hasAnyAccounts && wizardStep === "info") {
      setWizardStep("lobby");
    }
  }, [open, hasAnyAccounts, wizardStep]);

  // Progress animation during analysis
  useEffect(() => {
    if (wizardStep !== "analyzing") return;
    
    const stageInterval = setInterval(() => {
      setCurrentStageIndex(prev => {
        if (prev < ANALYSIS_STAGES.length - 2) {
          return prev + 1;
        }
        return prev;
      });
    }, 3000);
    
    const insightInterval = setInterval(() => {
      setCurrentInsightIndex(prev => (prev + 1) % INSIGHT_MESSAGES.length);
    }, 2500);
    
    const progressInterval = setInterval(() => {
      setProgressPercent(prev => {
        if (prev < 90) {
          return prev + Math.random() * 5;
        }
        return prev;
      });
    }, 500);
    
    // Rotate through detected merchants
    const merchantInterval = setInterval(() => {
      setVisibleMerchantIndex(prev => prev + 1);
    }, 800);
    
    return () => {
      clearInterval(stageInterval);
      clearInterval(insightInterval);
      clearInterval(progressInterval);
      clearInterval(merchantInterval);
    };
  }, [wizardStep]);

  // Check if analysis completed
  useEffect(() => {
    if (wizardStep === "analyzing" && analyzingCount === 0 && activeCount > 0 && !isAnalyzing) {
      setCurrentStageIndex(ANALYSIS_STAGES.length - 1);
      setProgressPercent(100);
      setTimeout(() => {
        setWizardStep("results");
      }, 1000);
    }
  }, [wizardStep, analyzingCount, activeCount, isAnalyzing]);

  const handleConnectBank = async (connectionType: "current_account" | "credit_card") => {
    try {
      setIsConnecting(true);
      const returnUrl = window.location.pathname + "?wizard=open";
      const response = await fetch(`/api/truelayer/auth-url?connectionType=${connectionType}&returnUrl=${encodeURIComponent(returnUrl)}`, {
        credentials: "include",
      });
      
      if (!response.ok) {
        throw new Error("Failed to get authentication URL");
      }
      
      const data = await response.json();
      window.location.href = data.authUrl;
    } catch (error: any) {
      console.error("[StagedWizard] Connect error:", error);
      toast({
        title: "Connection Error",
        description: error.message || "Failed to connect. Please try again.",
        variant: "destructive",
      });
      setIsConnecting(false);
    }
  };

  const handleAnalyzeTransactions = async () => {
    try {
      setIsAnalyzing(true);
      setWizardStep("analyzing");
      setCurrentStageIndex(0);
      setProgressPercent(0);
      
      const response = await fetch("/api/finances/initialize-analysis", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || "Failed to analyze transactions");
      }
      
      // Store analysis results
      setAnalysisResult({
        totalTransactions: data.totalTransactions || 0,
        ghostPairsDetected: data.ghostPairsDetected || 0,
        recurringPatternsDetected: data.recurringPatternsDetected || 0,
        accountsAnalyzed: data.accountsProcessed || 0,
      });
      
      await queryClient.invalidateQueries({ queryKey: ["/api/truelayer/status"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/current-finances/accounts"] });
      await queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
      
      setCurrentStageIndex(ANALYSIS_STAGES.length - 1);
      setProgressPercent(100);
      
      setTimeout(() => {
        setWizardStep("results");
      }, 500);
      
    } catch (error: any) {
      console.error("[StagedWizard] Analysis error:", error);
      toast({
        title: "Analysis Error",
        description: error.message || "Failed to analyze transactions. Please try again.",
        variant: "destructive",
      });
      setWizardStep("lobby");
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleViewDashboard = () => {
    onOpenChange(false);
    if (onAnalysisComplete) {
      onAnalysisComplete();
    } else {
      setLocation("/budget");
    }
  };

  const renderStatusBadge = (status: string) => {
    switch (status) {
      case "STAGED":
        return (
          <Badge variant="outline" className="gap-1 border-amber-500 text-amber-600 dark:text-amber-400" data-testid="badge-staged">
            <Clock className="h-3 w-3" />
            Ready
          </Badge>
        );
      case "ACTIVE":
        return (
          <Badge variant="outline" className="gap-1 border-green-500 text-green-600 dark:text-green-400" data-testid="badge-active">
            <Check className="h-3 w-3" />
            Analyzed
          </Badge>
        );
      case "ANALYZING":
        return (
          <Badge variant="outline" className="gap-1 border-blue-500 text-blue-600 dark:text-blue-400" data-testid="badge-analyzing">
            <Loader2 className="h-3 w-3 animate-spin" />
            Analyzing
          </Badge>
        );
      case "ERROR":
        return (
          <Badge variant="outline" className="gap-1 border-red-500 text-red-600 dark:text-red-400" data-testid="badge-error">
            <AlertCircle className="h-3 w-3" />
            Error
          </Badge>
        );
      default:
        return null;
    }
  };

  const renderAccountCard = (account: TrueLayerAccount) => (
    <Card key={account.id} className="bg-muted/50" data-testid={`card-account-${account.id}`}>
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-3 min-w-0">
            {account.institutionLogoUrl ? (
              <img 
                src={account.institutionLogoUrl} 
                alt={account.institutionName}
                className="h-8 w-8 rounded-full object-contain bg-white p-0.5"
              />
            ) : (
              <div className="h-8 w-8 rounded-full bg-primary/10 flex items-center justify-center">
                {account.connectionType === "credit_card" ? (
                  <CreditCard className="h-4 w-4 text-primary" />
                ) : (
                  <Building2 className="h-4 w-4 text-primary" />
                )}
              </div>
            )}
            <div className="min-w-0">
              <p className="font-medium text-sm truncate">{account.institutionName}</p>
              <p className="text-xs text-muted-foreground truncate">{account.accountName}</p>
            </div>
          </div>
          {renderStatusBadge(account.processingStatus)}
        </div>
      </CardContent>
    </Card>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className={wizardStep === "lobby" ? "max-w-4xl" : wizardStep === "analyzing" ? "max-w-2xl" : "max-w-xl"}>
        {wizardStep === "info" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl flex items-center gap-2">
                <Shield className="h-6 w-6 text-primary" />
                Connect Your Accounts
              </DialogTitle>
              <DialogDescription className="text-base">
                Before we analyze your finances, let's understand how Resolve works differently.
              </DialogDescription>
            </DialogHeader>
            
            <div className="space-y-6 py-4">
              <div className="rounded-lg bg-primary/5 border border-primary/20 p-4">
                <h3 className="font-semibold text-lg mb-3 flex items-center gap-2">
                  <Zap className="h-5 w-5 text-primary" />
                  Why Staged Connection?
                </h3>
                <p className="text-sm text-muted-foreground mb-4">
                  Resolve uses a unique "staged connection" approach to give you the most accurate picture of your finances. Here's why this matters:
                </p>
                <ul className="space-y-3 text-sm">
                  <li className="flex gap-3">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-primary">1</span>
                    </div>
                    <div>
                      <span className="font-medium">Connect all your accounts first</span>
                      <p className="text-muted-foreground mt-0.5">Add your bank accounts and credit cards in one session. No analysis happens yet.</p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-primary">2</span>
                    </div>
                    <div>
                      <span className="font-medium">Holistic analysis across all accounts</span>
                      <p className="text-muted-foreground mt-0.5">When you're ready, we analyze everything together. This lets us detect transfers between your accounts and avoid counting them twice.</p>
                    </div>
                  </li>
                  <li className="flex gap-3">
                    <div className="h-6 w-6 rounded-full bg-primary/10 flex items-center justify-center shrink-0 mt-0.5">
                      <span className="text-xs font-bold text-primary">3</span>
                    </div>
                    <div>
                      <span className="font-medium">Accurate "Safe to Spend" calculation</span>
                      <p className="text-muted-foreground mt-0.5">By seeing the complete picture, Resolve can tell you exactly how much you can put toward debt without impacting your lifestyle.</p>
                    </div>
                  </li>
                </ul>
              </div>
              
              <div className="flex items-start gap-3 p-3 rounded-lg bg-muted/50">
                <Info className="h-5 w-5 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-sm text-muted-foreground">
                  Your data is encrypted and secure. We use read-only access through Open Banking, which means we can never move your money or make changes to your accounts.
                </p>
              </div>
            </div>
            
            <div className="flex justify-end">
              <Button onClick={() => setWizardStep("lobby")} data-testid="button-next-to-lobby">
                Let's Get Started
                <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </div>
          </>
        )}

        {wizardStep === "lobby" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl">Account Lobby</DialogTitle>
              <DialogDescription>
                Connect your bank accounts and credit cards below. When you're ready, click "Analyze" to process all transactions together.
              </DialogDescription>
            </DialogHeader>
            
            <div className="grid grid-cols-2 gap-6 py-4">
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <Landmark className="h-5 w-5 text-primary" />
                  <h3 className="font-semibold">Bank Accounts</h3>
                  {bankAccounts.length > 0 && (
                    <Badge variant="secondary" className="ml-auto">{bankAccounts.length}</Badge>
                  )}
                </div>
                
                <div className="space-y-2 min-h-[120px]">
                  {bankAccounts.length === 0 ? (
                    <div className="h-[120px] border-2 border-dashed rounded-lg flex items-center justify-center text-muted-foreground text-sm">
                      No bank accounts connected yet
                    </div>
                  ) : (
                    bankAccounts.map(renderAccountCard)
                  )}
                </div>
                
                <Button 
                  variant="outline" 
                  className="w-full gap-2"
                  onClick={() => handleConnectBank("current_account")}
                  disabled={isConnecting}
                  data-testid="button-connect-bank"
                >
                  {isConnecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Connect Bank Account
                </Button>
              </div>
              
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <CreditCard className="h-5 w-5 text-primary" />
                  <h3 className="font-semibold">Credit Cards</h3>
                  {creditCards.length > 0 && (
                    <Badge variant="secondary" className="ml-auto">{creditCards.length}</Badge>
                  )}
                </div>
                
                <div className="space-y-2 min-h-[120px]">
                  {creditCards.length === 0 ? (
                    <div className="h-[120px] border-2 border-dashed rounded-lg flex items-center justify-center text-muted-foreground text-sm">
                      No credit cards connected yet
                    </div>
                  ) : (
                    creditCards.map(renderAccountCard)
                  )}
                </div>
                
                <Button 
                  variant="outline" 
                  className="w-full gap-2"
                  onClick={() => handleConnectBank("credit_card")}
                  disabled={isConnecting}
                  data-testid="button-connect-credit-card"
                >
                  {isConnecting ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="h-4 w-4" />
                  )}
                  Connect Credit Card
                </Button>
              </div>
            </div>
            
            {stagedCount > 0 && (
              <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm">
                <p className="text-amber-800 dark:text-amber-200">
                  <strong>{stagedCount} account{stagedCount > 1 ? 's' : ''}</strong> ready to analyze. 
                  {stagedCount === 1 
                    ? " Add more accounts for better accuracy, or click Analyze when ready."
                    : " Click Analyze when you're ready to process all accounts together."}
                </p>
              </div>
            )}
            
            <div className="flex justify-between items-center pt-2 border-t">
              <Button 
                variant="ghost" 
                onClick={() => onOpenChange(false)}
                data-testid="button-close-wizard"
              >
                Close
              </Button>
              <Button 
                onClick={handleAnalyzeTransactions}
                disabled={stagedCount === 0 || isAnalyzing}
                className="gap-2"
                data-testid="button-analyze-transactions"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Starting...
                  </>
                ) : (
                  <>
                    <Zap className="h-4 w-4" />
                    Analyze Transaction History
                  </>
                )}
              </Button>
            </div>
          </>
        )}

        {wizardStep === "analyzing" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl text-center">Analyzing Your Transactions</DialogTitle>
              <DialogDescription className="text-center">
                This may take a few moments. We're processing 6 months of transaction history.
              </DialogDescription>
            </DialogHeader>
            
            <div className="py-6 space-y-6">
              <div className="flex justify-center">
                <div className="relative h-24 w-24">
                  <div className="absolute inset-0 rounded-full border-4 border-muted" />
                  <div 
                    className="absolute inset-0 rounded-full border-4 border-primary border-t-transparent animate-spin"
                    style={{ animationDuration: "1.5s" }}
                  />
                  <div className="absolute inset-0 flex items-center justify-center">
                    {(() => {
                      const CurrentIcon = ANALYSIS_STAGES[currentStageIndex].icon;
                      return <CurrentIcon className="h-8 w-8 text-primary" />;
                    })()}
                  </div>
                </div>
              </div>
              
              <div className="space-y-2">
                <Progress value={progressPercent} className="h-2" />
                <p className="text-center text-sm text-muted-foreground">
                  {Math.round(progressPercent)}% complete
                </p>
              </div>
              
              {/* Merchant logo animation */}
              {insights?.merchants && insights.merchants.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs text-center text-muted-foreground">Detected merchants:</p>
                  <div className="flex justify-center gap-2 overflow-hidden h-10">
                    {insights.merchants.slice(0, 8).map((merchant, index) => {
                      const isVisible = Math.abs((visibleMerchantIndex % insights.merchants.length) - index) <= 3;
                      return (
                        <div
                          key={merchant.name}
                          className={`transition-all duration-500 ${
                            isVisible ? "opacity-100 scale-100" : "opacity-30 scale-75"
                          }`}
                        >
                          <img
                            src={merchant.logoUrl}
                            alt={merchant.name}
                            title={merchant.name}
                            className="h-10 w-10 rounded-full object-contain bg-white p-1 border"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              
              <div className="space-y-3">
                {ANALYSIS_STAGES.slice(0, -1).map((stage, index) => {
                  const isComplete = index < currentStageIndex;
                  const isCurrent = index === currentStageIndex;
                  const StageIcon = stage.icon;
                  
                  return (
                    <div 
                      key={stage.id}
                      className={`flex items-center gap-3 p-2 rounded-lg transition-all ${
                        isCurrent ? "bg-primary/10" : isComplete ? "opacity-60" : "opacity-30"
                      }`}
                    >
                      <div className={`h-6 w-6 rounded-full flex items-center justify-center ${
                        isComplete ? "bg-green-500" : isCurrent ? "bg-primary" : "bg-muted"
                      }`}>
                        {isComplete ? (
                          <Check className="h-3 w-3 text-white" />
                        ) : isCurrent ? (
                          <Loader2 className="h-3 w-3 text-white animate-spin" />
                        ) : (
                          <StageIcon className="h-3 w-3 text-muted-foreground" />
                        )}
                      </div>
                      <span className={`text-sm ${isCurrent ? "font-medium" : ""}`}>
                        {stage.label}
                        {/* Show real counts when available */}
                        {stage.id === "transfers" && (insights?.ghostPairsCount ?? 0) > 0 && (
                          <Badge variant="secondary" className="ml-2 text-xs">
                            {insights?.ghostPairsCount} found
                          </Badge>
                        )}
                        {stage.id === "patterns" && (insights?.recurringPatternsCount ?? 0) > 0 && (
                          <Badge variant="secondary" className="ml-2 text-xs">
                            {insights?.recurringPatternsCount} found
                          </Badge>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
              
              <div className="text-center p-3 rounded-lg bg-muted/50">
                <p className="text-sm text-muted-foreground italic animate-pulse">
                  {INSIGHT_MESSAGES[currentInsightIndex]}
                </p>
              </div>
              
              {/* Live detection events */}
              {insights?.recentDetections && insights.recentDetections.length > 0 && (
                <div className="space-y-2 max-h-24 overflow-y-auto">
                  <p className="text-xs text-center text-muted-foreground">Recent detections:</p>
                  {insights.recentDetections.slice(0, 3).map((detection, index) => (
                    <div key={index} className="text-xs text-center text-green-600 dark:text-green-400">
                      <Link2 className="h-3 w-3 inline mr-1" />
                      Transfer detected: {detection.description} ({detection.date})
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {wizardStep === "results" && (
          <>
            <DialogHeader>
              <DialogTitle className="text-2xl text-center flex items-center justify-center gap-2">
                <div className="h-8 w-8 rounded-full bg-green-500 flex items-center justify-center">
                  <Check className="h-5 w-5 text-white" />
                </div>
                Analysis Complete
              </DialogTitle>
              <DialogDescription className="text-center">
                Your transaction history has been analyzed. Here's what we found.
              </DialogDescription>
            </DialogHeader>
            
            <div className="py-6 space-y-4">
              {/* Detected merchants showcase */}
              {insights?.merchants && insights.merchants.length > 0 && (
                <div className="flex justify-center gap-2 pb-2 border-b">
                  {insights.merchants.slice(0, 10).map((merchant) => (
                    <img
                      key={merchant.name}
                      src={merchant.logoUrl}
                      alt={merchant.name}
                      title={merchant.name}
                      className="h-8 w-8 rounded-full object-contain bg-white p-0.5 border"
                    />
                  ))}
                </div>
              )}
              
              <div className="grid grid-cols-2 gap-3">
                <Card className="bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-blue-100 dark:bg-blue-800 flex items-center justify-center">
                        <Wallet className="h-5 w-5 text-blue-600 dark:text-blue-300" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-blue-700 dark:text-blue-300">
                          {analysisResult?.accountsAnalyzed || activeCount || trueLayerStatus?.activeCount || 0}
                        </p>
                        <p className="text-xs text-blue-600 dark:text-blue-400">Accounts Analyzed</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                
                <Card className="bg-purple-50 dark:bg-purple-900/20 border-purple-200 dark:border-purple-800">
                  <CardContent className="p-4">
                    <div className="flex items-center gap-3">
                      <div className="h-10 w-10 rounded-full bg-purple-100 dark:bg-purple-800 flex items-center justify-center">
                        <Receipt className="h-5 w-5 text-purple-600 dark:text-purple-300" />
                      </div>
                      <div>
                        <p className="text-2xl font-bold text-purple-700 dark:text-purple-300">
                          {analysisResult?.totalTransactions || insights?.stats?.totalTransactions || "6 mo"}
                        </p>
                        <p className="text-xs text-purple-600 dark:text-purple-400">
                          {(analysisResult?.totalTransactions || insights?.stats?.totalTransactions) ? "Transactions" : "History"}
                        </p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
                
                {((analysisResult?.ghostPairsDetected ?? 0) > 0 || (insights?.ghostPairsCount ?? 0) > 0) && (
                  <Card className="bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-amber-100 dark:bg-amber-800 flex items-center justify-center">
                          <Link2 className="h-5 w-5 text-amber-600 dark:text-amber-300" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-amber-700 dark:text-amber-300">
                            {analysisResult?.ghostPairsDetected || insights?.ghostPairsCount || 0}
                          </p>
                          <p className="text-xs text-amber-600 dark:text-amber-400">Transfers Detected</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
                
                {((analysisResult?.recurringPatternsDetected ?? 0) > 0 || (insights?.recurringPatternsCount ?? 0) > 0) && (
                  <Card className="bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800">
                    <CardContent className="p-4">
                      <div className="flex items-center gap-3">
                        <div className="h-10 w-10 rounded-full bg-green-100 dark:bg-green-800 flex items-center justify-center">
                          <Calendar className="h-5 w-5 text-green-600 dark:text-green-300" />
                        </div>
                        <div>
                          <p className="text-2xl font-bold text-green-700 dark:text-green-300">
                            {analysisResult?.recurringPatternsDetected || insights?.recurringPatternsCount || 0}
                          </p>
                          <p className="text-xs text-green-600 dark:text-green-400">Recurring Payments</p>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                )}
              </div>
              
              <div className="rounded-lg bg-primary/5 border border-primary/20 p-4 text-center">
                <p className="text-sm">
                  <span className="font-medium">What's next?</span> Your personalized budget insights and "Safe to Spend" calculation are ready on your dashboard.
                </p>
              </div>
            </div>
            
            <div className="flex justify-center">
              <Button onClick={handleViewDashboard} size="lg" className="gap-2" data-testid="button-view-dashboard">
                View Your Dashboard
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
