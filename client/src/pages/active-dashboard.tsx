import { Link } from "wouter";
import { useAccounts, useActivePlan } from "@/hooks/use-plan-data";
import { getCurrentMonthIndex, getDashboardStats } from "@/lib/date-utils";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { TrendingDown, Calendar, DollarSign, Target, CreditCard, BarChart3, CheckCircle2, RefreshCw, Wallet, Clock, AlertCircle, Receipt, ArrowRight } from "lucide-react";
import { formatCurrency, formatMonthYear } from "@/lib/format";
import { FindMyBudgetButton } from "@/components/find-my-budget-button";
import { queryClient } from "@/lib/queryClient";
import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import type { UpcomingBill, RecurrenceFrequency } from "@shared/schema";

interface CombinedFinancesResponse {
  accounts: Array<{
    id: string;
    institutionName: string;
    accountName: string;
    transactionCount: number;
    analysisSummary: {
      averageMonthlyIncomeCents: number;
      fixedCostsCents: number;
      essentialsCents: number;
      discretionaryCents: number;
      availableForDebtCents: number;
      closedMonthsAnalyzed: number;
      currentMonthPacing?: {
        currentMonthSpendCents: number;
        currentMonthIncomeCents: number;
        projectedMonthSpendCents: number;
        projectedMonthIncomeCents: number;
        daysPassed: number;
        totalDaysInMonth: number;
      };
    } | null;
  }>;
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
    closedMonthsAnalyzed: number;
    currentMonthPacing?: {
      currentMonthSpendCents: number;
      currentMonthIncomeCents: number;
      projectedMonthSpendCents: number;
      projectedMonthIncomeCents: number;
      daysPassed: number;
      totalDaysInMonth: number;
    };
  };
}

interface UpcomingBillsResponse {
  upcomingBills: UpcomingBill[];
  paidBills: UpcomingBill[];
  summary: {
    totalUpcomingCount: number;
    totalPaidCount: number;
    totalUpcomingCents: number;
    totalPaidCents: number;
    monthEndDate: string;
  };
}

