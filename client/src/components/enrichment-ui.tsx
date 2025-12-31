import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Progress } from "@/components/ui/progress";
import { Mail, Sparkles, AlertTriangle, ExternalLink, Loader2, Receipt, Search } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth-context";

interface ConnectEmailButtonProps {
  onConnected?: () => void;
  className?: string;
}

export function ConnectEmailButton({ onConnected, className }: ConnectEmailButtonProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isConnecting, setIsConnecting] = useState(false);

  const { data: grantStatus, isLoading: isCheckingGrants } = useQuery<{
    nylas_available: boolean;
    has_grants: boolean;
    message: string;
  }>({
    queryKey: ["/api/nylas/grants", user?.id],
    enabled: !!user?.id && user.id !== "guest-user",
  });

  const connectEmailMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("GET", `/api/nylas/auth-url?user_id=${user?.id}&redirect_uri=${encodeURIComponent(window.location.origin + "/current-finances?email_connected=true")}`);
      return response.json();
    },
    onSuccess: (data) => {
      if (data.auth_url) {
        setIsConnecting(true);
        window.location.href = data.auth_url;
      } else {
        toast({
          title: "Connection Error",
          description: data.error || "Failed to start email connection",
          variant: "destructive",
        });
      }
    },
    onError: (error: any) => {
      toast({
        title: "Connection Error", 
        description: error.message || "Failed to connect email",
        variant: "destructive",
      });
    },
  });

  const handleConnect = () => {
    if (user?.id === "guest-user") {
      toast({
        title: "Sign in required",
        description: "Please sign in to connect your email for enhanced receipt matching",
        variant: "destructive",
      });
      return;
    }
    connectEmailMutation.mutate();
  };

  if (isCheckingGrants) {
    return (
      <Button variant="outline" size="sm" disabled className={className} data-testid="button-connect-email-loading">
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
        Checking...
      </Button>
    );
  }

  if (grantStatus?.has_grants) {
    return (
      <Badge variant="outline" className={`border-green-500 text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-950/30 ${className}`} data-testid="badge-email-connected">
        <span className="h-2 w-2 rounded-full bg-green-500 mr-1.5" />
        Email Connected
      </Badge>
    );
  }

  // Show button even if Nylas isn't available yet - it may be initializing
  // The button will show an error toast if they try to connect when unavailable
  const isNylasAvailable = grantStatus?.nylas_available !== false;
  
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleConnect}
      disabled={connectEmailMutation.isPending || isConnecting || !isNylasAvailable}
      className={className}
      data-testid="button-connect-email"
      title={!isNylasAvailable ? "Email connection service initializing..." : undefined}
    >
      {connectEmailMutation.isPending || isConnecting ? (
        <Loader2 className="h-4 w-4 mr-2 animate-spin" />
      ) : (
        <Mail className="h-4 w-4 mr-2" />
      )}
      {!isNylasAvailable ? "Email Service Initializing..." : "Connect Email for Receipts"}
    </Button>
  );
}

interface EnrichmentData {
  reasoningTrace?: string;
  aiConfidence?: number;
  isSubscription?: boolean;
  subscriptionName?: string;
  subscriptionAmount?: number;
  emailEvidence?: boolean;
  contextData?: Record<string, any>;
}

interface SparkleIconProps {
  hasReasoning: boolean;
  onClick?: () => void;
  className?: string;
}

