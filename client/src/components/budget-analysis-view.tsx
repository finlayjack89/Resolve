import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DollarSign, TrendingUp, Wallet, CreditCard, ChevronRight, CheckCircle2, RefreshCw, Sparkles } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { formatCurrency } from "@/lib/format";
import { IncreaseBudgetView } from "./increase-budget-view";
import { useAuth } from "@/lib/auth-context";
import { ConnectEmailButton } from "./enrichment-ui";

interface DetectedDebtPayment {
  description: string;
  amountCents: number;
  type: string;
  logoUrl?: string | null;
  isRecurring?: boolean;
  recurrenceFrequency?: string | null;
}

interface BudgetAnalysisData {
  averageMonthlyIncomeCents: number;
  fixedCostsCents: number;
  variableEssentialsCents: number;
  discretionaryCents: number;
  safeToSpendCents: number;
  detectedDebtPayments: DetectedDebtPayment[];
  breakdown: {
    income: Array<{ description: string; amount: number; category?: string }>;
    fixedCosts: Array<{ description: string; amount: number; category?: string }>;
    variableEssentials: Array<{ description: string; amount: number; category?: string }>;
    discretionary: Array<{ description: string; amount: number; category?: string }>;
  };
  transactionCount: number;
  directDebitCount: number;
  isEnriched?: boolean;
}

interface BudgetAnalysisViewProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  analysisData: BudgetAnalysisData;
}