export default function ActiveDashboard() {
  const { user } = useAuth();
  const { data: accounts = [], refetch: refetchAccounts } = useAccounts();
  const { data: plan, refetch: refetchPlan } = useActivePlan();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: combinedFinances } = useQuery<CombinedFinancesResponse>({
    queryKey: ["/api/current-finances/combined"],
  });

  const { data: upcomingBillsData } = useQuery<UpcomingBillsResponse>({
    queryKey: ["/api/projections/upcoming"],
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        refetchAccounts(),
        refetchPlan(),
        queryClient.invalidateQueries({ queryKey: ["/api/budget"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] }),
        queryClient.invalidateQueries({ queryKey: ["/api/projections/upcoming"] }),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  if (!plan || !accounts) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }

  const pacing = combinedFinances?.combined?.currentMonthPacing;
  const historicalAvgSpend = combinedFinances?.combined 
    ? combinedFinances.combined.fixedCostsCents + combinedFinances.combined.essentialsCents + combinedFinances.combined.discretionaryCents
    : 0;
  const availableForDebt = combinedFinances?.combined?.availableForDebtCents || 0;
  const upcomingBillsTotal = upcomingBillsData?.summary?.totalUpcomingCents || 0;
  const safeToSpend = Math.max(0, availableForDebt - upcomingBillsTotal);
  
  const pacingPercent = pacing && historicalAvgSpend > 0 
    ? Math.round((pacing.currentMonthSpendCents / historicalAvgSpend) * 100)
    : 0;
  const expectedPacingPercent = pacing 
    ? Math.round((pacing.daysPassed / pacing.totalDaysInMonth) * 100)
    : 0;

  const currentMonthIndex = getCurrentMonthIndex(plan);
  const stats = getDashboardStats(plan, accounts, currentMonthIndex);
  
  const nextPayoffAccountName = stats.nextAccountSettle === 0 
    ? "Soon!" 
    : plan.accountSchedules?.find(
        (s) => s.payoffTimeMonths - (currentMonthIndex + 1) === stats.nextAccountSettle
      )?.lenderName || "Unknown";

  const statCards = [
    {
      title: "Current Total Debt",
      value: formatCurrency(stats.totalCurrentDebt, user?.currency),
      description: currentMonthIndex === -1 ? "Starting balance" : "As of this month",
      icon: DollarSign,
      iconColor: "text-blue-500",
    },
    {
      title: "Total Paid So Far",
      value: formatCurrency(stats.totalPaidSoFar, user?.currency),
      description: currentMonthIndex === -1 ? "Plan not started yet" : `${currentMonthIndex + 1} payment${currentMonthIndex !== 0 ? 's' : ''} made`,
      icon: CheckCircle2,
      iconColor: "text-green-500",
    },
    {
      title: "Next Account Payoff",
      value: stats.nextAccountSettle === 0 ? "This month!" : `${stats.nextAccountSettle} month${stats.nextAccountSettle !== 1 ? 's' : ''}`,
      description: nextPayoffAccountName,
      icon: Target,
      iconColor: "text-orange-500",
    },
    {
      title: "Debt-Free Date",
      value: stats.allAccountsSettle === 0 ? "Debt-Free!" : `${stats.allAccountsSettle} month${stats.allAccountsSettle !== 1 ? 's' : ''}`,
      description: stats.allAccountsSettle === 0 ? "Congratulations!" : "Remaining until debt-free",
      icon: TrendingDown,
      iconColor: "text-purple-500",
    },
    {
      title: "Next Payment",
      value: formatCurrency(stats.nextPayment.amount, user?.currency),
      description: `Due ${stats.nextPayment.date.toLocaleDateString("en-US", { month: "short", year: "numeric" })} • ${stats.nextPayment.account}`,
      icon: Calendar,
      iconColor: "text-pink-500",
    },
  ];

  return (
    <div className="container mx-auto max-w-7xl px-4 py-8">
      <div className="space-y-8">
        {/* Header */}
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-4xl font-bold" data-testid="text-dashboard-title">
              Dashboard
            </h1>
            <p className="text-muted-foreground mt-1">
              Track your progress and stay on target
            </p>
          </div>
          <div className="flex gap-3">
            <Button 
              variant="outline" 
              onClick={handleRefresh}
              disabled={isRefreshing}
              data-testid="button-refresh-dashboard"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </Button>
            <Button asChild variant="outline" data-testid="button-browse-accounts">
              <Link href="/accounts">
                <CreditCard className="h-4 w-4 mr-2" />
                Browse Accounts
              </Link>
            </Button>
            <Button asChild data-testid="button-view-full-plan">
              <Link href="/plan">
                <BarChart3 className="h-4 w-4 mr-2" />
                View Full Plan
              </Link>
            </Button>
          </div>
        </div>

        {/* Budget Reality Section */}
        {combinedFinances?.combined && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-xl font-semibold">Your Budget Reality</h2>
              <Button asChild variant="ghost" size="sm" data-testid="button-view-finances">
                <Link href="/current-finances">
                  View Details
                  <ArrowRight className="h-4 w-4 ml-1" />
                </Link>
              </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Safe-to-Spend Card */}
              <Card data-testid="card-safe-to-spend">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Safe to Spend</CardTitle>
                  <Wallet className="h-5 w-5 text-green-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono text-green-600 dark:text-green-400" data-testid="text-safe-to-spend">
                    {formatCurrency(safeToSpend, user?.currency)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    After upcoming bills ({formatCurrency(upcomingBillsTotal, user?.currency)})
                  </p>
                </CardContent>
              </Card>

              {/* Pacing Card */}
              <Card data-testid="card-pacing">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Monthly Pacing</CardTitle>
                  <Clock className="h-5 w-5 text-blue-500" />
                </CardHeader>
                <CardContent>
                  <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold font-mono" data-testid="text-pacing-current">
                      {formatCurrency(pacing?.currentMonthSpendCents || 0, user?.currency)}
                    </span>
                    <span className="text-sm text-muted-foreground">
                      of {formatCurrency(historicalAvgSpend, user?.currency)} avg
                    </span>
                  </div>
                  <div className="mt-2 space-y-1">
                    <Progress 
                      value={Math.min(pacingPercent, 100)} 
                      className={`h-2 ${pacingPercent > expectedPacingPercent + 10 ? '[&>div]:bg-amber-500' : ''}`}
                    />
                    <div className="flex justify-between text-xs text-muted-foreground">
                      <span>{pacingPercent}% spent</span>
                      <span>{pacing ? `Day ${pacing.daysPassed} of ${pacing.totalDaysInMonth}` : ''}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Upcoming Bills Card */}
              <Card data-testid="card-upcoming-bills-summary">
                <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">Upcoming Bills</CardTitle>
                  <Receipt className="h-5 w-5 text-amber-500" />
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold font-mono" data-testid="text-upcoming-bills-total">
                    {formatCurrency(upcomingBillsTotal, user?.currency)}
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {upcomingBillsData?.summary?.totalUpcomingCount || 0} bills due this month
                  </p>
                </CardContent>
              </Card>
            </div>
          </div>
        )}

        {/* Upcoming Bills List */}
        {upcomingBillsData && upcomingBillsData.upcomingBills.length > 0 && (
          <Card data-testid="card-upcoming-bills-list">
            <CardHeader>
              <CardTitle>Upcoming Bills</CardTitle>
              <CardDescription>Bills due before month end</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {upcomingBillsData.upcomingBills.slice(0, 5).map((bill) => (
                  <div 
                    key={bill.id} 
                    className="flex items-center justify-between p-3 rounded-lg border"
                    data-testid={`bill-item-${bill.id}`}
                  >
                    <div className="flex items-center gap-3">
                      <div className={`h-10 w-10 rounded-full flex items-center justify-center ${
                        bill.status === 'OVERDUE' ? 'bg-red-100 dark:bg-red-900' : 'bg-muted'
                      }`}>
                        {bill.status === 'OVERDUE' ? (
                          <AlertCircle className="h-5 w-5 text-red-500" />
                        ) : (
                          <Receipt className="h-5 w-5 text-muted-foreground" />
                        )}
                      </div>
                      <div>
                        <div className="font-medium">{bill.merchantName}</div>
                        <div className="text-sm text-muted-foreground">
                          Due {new Date(bill.dueDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      {bill.status === 'OVERDUE' && (
                        <Badge variant="destructive">Overdue</Badge>
                      )}
                      <span className="font-mono font-semibold">
                        {formatCurrency(bill.amountCents, user?.currency)}
                      </span>
                    </div>
                  </div>
                ))}
                {upcomingBillsData.upcomingBills.length > 5 && (
                  <div className="text-center text-sm text-muted-foreground pt-2">
                    +{upcomingBillsData.upcomingBills.length - 5} more bills
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Debt Plan Stats Grid */}
        <div className="space-y-4">
          <h2 className="text-xl font-semibold">Debt Payoff Progress</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {statCards.map((stat, index) => (
              <Card key={index} data-testid={`card-stat-${index}`}>
                <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                  <CardTitle className="text-sm font-medium">
                    {stat.title}
                  </CardTitle>
                  <stat.icon className={`h-5 w-5 ${stat.iconColor}`} />
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold font-mono" data-testid={`text-stat-value-${index}`}>
                  {stat.value}
                </div>
                <p className="text-xs text-muted-foreground mt-1" data-testid={`text-stat-description-${index}`}>
                  {stat.description}
                </p>
              </CardContent>
            </Card>
          ))}
          </div>
        </div>

        {/* Quick Actions */}
        <Card>
          <CardHeader>
            <CardTitle>Quick Actions</CardTitle>
            <CardDescription>
              Common tasks to manage your debt payoff plan
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              <Button
                asChild
                variant="outline"
                className="h-auto py-4 flex-col items-start hover-elevate"
                data-testid="button-quick-add-account"
              >
                <Link href="/accounts">
                  <CreditCard className="h-6 w-6 mb-2" />
                  <div className="text-left">
                    <div className="font-semibold">Manage Accounts</div>
                    <div className="text-xs text-muted-foreground font-normal">
                      Add, edit, or remove debt accounts
                    </div>
                  </div>
                </Link>
              </Button>

              <Button
                asChild
                variant="outline"
                className="h-auto py-4 flex-col items-start hover-elevate"
                data-testid="button-quick-adjust-budget"
              >
                <Link href="/budget">
                  <DollarSign className="h-6 w-6 mb-2" />
                  <div className="text-left">
                    <div className="font-semibold">Adjust Budget</div>
                    <div className="text-xs text-muted-foreground font-normal">
                      Update your monthly payment budget
                    </div>
                  </div>
                </Link>
              </Button>

              <div className="h-auto py-4 flex-col items-start">
                <FindMyBudgetButton variant="outline" className="h-full w-full justify-start flex-col items-start hover-elevate" />
                <div className="text-xs text-muted-foreground font-normal mt-2 px-1">
                  AI-powered budget analysis based on your transactions
                </div>
              </div>

              <Button
                asChild
                variant="outline"
                className="h-auto py-4 flex-col items-start hover-elevate"
                data-testid="button-quick-regenerate-plan"
              >
                <Link href="/generate">
                  <BarChart3 className="h-6 w-6 mb-2" />
                  <div className="text-left">
                    <div className="font-semibold">Regenerate Plan</div>
                    <div className="text-xs text-muted-foreground font-normal">
                      Create a new optimized plan
                    </div>
                  </div>
                </Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        {/* Account Summary */}
        <Card>
          <CardHeader>
            <CardTitle>Your Accounts</CardTitle>
            <CardDescription>
              {accounts.length} account{accounts.length !== 1 ? 's' : ''} being tracked
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {accounts.slice(0, 5).map((account) => (
                <div
                  key={account.id}
                  className="flex items-center justify-between p-3 rounded-lg border hover-elevate"
                  data-testid={`card-account-${account.id}`}
                >
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-full bg-primary/10 flex items-center justify-center">
                      <CreditCard className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <div className="font-semibold" data-testid={`text-account-name-${account.id}`}>
                        {account.lenderName}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {account.accountType}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono font-semibold" data-testid={`text-account-balance-${account.id}`}>
                      {formatCurrency(account.currentBalanceCents, user?.currency)}
                    </div>
                    <div className="text-sm text-muted-foreground">
                      {(account.aprStandardBps / 100).toFixed(2)}% APR
                    </div>
                  </div>
                </div>
              ))}
              {accounts.length > 5 && (
                <Button
                  asChild
                  variant="ghost"
                  className="w-full"
                  data-testid="button-view-all-accounts"
                >
                  <Link href="/accounts">
                    View all {accounts.length} accounts
                  </Link>
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