export function SparkleIcon({ hasReasoning, onClick, className }: SparkleIconProps) {
  if (!hasReasoning) return null;
  
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center justify-center text-purple-500 hover:text-purple-600 transition-colors ${className}`}
      data-testid="button-sparkle-reasoning"
    >
      <Sparkles className="h-4 w-4 animate-pulse" />
    </button>
  );
}

interface ReasoningPopoverProps {
  enrichmentData: EnrichmentData;
  children: React.ReactNode;
}

export function ReasoningPopover({ enrichmentData, children }: ReasoningPopoverProps) {
  const {
    reasoningTrace,
    aiConfidence = 0,
    isSubscription,
    subscriptionName,
    subscriptionAmount,
    emailEvidence,
    contextData,
  } = enrichmentData;

  if (!reasoningTrace) return <>{children}</>;

  const confidencePercent = Math.round(aiConfidence * 100);
  const confidenceColor = aiConfidence >= 0.8 
    ? "bg-green-500" 
    : aiConfidence >= 0.6 
    ? "bg-yellow-500" 
    : "bg-red-500";

  return (
    <Popover>
      <PopoverTrigger asChild>
        {children}
      </PopoverTrigger>
      <PopoverContent className="w-80" align="start" data-testid="popover-reasoning">
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-purple-500" />
            <span className="font-medium text-sm">AI Enrichment Details</span>
          </div>
          
          {isSubscription && subscriptionName && (
            <div className="flex items-start gap-2 p-2 bg-muted/50 rounded-md">
              <Search className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <span className="font-medium">Subscription Detected</span>
                <p className="text-muted-foreground">
                  {subscriptionName}
                  {subscriptionAmount && ` (${(subscriptionAmount / 100).toFixed(2)}/mo)`}
                </p>
              </div>
            </div>
          )}
          
          {emailEvidence && (
            <div className="flex items-start gap-2 p-2 bg-muted/50 rounded-md">
              <Receipt className="h-4 w-4 text-green-500 mt-0.5 flex-shrink-0" />
              <div className="text-sm">
                <span className="font-medium">Receipt Found</span>
                <p className="text-muted-foreground">Matched via email</p>
              </div>
            </div>
          )}
          
          <div className="space-y-1">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">AI Confidence</span>
              <span className="font-medium">{confidencePercent}%</span>
            </div>
            <Progress value={confidencePercent} className="h-2" />
            <div className={`h-1 rounded-full ${confidenceColor}`} style={{ width: `${confidencePercent}%` }} />
          </div>
          
          {reasoningTrace && (
            <div className="text-xs text-muted-foreground border-t pt-2">
              <p className="font-medium mb-1">Reasoning:</p>
              <p className="line-clamp-3">{reasoningTrace}</p>
            </div>
          )}
          
          {contextData && Object.keys(contextData).length > 0 && (
            <div className="text-xs text-muted-foreground border-t pt-2">
              <p className="font-medium mb-1">Additional Context:</p>
              <ul className="space-y-0.5">
                {Object.entries(contextData).slice(0, 3).map(([key, value]) => (
                  <li key={key} className="truncate">
                    <span className="font-medium">{key}:</span> {String(value)}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

interface NeedsReviewBadgeProps {
  aiConfidence: number;
  onConfirm?: () => void;
  className?: string;
}

export function NeedsReviewBadge({ aiConfidence, onConfirm, className }: NeedsReviewBadgeProps) {
  if (aiConfidence >= 0.8) return null;
  
  return (
    <Badge 
      variant="outline" 
      className={`border-amber-500 text-amber-600 dark:text-amber-400 ${className}`}
      data-testid="badge-needs-review"
    >
      <AlertTriangle className="h-3 w-3 mr-1" />
      Needs Review
    </Badge>
  );
}

interface EnrichedTransactionBadgesProps {
  transaction: {
    reasoningTrace?: string;
    aiConfidence?: number;
    isSubscription?: boolean;
    subscriptionId?: number;
    contextData?: Record<string, any>;
  };
  subscriptionName?: string;
  subscriptionAmount?: number;
}

export function EnrichedTransactionBadges({ 
  transaction,
  subscriptionName,
  subscriptionAmount
}: EnrichedTransactionBadgesProps) {
  const hasEnrichment = !!transaction.reasoningTrace;
  const aiConfidence = transaction.aiConfidence || 0;
  
  if (!hasEnrichment) return null;
  
  const enrichmentData: EnrichmentData = {
    reasoningTrace: transaction.reasoningTrace,
    aiConfidence: transaction.aiConfidence,
    isSubscription: transaction.isSubscription,
    subscriptionName,
    subscriptionAmount,
    emailEvidence: transaction.contextData?.emailEvidence,
    contextData: transaction.contextData,
  };
  
  return (
    <div className="flex items-center gap-1.5" data-testid="enriched-badges-container">
      <ReasoningPopover enrichmentData={enrichmentData}>
        <SparkleIcon hasReasoning={hasEnrichment} />
      </ReasoningPopover>
      
      {aiConfidence > 0 && aiConfidence < 0.8 && (
        <NeedsReviewBadge aiConfidence={aiConfidence} />
      )}
    </div>
  );
}

export function shouldAutoApplyEnrichment(aiConfidence: number): boolean {
  return aiConfidence >= 0.8;
}

export function getConfidenceLevel(aiConfidence: number): "high" | "medium" | "low" {
  if (aiConfidence >= 0.8) return "high";
  if (aiConfidence >= 0.6) return "medium";
  return "low";
}
