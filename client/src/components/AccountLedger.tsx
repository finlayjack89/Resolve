import { format, startOfMonth, isSameMonth } from "date-fns";
import { Link2, ArrowDownLeft, ArrowUpRight, HelpCircle, Briefcase, Wallet, Home, Car, ShoppingCart, Utensils, Heart, Zap, CreditCard, Gift, Building2, TrendingUp, TrendingDown, Ghost, Info } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { formatCurrency } from "@/lib/format";

export interface LedgerTransaction {
  id: string;
  originalDescription: string;
  merchantCleanName: string | null;
  merchantLogoUrl: string | null;
  amountCents: number;
  entryType: string;
  ukCategory: string | null;
  transactionDate: string | null;
  isInternalTransfer?: boolean | null;
  excludeFromAnalysis?: boolean | null;
  isGhostTransaction?: boolean;
  linkedTransactionId?: string | null;
  linkedTransactionDetails?: {
    accountName: string;
    date: string;
    amount: number;
  } | null;
}

interface MonthGroup {
  monthKey: string;
  monthLabel: string;
  isMTD: boolean;
  transactions: LedgerTransaction[];
  totalInCents: number;
  totalOutCents: number;
  netFlowCents: number;
}

interface AccountLedgerProps {
  transactions: LedgerTransaction[];
  currency: string;
  showCategoryBreakdown?: boolean;
}

const categoryIcons: Record<string, typeof Wallet> = {
  employment: Briefcase,
  benefits: Gift,
  pension: Wallet,
  investment_income: TrendingUp,
  rental_income: Home,
  side_hustle: Briefcase,
  other_income: Wallet,
  rent: Home,
  mortgage: Home,
  council_tax: Building2,
  utilities: Zap,
  insurance: Heart,
  childcare: Heart,
  groceries: ShoppingCart,
  transport: Car,
  healthcare: Heart,
  education: Gift,
  subscriptions: CreditCard,
  entertainment: Gift,
  dining: Utensils,
  shopping: ShoppingCart,
  personal_care: Heart,
  travel: Car,
  gifts: Gift,
  debt_payment: CreditCard,
  savings: Wallet,
  transfer: TrendingDown,
  cash: Wallet,
  fees: CreditCard,
  other: HelpCircle,
};

function groupTransactionsByMonth(transactions: LedgerTransaction[]): MonthGroup[] {
  const now = new Date();
  const monthMap = new Map<string, LedgerTransaction[]>();

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
      ? `${format(firstDate, "MMMM")} (Month to Date)` 
      : format(firstDate, "MMMM yyyy");

    const totalInCents = txs
      .filter(tx => tx.entryType === "incoming")
      .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
    
    const totalOutCents = txs
      .filter(tx => tx.entryType === "outgoing")
      .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);

    const netFlowCents = totalInCents - totalOutCents;

    return {
      monthKey,
      monthLabel,
      isMTD,
      transactions: txs.sort((a, b) => {
        if (!a.transactionDate || !b.transactionDate) return 0;
        return new Date(b.transactionDate).getTime() - new Date(a.transactionDate).getTime();
      }),
      totalInCents,
      totalOutCents,
      netFlowCents,
    };
  });
}

