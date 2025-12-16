import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { 
  Table, 
  TableBody, 
  TableCell, 
  TableHead, 
  TableHeader, 
  TableRow 
} from "@/components/ui/table";
import { 
  RotateCw, 
  CheckCircle2, 
  AlertCircle,
  Calendar,
  Tv,
  Music,
  Newspaper,
  Dumbbell,
  Shield,
  CreditCard,
  Cloud,
  Gamepad2,
  GraduationCap,
  HelpCircle
} from "lucide-react";
import { formatCurrency } from "@/lib/format";
import { useAuth } from "@/lib/auth-context";

interface Subscription {
  id: string;
  productName: string;
  merchantName: string;
  amountCents: number | null;
  currency: string | null;
  recurrencePeriod: string | null;
  subscriptionType: string | null;
  category: string | null;
  isVerified: boolean | null;
}

interface SubscriptionsResponse {
  subscriptions: Subscription[];
}

const categoryIcons: Record<string, typeof RotateCw> = {
  streaming: Tv,
  music: Music,
  news: Newspaper,
  fitness: Dumbbell,
  insurance: Shield,
  finance: CreditCard,
  software: Cloud,
  gaming: Gamepad2,
  education: GraduationCap,
};

const categoryColors: Record<string, string> = {
  streaming: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300",
  music: "bg-pink-100 text-pink-700 dark:bg-pink-900 dark:text-pink-300",
  news: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300",
  fitness: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300",
  insurance: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300",
  finance: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  software: "bg-slate-100 text-slate-700 dark:bg-slate-900 dark:text-slate-300",
  gaming: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300",
  education: "bg-cyan-100 text-cyan-700 dark:bg-cyan-900 dark:text-cyan-300",
};

const recurrenceLabels: Record<string, string> = {
  monthly: "Monthly",
  yearly: "Yearly",
  weekly: "Weekly",
  quarterly: "Quarterly",
};

export default function Subscriptions() {
  const { user } = useAuth();
  const currency = user?.currency || "GBP";

  const { data, isLoading, error } = useQuery<SubscriptionsResponse>({
    queryKey: ["/api/subscriptions"],
  });

  const subscriptions = data?.subscriptions || [];
  
  const totalMonthly = subscriptions.reduce((sum, sub) => {
    if (!sub.amountCents) return sum;
    const multiplier = sub.recurrencePeriod === "yearly" ? 1/12 : 
                       sub.recurrencePeriod === "quarterly" ? 1/3 :
                       sub.recurrencePeriod === "weekly" ? 4 : 1;
    return sum + (sub.amountCents * multiplier);
  }, 0);

  const totalYearly = totalMonthly * 12;

  const verifiedCount = subscriptions.filter(s => s.isVerified).length;

  if (isLoading) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <div className="space-y-6">
          <div className="space-y-2">
            <Skeleton className="h-8 w-48" />
            <Skeleton className="h-4 w-72" />
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
          <Skeleton className="h-96" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto max-w-6xl px-4 py-8">
        <Card>
          <CardContent className="py-8 text-center">
            <AlertCircle className="h-12 w-12 mx-auto text-destructive mb-4" />
            <p className="text-muted-foreground">Failed to load subscriptions</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="container mx-auto max-w-6xl px-4 py-8">
      <div className="space-y-6">
        <div>
          <h1 className="text-3xl font-bold" data-testid="text-page-title">Subscriptions</h1>
          <p className="text-muted-foreground">Track and manage your recurring payments</p>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Monthly Cost</CardTitle>
              <Calendar className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-mono font-bold" data-testid="text-monthly-cost">
                {formatCurrency(Math.round(totalMonthly), currency)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Estimated from all subscriptions</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Yearly Cost</CardTitle>
              <RotateCw className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-mono font-bold" data-testid="text-yearly-cost">
                {formatCurrency(Math.round(totalYearly), currency)}
              </p>
              <p className="text-xs text-muted-foreground mt-1">Total annual subscription spend</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Active Subscriptions</CardTitle>
              <CheckCircle2 className="h-4 w-4 text-green-500" />
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-mono font-bold" data-testid="text-subscription-count">
                {subscriptions.length}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{verifiedCount} verified</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Subscriptions</CardTitle>
            <CardDescription>
              Subscriptions detected from your transaction history
            </CardDescription>
          </CardHeader>
          <CardContent>
            {subscriptions.length === 0 ? (
              <div className="py-8 text-center text-muted-foreground">
                <RotateCw className="h-12 w-12 mx-auto mb-4 opacity-50" />
                <p>No subscriptions detected yet</p>
                <p className="text-sm mt-1">Connect your bank accounts to detect recurring payments</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Subscription</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead>Frequency</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscriptions.map((sub) => {
                    const CategoryIcon = (sub.category && categoryIcons[sub.category]) || HelpCircle;
                    const categoryColor = (sub.category && categoryColors[sub.category]) || "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";
                    
                    return (
                      <TableRow key={sub.id} data-testid={`row-subscription-${sub.id}`}>
                        <TableCell>
                          <div className="flex items-center gap-3">
                            <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center shrink-0">
                              <CategoryIcon className="h-4 w-4 text-muted-foreground" />
                            </div>
                            <div>
                              <p className="font-medium" data-testid={`text-product-${sub.id}`}>{sub.productName}</p>
                              <p className="text-sm text-muted-foreground">{sub.merchantName}</p>
                            </div>
                          </div>
                        </TableCell>
                        <TableCell>
                          {sub.category ? (
                            <Badge variant="secondary" className={`text-xs ${categoryColor}`}>
                              {sub.category.charAt(0).toUpperCase() + sub.category.slice(1)}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {sub.recurrencePeriod ? (
                            <Badge variant="outline" className="text-xs">
                              {recurrenceLabels[sub.recurrencePeriod] || sub.recurrencePeriod}
                            </Badge>
                          ) : (
                            <span className="text-muted-foreground text-sm">—</span>
                          )}
                        </TableCell>
                        <TableCell>
                          {sub.isVerified ? (
                            <Badge variant="secondary" className="gap-1 bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300 text-xs">
                              <CheckCircle2 className="h-3 w-3" />
                              Verified
                            </Badge>
                          ) : (
                            <Badge variant="secondary" className="gap-1 text-xs">
                              <AlertCircle className="h-3 w-3" />
                              Pending
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right font-mono font-semibold" data-testid={`text-amount-${sub.id}`}>
                          {sub.amountCents 
                            ? formatCurrency(sub.amountCents, sub.currency || currency)
                            : "—"
                          }
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