export function BudgetAnalysisView({ open, onOpenChange, analysisData }: BudgetAnalysisViewProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const [showIncreaseView, setShowIncreaseView] = useState(false);
  const [isSaved, setIsSaved] = useState(false);

  const saveBudgetMutation = useMutation({
    mutationFn: async () => {
      return await apiRequest("POST", "/api/budget/save-analyzed-budget", {
        currentBudgetCents: analysisData.safeToSpendCents,
      });
    },
    onSuccess: () => {
      setIsSaved(true);
      queryClient.invalidateQueries({ queryKey: ["/api/budget"] });
      queryClient.invalidateQueries({ queryKey: ["/api/budget/current"] });
      toast({
        title: "Budget Saved",
        description: "Your analyzed budget has been saved and is ready to use.",
      });
      setTimeout(() => {
        onOpenChange(false);
      }, 1500);
    },
    onError: (error: any) => {
      toast({
        title: "Save Error",
        description: error.message || "Failed to save budget. Please try again.",
        variant: "destructive",
      });
    },
  });

  const handleUseBudget = () => {
    saveBudgetMutation.mutate();
  };

  const handleIncreaseBudget = () => {
    setShowIncreaseView(true);
  };

  if (showIncreaseView) {
    return (
      <IncreaseBudgetView
        open={open}
        onOpenChange={onOpenChange}
        analysisData={{
          monthlyNetIncomeCents: analysisData.averageMonthlyIncomeCents,
          disposableIncomeCents: analysisData.safeToSpendCents,
          currentBudgetCents: analysisData.safeToSpendCents,
          nonEssentialSubscriptions: [],
          nonEssentialDiscretionaryCategories: analysisData.breakdown.discretionary.map(d => ({
            category: d.description,
            monthlyCostCents: Math.round(d.amount * 100),
          })),
        }}
        onBack={() => setShowIncreaseView(false)}
      />
    );
  }

  const currency = user?.currency || "GBP";
  
  const disposableIncome = analysisData.averageMonthlyIncomeCents - 
    analysisData.fixedCostsCents - 
    analysisData.variableEssentialsCents;

  const statsCards = [
    {
      title: "Monthly Income",
      value: formatCurrency(analysisData.averageMonthlyIncomeCents, currency),
      description: "Average monthly income detected",
      icon: DollarSign,
      iconColor: "text-green-500",
    },
    {
      title: "Fixed Costs",
      value: formatCurrency(analysisData.fixedCostsCents, currency),
      description: "Regular bills & subscriptions",
      icon: CreditCard,
      iconColor: "text-red-500",
    },
    {
      title: "Disposable Income",
      value: formatCurrency(disposableIncome, currency),
      description: "Income after essential costs",
      icon: Wallet,
      iconColor: "text-blue-500",
    },
    {
      title: "Safe to Spend",
      value: formatCurrency(analysisData.safeToSpendCents, currency),
      description: "Recommended for debt payments",
      icon: TrendingUp,
      iconColor: "text-purple-500",
    },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-2xl flex items-center gap-2">
            {isSaved ? (
              <>
                <CheckCircle2 className="h-6 w-6 text-green-500" />
                Budget Saved Successfully
              </>
            ) : (
              "Your Budget Analysis"
            )}
          </DialogTitle>
        </DialogHeader>

        {isSaved ? (
          <div className="py-8 text-center space-y-4">
            <CheckCircle2 className="h-16 w-16 text-green-500 mx-auto" />
            <p className="text-lg">Your budget has been saved!</p>
            <p className="text-muted-foreground">
              You can now generate an optimized debt payoff plan.
            </p>
          </div>
        ) : (
          <div className="space-y-6 py-4">
            <div className="text-center space-y-2">
              <p className="text-muted-foreground">
                Based on {analysisData.transactionCount} transactions and {analysisData.directDebitCount} direct debits:
              </p>
              <ConnectEmailButton className="mt-2" />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {statsCards.map((stat, index) => (
                <Card key={index} data-testid={`card-budget-stat-${index}`}>
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between mb-2">
                      <stat.icon className={`h-5 w-5 ${stat.iconColor}`} />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">{stat.title}</p>
                      <p className="text-xl font-bold font-mono">{stat.value}</p>
                      <p className="text-xs text-muted-foreground">{stat.description}</p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>

            {analysisData.detectedDebtPayments.length > 0 && (
              <Card className="border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/20">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <CreditCard className="h-5 w-5 text-amber-500 mt-0.5 flex-shrink-0" />
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <p className="font-medium text-sm">Existing Debt Payments Detected</p>
                        {analysisData.isEnriched && (
                          <Badge variant="secondary" className="text-xs">
                            <Sparkles className="h-3 w-3 mr-1" />
                            AI Enhanced
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground mt-1 mb-3">
                        We found {analysisData.detectedDebtPayments.length} existing credit card or loan payments 
                        totalling {formatCurrency(
                          analysisData.detectedDebtPayments.reduce((sum, p) => sum + p.amountCents, 0),
                          currency
                        )} per month.
                      </p>
                      
                      <div className="space-y-2">
                        {analysisData.detectedDebtPayments.slice(0, 4).map((debt, index) => (
                          <div 
                            key={index} 
                            className="flex items-center gap-3 p-2 bg-white dark:bg-background rounded-md border"
                            data-testid={`debt-item-${index}`}
                          >
                            {debt.logoUrl ? (
                              <img 
                                src={debt.logoUrl} 
                                alt={debt.description}
                                className="w-8 h-8 rounded object-contain bg-white"
                              />
                            ) : (
                              <div className="w-8 h-8 rounded bg-muted flex items-center justify-center">
                                <CreditCard className="h-4 w-4 text-muted-foreground" />
                              </div>
                            )}
                            <div className="flex-1 min-w-0">
                              <p className="text-sm font-medium truncate">{debt.description}</p>
                              {debt.isRecurring && (
                                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                                  <RefreshCw className="h-3 w-3" />
                                  {debt.recurrenceFrequency || "Recurring"}
                                </div>
                              )}
                            </div>
                            <span className="font-mono text-sm font-medium">
                              {formatCurrency(debt.amountCents, currency)}
                            </span>
                          </div>
                        ))}
                        {analysisData.detectedDebtPayments.length > 4 && (
                          <p className="text-xs text-muted-foreground text-center">
                            +{analysisData.detectedDebtPayments.length - 4} more debt payments
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {analysisData.discretionaryCents > 0 && (
              <Card className="border-orange-200 dark:border-orange-900 bg-orange-50 dark:bg-orange-950/20">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <TrendingUp className="h-5 w-5 text-orange-500 mt-0.5" />
                    <div className="flex-1">
                      <p className="font-medium text-sm">Budget Optimization Available</p>
                      <p className="text-sm text-muted-foreground mt-1">
                        We found {formatCurrency(analysisData.discretionaryCents, currency)} in discretionary spending 
                        that you could reduce to increase your debt payment budget.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            <div className="flex gap-3">
              <Button
                className="flex-1"
                onClick={handleUseBudget}
                disabled={saveBudgetMutation.isPending}
                data-testid="button-use-budget"
              >
                Use This Budget
              </Button>
              <Button
                className="flex-1"
                variant="outline"
                onClick={handleIncreaseBudget}
                disabled={saveBudgetMutation.isPending}
                data-testid="button-increase-budget"
              >
                Increase My Budget
                <ChevronRight className="ml-2 h-4 w-4" />
              </Button>
            </div>

            <p className="text-xs text-muted-foreground text-center">
              You can always adjust your budget later in the Budget settings
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