export function AccountLedger({ transactions, currency, showCategoryBreakdown = false }: AccountLedgerProps) {
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
    <Card data-testid="account-ledger">
      <Accordion type="multiple" defaultValue={[monthGroups[0]?.monthKey]} className="w-full">
        {monthGroups.map((month) => (
          <AccordionItem key={month.monthKey} value={month.monthKey} data-testid={`ledger-month-${month.monthKey}`}>
            <AccordionTrigger className="px-4 hover:no-underline" data-testid={`ledger-trigger-${month.monthKey}`}>
              <div className="flex flex-1 items-center justify-between pr-4">
                <div className="flex items-center gap-3">
                  <span className="font-semibold" data-testid={`ledger-label-${month.monthKey}`}>
                    {month.monthLabel}
                  </span>
                  <Badge variant="secondary" data-testid={`ledger-count-${month.monthKey}`}>
                    {month.transactions.length} transactions
                  </Badge>
                </div>
                <div className="flex items-center gap-4">
                  <div className="flex items-center gap-1.5 text-sm">
                    <ArrowDownLeft className="h-3.5 w-3.5 text-green-500" />
                    <span className="font-mono font-medium text-green-600 dark:text-green-400" data-testid={`ledger-in-${month.monthKey}`}>
                      {formatCurrency(month.totalInCents, currency)}
                    </span>
                  </div>
                  <div className="flex items-center gap-1.5 text-sm">
                    <ArrowUpRight className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="font-mono font-medium" data-testid={`ledger-out-${month.monthKey}`}>
                      {formatCurrency(month.totalOutCents, currency)}
                    </span>
                  </div>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-0">
              <div className="divide-y">
                {month.transactions.map((tx) => {
                  const isIncoming = tx.entryType === "incoming";
                  const isTransfer = tx.isInternalTransfer === true;
                  const isGhost = tx.isGhostTransaction === true;
                  const IconComponent = categoryIcons[tx.ukCategory || "other"] || HelpCircle;
                  
                  return (
                    <div 
                      key={tx.id} 
                      className={`flex items-center justify-between px-4 py-3 ${isTransfer || isGhost ? "opacity-60" : ""}`}
                      data-testid={`ledger-tx-${tx.id}`}
                      data-transfer={isTransfer}
                      data-ghost={isGhost}
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className={`h-8 w-8 rounded-full flex items-center justify-center shrink-0 ${isGhost ? "bg-purple-100 dark:bg-purple-900/30" : "bg-muted"}`}>
                          {isGhost ? (
                            <Ghost className="h-4 w-4 text-purple-500" />
                          ) : isTransfer ? (
                            <Link2 className="h-4 w-4 text-muted-foreground" />
                          ) : tx.merchantLogoUrl ? (
                            <img src={tx.merchantLogoUrl} alt="" className="h-6 w-6 rounded-full object-contain" />
                          ) : (
                            <IconComponent className="h-4 w-4 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium truncate" data-testid={`ledger-tx-name-${tx.id}`}>
                              {tx.merchantCleanName || tx.originalDescription}
                            </span>
                            {isGhost && (
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <Badge variant="outline" className="gap-1 text-xs shrink-0 border-purple-300 text-purple-600 dark:border-purple-700 dark:text-purple-400" data-testid={`badge-ghost-ledger-${tx.id}`}>
                                    <Ghost className="h-3 w-3" />
                                    Ghost
                                    <Info className="h-3 w-3" />
                                  </Badge>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <p className="font-medium mb-1">Internal Transfer</p>
                                  <p className="text-sm text-muted-foreground mb-2">
                                    This is an internal transfer between your accounts. It's shown in your ledger but excluded from income/expense totals.
                                  </p>
                                  {tx.linkedTransactionDetails && (
                                    <div className="text-sm border-t pt-2 mt-2">
                                      <p className="font-medium">Matching transaction:</p>
                                      <p>Account: {tx.linkedTransactionDetails.accountName}</p>
                                      <p>Date: {format(new Date(tx.linkedTransactionDetails.date), "MMM d, yyyy")}</p>
                                      <p>Amount: {formatCurrency(Math.abs(tx.linkedTransactionDetails.amount), currency)}</p>
                                    </div>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            )}
                            {isTransfer && !isGhost && (
                              <Badge variant="outline" className="text-xs shrink-0">
                                Transfer
                              </Badge>
                            )}
                          </div>
                          <div className="text-sm text-muted-foreground">
                            {tx.transactionDate ? format(new Date(tx.transactionDate), "MMM d, yyyy") : "—"}
                            {tx.ukCategory && !isTransfer && !isGhost && (
                              <span className="ml-2 capitalize">
                                {tx.ukCategory.replace(/_/g, " ")}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                      <div className={`font-mono font-semibold shrink-0 ml-4 ${isIncoming ? "text-green-600 dark:text-green-400" : ""} ${isGhost ? "line-through decoration-1" : ""}`}>
                        {isIncoming ? "+" : "-"}{formatCurrency(Math.abs(tx.amountCents), currency)}
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

export function LedgerSummary({ transactions, currency }: { transactions: LedgerTransaction[]; currency: string }) {
  const totalIn = transactions
    .filter(tx => tx.entryType === "incoming")
    .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  
  const totalOut = transactions
    .filter(tx => tx.entryType === "outgoing")
    .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);

  const transfersIn = transactions
    .filter(tx => tx.entryType === "incoming" && tx.isInternalTransfer)
    .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);
  
  const transfersOut = transactions
    .filter(tx => tx.entryType === "outgoing" && tx.isInternalTransfer)
    .reduce((sum, tx) => sum + Math.abs(tx.amountCents), 0);

  return (
    <div className="grid grid-cols-2 gap-4" data-testid="ledger-summary">
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowDownLeft className="h-5 w-5 text-green-500" />
              <span className="text-sm font-medium">Total In</span>
            </div>
            <span className="text-xl font-mono font-bold text-green-600 dark:text-green-400" data-testid="ledger-total-in">
              {formatCurrency(totalIn, currency)}
            </span>
          </div>
          {transfersIn > 0 && (
            <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              Includes {formatCurrency(transfersIn, currency)} in transfers
            </div>
          )}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ArrowUpRight className="h-5 w-5 text-muted-foreground" />
              <span className="text-sm font-medium">Total Out</span>
            </div>
            <span className="text-xl font-mono font-bold" data-testid="ledger-total-out">
              {formatCurrency(totalOut, currency)}
            </span>
          </div>
          {transfersOut > 0 && (
            <div className="mt-2 text-xs text-muted-foreground flex items-center gap-1">
              <Link2 className="h-3 w-3" />
              Includes {formatCurrency(transfersOut, currency)} in transfers
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
