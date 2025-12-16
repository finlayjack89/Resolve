import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  ArrowLeft, 
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Building2,
  Clock,
  Briefcase,
  CheckCircle2,
  AlertCircle,
  Wallet,
  Home,
  Car,
  ShoppingCart,
  Utensils,
  Heart,
  Zap,
  CreditCard,
  Gift,
  HelpCircle,
  RotateCw,
  ShoppingBag,
  Ticket,
  ArrowLeftRight,
  Info,
  Sparkles
} from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { formatDistanceToNow, format, isSameMonth, startOfMonth } from "date-fns";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";

interface CategoryBreakdown {
  category: string;
  displayName: string;
  budgetGroup: string;
  icon: string;
  color: string;
  totalCents: number;
  transactionCount: number;
  percentage: number;
}

interface EnrichedTransactionDetail {
  id: string;
  trueLayerTransactionId: string;
  originalDescription: string;
  merchantCleanName: string | null;
  merchantLogoUrl: string | null;
  amountCents: number;
  entryType: string;
  ukCategory: string | null;
  budgetCategory: string | null;
  masterCategory: string | null;
  transactionDate: string | null;
  isRecurring: boolean | null;
  recurrenceFrequency: string | null;
  isSubscription: boolean | null;
}

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

interface AccountDetailResponse {
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
  transactions: EnrichedTransactionDetail[];
  categoryBreakdown: CategoryBreakdown[];
}

const categoryIcons: Record<string, typeof Wallet> = {
  // Income
  employment: Briefcase,
  benefits: Gift,
  pension: Wallet,
  investment_income: TrendingUp,
  rental_income: Home,
  side_hustle: Briefcase,
  other_income: Wallet,
  // Fixed Costs
  rent: Home,
  mortgage: Home,
  council_tax: Building2,
  utilities: Zap,
  insurance: Heart,
  childcare: Heart,
  // Essentials
  groceries: ShoppingCart,
  transport: Car,
  healthcare: Heart,
  education: Gift,
  // Discretionary
  subscriptions: CreditCard,
  entertainment: Gift,
  dining: Utensils,
  shopping: ShoppingCart,
  personal_care: Heart,
  travel: Car,
  gifts: Gift,
  // Debt & Savings
  debt_payment: CreditCard,
  savings: Wallet,
  // Other
  transfer: TrendingDown,
  cash: Wallet,
  fees: CreditCard,
  other: HelpCircle,
};

const budgetGroupColors: Record<string, string> = {
  income: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  fixed_costs: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  essentials: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  discretionary: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  debt: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-200",
};

