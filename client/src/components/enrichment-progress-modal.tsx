import { useState, useEffect, useCallback } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { Button } from "@/components/ui/button";
import { Info, Sparkles, AlertCircle, X, Loader2 } from "lucide-react";
import { logoImage } from "./logo";

interface EnrichmentProgress {
  current: number;
  total: number;
  status: "connecting" | "extracting" | "enriching" | "classifying" | "complete" | "error";
  startTime?: number;
  message?: string;
  errorMessage?: string;
}

interface EnrichmentProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string | null;
  onComplete: (result: any) => void;
  onError: (error: string) => void;
  onCancel?: () => Promise<void> | void;
}

export function EnrichmentProgressModal({
  open,
  onOpenChange,
  jobId,
  onComplete,
  onError,
  onCancel,
}: EnrichmentProgressModalProps) {
  const [progress, setProgress] = useState<EnrichmentProgress>({
    current: 0,
    total: 0,
    status: "connecting",
  });
  const [etaSeconds, setEtaSeconds] = useState<number | null>(null);
  const [rate, setRate] = useState<number>(0);

  const calculateEta = useCallback((current: number, total: number, startTime: number) => {
    if (current === 0 || !startTime) return null;
    
    const elapsed = (Date.now() - startTime) / 1000;
    const avgTimePerTx = elapsed / current;
    const remaining = total - current;
    return Math.ceil(avgTimePerTx * remaining);
  }, []);

  useEffect(() => {
    if (!open || !jobId) return;

    let eventSource: EventSource | null = null;
    let retryCount = 0;
    const maxRetries = 3;

    const connect = () => {
      eventSource = new EventSource(`/api/budget/enrichment-stream/${jobId}`);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          
          if (data.type === "progress") {
            setProgress({
              current: data.current,
              total: data.total,
              status: data.status,
              startTime: data.startTime,
              message: data.message,
            });

            if (data.current > 0 && data.startTime) {
              const eta = calculateEta(data.current, data.total, data.startTime);
              setEtaSeconds(eta);
              
              const elapsed = (Date.now() - data.startTime) / 1000 / 60;
              if (elapsed > 0) {
                setRate(Math.round(data.current / elapsed));
              }
            }
          } else if (data.type === "complete") {
            setProgress(prev => ({ ...prev, status: "complete" }));
            eventSource?.close();
            onComplete(data.result);
          } else if (data.type === "error") {
            setProgress(prev => ({ 
              ...prev, 
              status: "error",
              errorMessage: data.message 
            }));
            eventSource?.close();
            onError(data.message);
          }
        } catch (e) {
          console.error("Error parsing SSE data:", e);
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
        retryCount++;
        if (retryCount < maxRetries) {
          setTimeout(connect, 1000 * retryCount);
        } else {
          setProgress(prev => ({ 
            ...prev, 
            status: "error",
            errorMessage: "Connection lost. Please try again." 
          }));
          onError("Connection lost during enrichment");
        }
      };
    };

    connect();

    return () => {
      eventSource?.close();
    };
  }, [open, jobId, onComplete, onError, calculateEta]);

  const formatEta = (seconds: number | null): string => {
    if (seconds === null || seconds <= 0) return "Calculating...";
    if (seconds < 60) return `${seconds}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s remaining`;
  };

  const getStatusMessage = (status: string): string => {
    switch (status) {
      case "connecting":
        return "Connecting to bank data...";
      case "extracting":
        return "Extracting transactions from your bank...";
      case "enriching":
        return `Enriching transaction ${progress.current} of ${progress.total}`;
      case "classifying":
        return "Categorizing your spending...";
      case "complete":
        return "Analysis complete!";
      case "error":
        return progress.errorMessage || "An error occurred";
      default:
        return "Processing...";
    }
  };

  const percentComplete = progress.total > 0 
    ? Math.round((progress.current / progress.total) * 100) 
    : 0;

  const [isCancelling, setIsCancelling] = useState(false);

  const handleCancel = useCallback(async () => {
    if (isCancelling) return;
    setIsCancelling(true);
    
    try {
      // First call the onCancel callback which will cancel the backend job
      if (onCancel) {
        await onCancel();
      }
    } finally {
      setIsCancelling(false);
      onOpenChange(false);
    }
  }, [onCancel, onOpenChange, isCancelling]);

  const handleEscapeOrOutsideClick = useCallback((e: Event) => {
    e.preventDefault();
    handleCancel();
  }, [handleCancel]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent 
        className="sm:max-w-md"
        onPointerDownOutside={handleEscapeOrOutsideClick}
        onEscapeKeyDown={handleEscapeOrOutsideClick}
      >
        <div className="flex flex-col items-center py-8 space-y-6">
          <div className="relative">
            <img 
              src={logoImage} 
              alt="Resolve" 
              className="h-16 w-16 object-contain animate-pulse"
              data-testid="img-resolve-logo-animated"
            />
            <div className="absolute -bottom-1 -right-1 bg-primary rounded-full p-1">
              <Sparkles className="h-4 w-4 text-primary-foreground" />
            </div>
          </div>

          <div className="text-center space-y-2">
            <h3 className="text-lg font-semibold">
              Enriching &amp; Categorising Transactions
            </h3>
            <p className="text-sm text-muted-foreground flex items-center justify-center gap-2">
              Powered by Ntropy AI
              <HoverCard>
                <HoverCardTrigger asChild>
                  <button 
                    className="inline-flex items-center justify-center rounded-full bg-muted hover-elevate w-5 h-5"
                    data-testid="button-info-why-enrichment"
                  >
                    <Info className="h-3 w-3 text-muted-foreground" />
                  </button>
                </HoverCardTrigger>
                <HoverCardContent className="w-80" side="top">
                  <div className="space-y-2">
                    <h4 className="font-semibold text-sm">Why does Resolve do this?</h4>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      Transaction data from your bank is often unrefined and can be confusing. 
                      Data enrichment helps to clarify what transactions are:
                    </p>
                    <ul className="text-xs text-muted-foreground space-y-1 list-disc list-inside">
                      <li>Recurring debt payments that cannot be optimised</li>
                      <li>Everyday spending</li>
                      <li>Subscriptions and fixed costs</li>
                    </ul>
                    <p className="text-xs text-muted-foreground leading-relaxed">
                      This makes the budget we recommend much more accurate to fully tailor 
                      your optimised plan to you.
                    </p>
                  </div>
                </HoverCardContent>
              </HoverCard>
            </p>
          </div>

          {progress.status === "error" ? (
            <div className="w-full space-y-4 text-center">
              <AlertCircle className="h-12 w-12 text-destructive mx-auto" />
              <p className="text-sm text-destructive">
                {progress.errorMessage || "An error occurred during enrichment"}
              </p>
            </div>
          ) : (
            <>
              <div className="w-full space-y-3">
                <Progress 
                  value={percentComplete} 
                  className="h-3"
                  data-testid="progress-enrichment"
                />
                
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span data-testid="text-progress-status">
                    {getStatusMessage(progress.status)}
                  </span>
                  <span className="font-mono" data-testid="text-progress-percent">
                    {percentComplete}%
                  </span>
                </div>
              </div>

              {progress.status === "enriching" && progress.total > 0 && (
                <div className="w-full bg-muted rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Transactions processed:</span>
                    <span className="font-mono font-medium" data-testid="text-transactions-count">
                      {progress.current} / {progress.total}
                    </span>
                  </div>
                  
                  {rate > 0 && (
                    <div className="flex justify-between text-sm">
                      <span className="text-muted-foreground">Processing rate:</span>
                      <span className="font-mono font-medium" data-testid="text-processing-rate">
                        {rate} tx/min
                      </span>
                    </div>
                  )}
                  
                  <div className="flex justify-between text-sm">
                    <span className="text-muted-foreground">Estimated time:</span>
                    <span className="font-mono font-medium" data-testid="text-eta">
                      {formatEta(etaSeconds)}
                    </span>
                  </div>
                </div>
              )}
            </>
          )}

          <p className="text-xs text-muted-foreground text-center max-w-xs">
            Your transaction data is being securely processed.
          </p>

          <Button
            variant="outline"
            onClick={handleCancel}
            disabled={isCancelling}
            className="mt-2"
            data-testid="button-cancel-enrichment"
          >
            {isCancelling ? (
              <>
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                Cancelling...
              </>
            ) : (
              <>
                <X className="h-4 w-4 mr-2" />
                Cancel
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