const masterCategoryConfig: Record<string, { icon: typeof Wallet; color: string; displayName: string }> = {
  bills_utilities: { icon: Zap, color: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300", displayName: "Bills & Utilities" },
  subscriptions: { icon: RotateCw, color: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300", displayName: "Subscriptions" },
  transport: { icon: Car, color: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300", displayName: "Transport" },
  groceries: { icon: ShoppingCart, color: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300", displayName: "Groceries" },
  eating_out: { icon: Utensils, color: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300", displayName: "Eating Out" },
  shopping: { icon: ShoppingBag, color: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300", displayName: "Shopping" },
  entertainment: { icon: Ticket, color: "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300", displayName: "Entertainment" },
  health_wellbeing: { icon: Heart, color: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300", displayName: "Health & Wellbeing" },
  transfers: { icon: ArrowLeftRight, color: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300", displayName: "Transfers" },
  income: { icon: TrendingUp, color: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300", displayName: "Income" },
  uncategorized: { icon: HelpCircle, color: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300", displayName: "Uncategorized" },
};

interface ReasoningStep {
  step: string;
  input: string;
  output: string;
  confidence?: number;
}

interface ReasoningTrace {
  steps: ReasoningStep[];
  finalDecision: string;
  totalConfidence: number;
}

interface TransactionTraceResponse {
  transactionId: string;
  merchantName: string | null;
  amountCents: number;
  transactionDate: string | null;
  masterCategory: string | null;
  aiConfidenceScore: number | null;
  reasoningTrace: ReasoningTrace | null;
  isSubscription: boolean | null;
  subscriptionDetails: {
    id: string;
    productName: string;
    merchantName: string;
    category: string | null;
  } | null;
  userCorrectedCategory: string | null;
}

function CategoryBadgeWithTrace({ 
  transactionId, 
  masterCategory, 
  catConfig 
}: { 
  transactionId: string; 
  masterCategory: string;
  catConfig: { icon: typeof Wallet; color: string; displayName: string };
}) {
  const [isOpen, setIsOpen] = useState(false);
  const CategoryIcon = catConfig.icon;
  
  const { data: traceData, isLoading } = useQuery<TransactionTraceResponse>({
    queryKey: ['/api/transactions', transactionId, 'trace'],
    enabled: isOpen,
  });

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Badge 
          variant="secondary" 
          className={`${catConfig.color} text-xs font-medium cursor-pointer hover-elevate`}
          data-testid={`badge-category-${transactionId}`}
        >
          <CategoryIcon className="h-3 w-3 mr-1" />
          {catConfig.displayName}
          <Info className="h-3 w-3 ml-1 opacity-60" />
        </Badge>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-primary" />
            <h4 className="font-semibold text-sm">How was this categorized?</h4>
          </div>
          
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-5/6" />
            </div>
          ) : traceData?.reasoningTrace ? (
            <div className="space-y-3">
              {traceData.reasoningTrace.steps.map((step, idx) => (
                <div key={idx} className="text-xs space-y-1 border-l-2 border-muted pl-3">
                  <p className="font-medium text-muted-foreground">{step.step}</p>
                  <p className="text-foreground">{step.output}</p>
                </div>
              ))}
              <div className="pt-2 border-t">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Final Decision</span>
                  <Badge variant="outline" className="text-xs">
                    {traceData.reasoningTrace.finalDecision}
                  </Badge>
                </div>
                {traceData.aiConfidenceScore && (
                  <div className="flex items-center justify-between text-xs mt-1">
                    <span className="text-muted-foreground">Confidence</span>
                    <span className="font-mono">{Math.round(traceData.aiConfidenceScore * 100)}%</span>
                  </div>
                )}
              </div>
              {traceData.isSubscription && traceData.subscriptionDetails && (
                <div className="pt-2 border-t">
                  <div className="flex items-center gap-1 text-xs text-purple-600 dark:text-purple-400">
                    <RotateCw className="h-3 w-3" />
                    <span>Matched subscription: {traceData.subscriptionDetails.productName}</span>
                  </div>
                </div>
              )}
              {traceData.userCorrectedCategory && (
                <div className="pt-2 border-t">
                  <div className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                    <CheckCircle2 className="h-3 w-3" />
                    <span>You corrected this to: {traceData.userCorrectedCategory}</span>
                  </div>
                </div>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              No detailed reasoning available for this transaction.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface MonthGroup {
  monthKey: string;
  monthLabel: string;
  isMTD: boolean;
  transactions: EnrichedTransactionDetail[];
  totalIncomeCents: number;
  totalOutgoingCents: number;
  categoryBreakdown: {
    category: string;
    transactions: EnrichedTransactionDetail[];
    totalCents: number;
  }[];
}

function groupTransactionsByMonth(transactions: EnrichedTransactionDetail[]): MonthGroup[] {
  const now = new Date();
  const monthMap = new Map<string, EnrichedTransactionDetail[]>();

  transactions.forEach(tx => {
    if (!tx.transactionDate) return;
    const date = new Date(tx.transactionDate);
    const monthKey = format(startOfMonth(date), "yyyy-MM");
    if (!monthMap.has(monthKey)) {
      monthMap.set(monthKey, []);
    }
    monthMap.get(monthKey)!.push(tx);
  });

  const sortedMonthKeys = Array.from(monthMap.keys()).sort((a, b) => b.localeCompare(a));

  return sortedMonthKeys.map(monthKey => {
    const txs = monthMap.get(monthKey)!;
    const firstDate = new Date(txs[0].transactionDate!);
    const isMTD = isSameMonth(firstDate, now);
    const monthLabel = isMTD 
      ? `${format(firstDate, "MMMM")} (MTD)` 
      : format(firstDate, "MMMM yyyy");

    const totalIncomeCents = txs
      .filter(tx => tx.entryType === "incoming")
      .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
    const totalOutgoingCents = txs
      .filter(tx => tx.entryType === "outgoing")
      .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);

    const categoryMap = new Map<string, EnrichedTransactionDetail[]>();
    txs.forEach(tx => {
      const cat = tx.ukCategory || "other";
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, []);
      }
      categoryMap.get(cat)!.push(tx);
    });

    const categoryBreakdown = Array.from(categoryMap.entries()).map(([category, catTxs]) => ({
      category,
      transactions: catTxs.sort((a, b) => {
        if (!a.transactionDate || !b.transactionDate) return 0;
        return new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime();
      }),
      totalCents: catTxs.reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0),
    })).sort((a, b) => b.totalCents - a.totalCents);

    return {
      monthKey,
      monthLabel,
      isMTD,
      transactions: txs.sort((a, b) => {
        if (!a.transactionDate || !b.transactionDate) return 0;
        return new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime();
      }),
      totalIncomeCents,
      totalOutgoingCents,
      categoryBreakdown,
    };
  });
}

export default function BankAccountDetail() {
  const [match, params] = useRoute("/current-finances/:id");
  const { user } = useAuth();
  const { toast } = useToast();
  const accountId = params?.id;
  const currency = user?.currency || "GBP";
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);

  const { data: account, isLoading, refetch } = useQuery<AccountDetailResponse>({
    queryKey: ["/api/current-finances/account", accountId],
    queryFn: async () => {
      const response = await fetch(`/api/current-finances/account/${accountId}`, { credentials: "include" });
      if (!response.ok) throw new Error("Failed to fetch account details");
      return response.json();
    },
    enabled: !!accountId,
  });

  const analyzeMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", `/api/current-finances/account/${accountId}/analyze`);
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/account", accountId] });
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
      toast({ title: "Analysis complete", description: "Transactions have been re-analyzed." });
    },
    onError: () => {
      toast({ title: "Analysis failed", description: "Could not analyze transactions.", variant: "destructive" });
    },
  });

  const toggleSideHustleMutation = useMutation({
    mutationFn: async (isSideHustle: boolean) => {
      const response = await apiRequest("PATCH", `/api/truelayer/item/${accountId}`, { isSideHustle });
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/account", accountId] });
      queryClient.invalidateQueries({ queryKey: ["/api/current-finances/combined"] });
      toast({ title: "Updated", description: "Account preference saved." });
    },
    onError: () => {
      toast({ title: "Error", description: "Could not update preference.", variant: "destructive" });
    },
  });

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full" data-testid="loading-spinner" />
      </div>
    );
  }

  if (!account) {
    return (
      <div className="container mx-auto max-w-4xl px-4 py-12">
        <Card>
          <CardHeader>
            <CardTitle>Account Not Found</CardTitle>
            <CardDescription>
              The bank account you're looking for doesn't exist or has been disconnected.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild data-testid="button-back-to-finances">
              <Link href="/current-finances">
                <ArrowLeft className="h-4 w-4 mr-2" />
                Back to Current Finances
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  const isConnected = account.connectionStatus === "connected" || account.connectionStatus === "active";
  const lastSynced = account.lastSyncedAt 
    ? formatDistanceToNow(new Date(account.lastSyncedAt), { addSuffix: true })
    : "Never";

  const filterByCategory = (transactions: EnrichedTransactionDetail[]) => {
    if (!selectedCategory) return transactions;
    return transactions.filter(tx => tx.ukCategory === selectedCategory);
  };

  const filteredTransactions = filterByCategory(account.transactions);
  const incomeTransactions = filterByCategory(account.transactions.filter(tx => tx.entryType === "incoming"));
  const outgoingTransactions = filterByCategory(account.transactions.filter(tx => tx.entryType === "outgoing"));

  const selectedCategoryDisplay = selectedCategory 
    ? account.categoryBreakdown.find(c => c.category === selectedCategory)?.displayName || selectedCategory.replace(/_/g, " ")
    : null;

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      <div className="space-y-6">
        {/* Header with Back Button */}
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Button variant="ghost" asChild data-testid="button-back">
            <Link href="/current-finances">
              <ArrowLeft className="h-4 w-4 mr-2" />
              Back to Current Finances
            </Link>
          </Button>
          <Button
            onClick={() => analyzeMutation.mutate()}
            disabled={analyzeMutation.isPending}
            variant="outline"
            data-testid="button-reanalyze"
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${analyzeMutation.isPending ? "animate-spin" : ""}`} />
            Re-analyze
          </Button>
        </div>

        {/* Account Header Card */}
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="flex items-center gap-4">
                {account.institutionLogoUrl ? (
                  <img
                    src={account.institutionLogoUrl}
                    alt={account.institutionName}
                    className="h-14 w-14 rounded-full object-contain bg-white border"
                    data-testid="img-institution"
                  />
                ) : (
                  <div className="h-14 w-14 rounded-full bg-muted flex items-center justify-center">
                    <Building2 className="h-7 w-7 text-muted-foreground" />
                  </div>
                )}
                <div>
                  <CardTitle className="text-2xl" data-testid="text-institution-name">
                    {account.institutionName}
                  </CardTitle>
                  <CardDescription className="text-base" data-testid="text-account-name">
                    {account.accountName}
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-3">
                {isConnected ? (
                  <Badge variant="secondary" className="gap-1 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                    <CheckCircle2 className="h-3 w-3" />
                    Connected
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="gap-1 bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200">
                    <AlertCircle className="h-3 w-3" />
                    Disconnected
                  </Badge>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Clock className="h-4 w-4" />
                <span data-testid="text-last-synced">Last synced {lastSynced}</span>
                <span className="mx-2">|</span>
                <span data-testid="text-transaction-count">{account.transactionCount} transactions</span>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="side-hustle"
                  checked={account.isSideHustle || false}
                  onCheckedChange={(checked) => toggleSideHustleMutation.mutate(checked)}
                  disabled={toggleSideHustleMutation.isPending}
                  data-testid="switch-side-hustle"
                />
                <Label htmlFor="side-hustle" className="flex items-center gap-1 cursor-pointer">
                  <Briefcase className="h-4 w-4" />
                  Side Hustle Account
                </Label>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Summary Cards */}
        {account.analysisSummary && (
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Monthly Income</CardTitle>
                <TrendingUp className="h-4 w-4 text-green-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold text-green-600 dark:text-green-400" data-testid="text-income">
                  {formatCurrency(account.analysisSummary.averageMonthlyIncomeCents, currency)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Fixed Costs</CardTitle>
                <Building2 className="h-4 w-4 text-blue-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold" data-testid="text-fixed-costs">
                  {formatCurrency(account.analysisSummary.fixedCostsCents, currency)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Essentials</CardTitle>
                <Wallet className="h-4 w-4 text-amber-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold" data-testid="text-essentials">
                  {formatCurrency(account.analysisSummary.essentialsCents, currency)}
                </p>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
                <CardTitle className="text-sm font-medium">Discretionary</CardTitle>
                <Gift className="h-4 w-4 text-purple-500" />
              </CardHeader>
              <CardContent>
                <p className="text-2xl font-mono font-bold" data-testid="text-discretionary">
                  {formatCurrency(account.analysisSummary.discretionaryCents, currency)}
                </p>
              </CardContent>
            </Card>
          </div>
        )}

        {/* Category Breakdown */}
        {account.categoryBreakdown.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>Spending by Category</CardTitle>
              <CardDescription>Click a category to filter transactions</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {account.categoryBreakdown.map((cat) => {
                  const IconComponent = categoryIcons[cat.category] || HelpCircle;
                  const isSelected = selectedCategory === cat.category;
                  return (
                    <div 
                      key={cat.category} 
                      className={`space-y-2 p-2 rounded-md cursor-pointer hover-elevate transition-all ${isSelected ? "ring-2 ring-primary bg-primary/5" : ""}`}
                      onClick={() => setSelectedCategory(isSelected ? null : cat.category)}
                      data-testid={`filter-category-${cat.category}`}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <IconComponent className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{cat.displayName}</span>
                          <Badge variant="secondary" className={budgetGroupColors[cat.budgetGroup] || budgetGroupColors.other}>
                            {cat.budgetGroup.replace("_", " ")}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-4">
                          <span className="text-sm text-muted-foreground">{cat.transactionCount} txns</span>
                          <span className="font-mono font-semibold">{formatCurrency(cat.totalCents, currency)}</span>
                        </div>
                      </div>
                      <Progress value={cat.percentage} className="h-2" />
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Transaction Tabs */}
        <div className="space-y-4">
          {selectedCategory && (
            <div className="flex items-center gap-2">
              <Badge 
                variant="secondary" 
                className="gap-1"
                data-testid="badge-active-filter"
              >
                Filtered: {selectedCategoryDisplay}
              </Badge>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setSelectedCategory(null)}
                data-testid="button-clear-filter"
              >
                Clear
              </Button>
            </div>
          )}
          <Tabs defaultValue="all" className="w-full">
            <TabsList className="grid w-full grid-cols-4">
              <TabsTrigger value="all" data-testid="tab-all">All ({filteredTransactions.length})</TabsTrigger>
              <TabsTrigger value="income" data-testid="tab-income">Income ({incomeTransactions.length})</TabsTrigger>
              <TabsTrigger value="outgoing" data-testid="tab-outgoing">Outgoing ({outgoingTransactions.length})</TabsTrigger>
              <TabsTrigger value="monthly" data-testid="tab-monthly">Monthly</TabsTrigger>
            </TabsList>
            
            <TabsContent value="all">
              <TransactionTable transactions={filteredTransactions} currency={currency} />
            </TabsContent>
            
            <TabsContent value="income">
              <TransactionTable transactions={incomeTransactions} currency={currency} />
            </TabsContent>
            
            <TabsContent value="outgoing">
              <TransactionTable transactions={outgoingTransactions} currency={currency} />
            </TabsContent>

            <TabsContent value="monthly">
              <MonthlyBreakdown transactions={filteredTransactions} currency={currency} />
            </TabsContent>
          </Tabs>
        </div>
      </div>
    </div>
  );
}

function TransactionTable({ transactions, currency }: { transactions: EnrichedTransactionDetail[]; currency: string }) {
  if (transactions.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No transactions in this category
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Date</TableHead>
            <TableHead>Description</TableHead>
            <TableHead>Category</TableHead>
            <TableHead className="text-right">Amount</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.slice(0, 50).map((tx) => {
            const masterCat = tx.masterCategory || "uncategorized";
            const catConfig = masterCategoryConfig[masterCat] || masterCategoryConfig.uncategorized;
            const CategoryIcon = catConfig.icon;
            const isIncoming = tx.entryType === "incoming";
            return (
              <TableRow key={tx.id} data-testid={`row-transaction-${tx.id}`}>
                <TableCell className="text-muted-foreground whitespace-nowrap">
                  {tx.transactionDate ? format(new Date(tx.transactionDate), "MMM d, yyyy") : "—"}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0 overflow-hidden">
                      {tx.merchantLogoUrl ? (
                        <img src={tx.merchantLogoUrl} alt="" className="h-full w-full object-cover" />
                      ) : (
                        <CategoryIcon className="h-4 w-4 text-muted-foreground" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium truncate">{tx.merchantCleanName || tx.originalDescription}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {tx.isSubscription && (
                          <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5">
                            <RotateCw className="h-3 w-3 mr-1" />
                            Subscription
                          </Badge>
                        )}
                        {tx.isRecurring && !tx.isSubscription && (
                          <Badge variant="outline" className="text-xs px-1.5 py-0 h-5">
                            <Clock className="h-3 w-3 mr-1" />
                            Recurring
                          </Badge>
                        )}
                      </div>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <CategoryBadgeWithTrace
                    transactionId={tx.id}
                    masterCategory={masterCat}
                    catConfig={catConfig}
                  />
                </TableCell>
                <TableCell className={`text-right font-mono font-semibold whitespace-nowrap ${isIncoming ? "text-green-600 dark:text-green-400" : ""}`}>
                  {isIncoming ? "+" : "-"}{formatCurrency(Math.abs(tx.amountCents), currency)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {transactions.length > 50 && (
        <div className="p-4 text-center text-sm text-muted-foreground border-t">
          Showing 50 of {transactions.length} transactions
        </div>
      )}
    </Card>
  );
}

function MonthlyBreakdown({ transactions, currency }: { transactions: EnrichedTransactionDetail[]; currency: string }) {
  const monthGroups = groupTransactionsByMonth(transactions);

  if (monthGroups.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No transactions to display
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="monthly-breakdown-card">
      <Accordion type="multiple" className="w-full">
        {monthGroups.map((month) => (
          <AccordionItem key={month.monthKey} value={month.monthKey} data-testid={`month-item-${month.monthKey}`}>
            <AccordionTrigger className="px-4 hover:no-underline" data-testid={`month-trigger-${month.monthKey}`}>
              <div className="flex flex-1 items-center justify-between pr-4">
                <div className="flex items-center gap-3">
                  <span className="font-semibold" data-testid={`month-label-${month.monthKey}`}>{month.monthLabel}</span>
                  <Badge variant="secondary" data-testid={`month-count-${month.monthKey}`}>
                    {month.transactions.length} txns
                  </Badge>
                </div>
                <div className="flex items-center gap-4">
                  {month.totalIncomeCents > 0 && (
                    <span className="text-sm font-mono font-medium text-green-600 dark:text-green-400" data-testid={`month-income-${month.monthKey}`}>
                      +{formatCurrency(month.totalIncomeCents, currency)}
                    </span>
                  )}
                  {month.totalOutgoingCents > 0 && (
                    <span className="text-sm font-mono font-medium" data-testid={`month-outgoing-${month.monthKey}`}>
                      -{formatCurrency(month.totalOutgoingCents, currency)}
                    </span>
                  )}
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4">
              <div className="space-y-4">
                {month.categoryBreakdown.map((catGroup) => {
                  const IconComponent = categoryIcons[catGroup.category] || HelpCircle;
                  return (
                    <div key={catGroup.category} className="space-y-2" data-testid={`monthly-category-${month.monthKey}-${catGroup.category}`}>
                      <div className="flex items-center justify-between py-2 border-b">
                        <div className="flex items-center gap-2">
                          <IconComponent className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium capitalize">{catGroup.category.replace(/_/g, " ")}</span>
                          <span className="text-sm text-muted-foreground">({catGroup.transactions.length})</span>
                        </div>
                        <span className="font-mono font-semibold">{formatCurrency(catGroup.totalCents, currency)}</span>
                      </div>
                      <div className="pl-6 space-y-1">
                        {catGroup.transactions.map((tx) => {
                          const isIncoming = tx.entryType === "incoming";
                          return (
                            <div 
                              key={tx.id} 
                              className="flex items-center justify-between py-1.5 text-sm"
                              data-testid={`monthly-tx-${tx.id}`}
                            >
                              <div className="flex items-center gap-2 min-w-0 flex-1">
                                {tx.merchantLogoUrl && (
                                  <img src={tx.merchantLogoUrl} alt="" className="h-5 w-5 rounded-full object-contain shrink-0" />
                                )}
                                <span className="truncate">{tx.merchantCleanName || tx.originalDescription}</span>
                                <span className="text-muted-foreground shrink-0">
                                  {tx.transactionDate ? format(new Date(tx.transactionDate), "MMM d") : "—"}
                                </span>
                              </div>
                              <span className={`font-mono shrink-0 ml-2 ${isIncoming ? "text-green-600 dark:text-green-400" : ""}`}>
                                {isIncoming ? "+" : "-"}{formatCurrency(Math.abs(tx.amountCents), currency)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </AccordionContent>
          </AccordionItem>
        ))}
      </Accordion>
    </Card>
  );
}
