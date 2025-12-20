import { useState, useEffect, useCallback } from "react";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Sparkles, Loader2, CheckCircle2, AlertCircle, Zap, Bot } from "lucide-react";
import { cn } from "@/lib/utils";

interface EnrichmentProgressData {
  phase: "ntropy" | "agentic" | "complete";
  current: number;
  total: number;
  status: string;
  startTime: number;
  transactionsPerMinute: number;
  estimatedTimeRemaining: number | null;
  ntropyCompleted: number;
  agenticQueued: number;
  agenticProcessing: number;
  agenticCompleted: number;
  errorMessage?: string;
}

interface EnrichmentProgressProps {
  jobId: string;
  onComplete?: (result: any) => void;
  onError?: (error: string) => void;
  className?: string;
}

export function EnrichmentProgress({
  jobId,
  onComplete,
  onError,
  className,
}: EnrichmentProgressProps) {
  const [progress, setProgress] = useState<EnrichmentProgressData>({
    phase: "ntropy",
    current: 0,
    total: 0,
    status: "connecting",
    startTime: Date.now(),
    transactionsPerMinute: 0,
    estimatedTimeRemaining: null,
    ntropyCompleted: 0,
    agenticQueued: 0,
    agenticProcessing: 0,
    agenticCompleted: 0,
  });
  const [isComplete, setIsComplete] = useState(false);
  const [hasError, setHasError] = useState(false);

  useEffect(() => {
    if (!jobId) return;

    let eventSource: EventSource | null = null;
    let retryCount = 0;
    const maxRetries = 3;

    const connect = () => {
      eventSource = new EventSource(`/api/budget/enrichment-progress/${jobId}`);

      eventSource.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.type === "progress") {
            setProgress({
              phase: data.phase || "ntropy",
              current: data.current,
              total: data.total,
              status: data.status,
              startTime: data.startTime,
              transactionsPerMinute: data.transactionsPerMinute || 0,
              estimatedTimeRemaining: data.estimatedTimeRemaining,
              ntropyCompleted: data.ntropyCompleted || 0,
              agenticQueued: data.agenticQueued || 0,
              agenticProcessing: data.agenticProcessing || 0,
              agenticCompleted: data.agenticCompleted || 0,
            });
          } else if (data.type === "complete") {
            setIsComplete(true);
            setProgress((prev) => ({ ...prev, phase: "complete", status: "complete" }));
            eventSource?.close();
            onComplete?.(data.result);
          } else if (data.type === "error") {
            setHasError(true);
            setProgress((prev) => ({
              ...prev,
              status: "error",
              errorMessage: data.message,
            }));
            eventSource?.close();
            onError?.(data.message);
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
          setHasError(true);
          setProgress((prev) => ({
            ...prev,
            status: "error",
            errorMessage: "Connection lost. Please try again.",
          }));
          onError?.("Connection lost during enrichment");
        }
      };
    };

    connect();

    return () => {
      eventSource?.close();
    };
  }, [jobId, onComplete, onError]);

  const formatEta = useCallback((seconds: number | null): string => {
    if (seconds === null || seconds <= 0) return "Calculating...";
    if (seconds < 60) return `~${seconds}s remaining`;
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `~${mins}m ${secs}s remaining`;
  }, []);

  const getPhaseLabel = useCallback((phase: string, status: string): string => {
    if (status === "connecting" || status === "extracting") {
      return "Connecting to bank data...";
    }
    if (phase === "ntropy") {
      return "Enriching transactions...";
    }
    if (phase === "agentic") {
      return "Analyzing with AI...";
    }
    if (phase === "complete") {
      return "Analysis complete!";
    }
    return "Processing...";
  }, []);

  const getPhaseIcon = useCallback((phase: string, status: string) => {
    if (status === "error") {
      return <AlertCircle className="h-5 w-5 text-destructive" />;
    }
    if (phase === "complete") {
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    }
    if (phase === "agentic") {
      return <Bot className="h-5 w-5 text-purple-500 animate-pulse" />;
    }
    return <Sparkles className="h-5 w-5 text-primary animate-pulse" />;
  }, []);

  const percentComplete =
    progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  if (hasError) {
    return (
      <div className={cn("space-y-4", className)} data-testid="enrichment-progress-error">
        <div className="flex items-center gap-3">
          <AlertCircle className="h-5 w-5 text-destructive" />
          <span className="text-sm font-medium text-destructive">
            {progress.errorMessage || "An error occurred during enrichment"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={cn("space-y-4", className)} data-testid="enrichment-progress">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {getPhaseIcon(progress.phase, progress.status)}
          <span className="text-sm font-medium" data-testid="text-phase-label">
            {getPhaseLabel(progress.phase, progress.status)}
          </span>
        </div>
        {!isComplete && (
          <Badge variant="secondary" className="font-mono text-xs">
            {percentComplete}%
          </Badge>
        )}
      </div>

      <Progress
        value={percentComplete}
        className={cn(
          "h-2 transition-all duration-300",
          progress.phase === "agentic" && "bg-purple-100 dark:bg-purple-900/30"
        )}
        data-testid="progress-bar-enrichment"
      />

      {!isComplete && progress.total > 0 && (
        <div className="grid grid-cols-2 gap-4 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <Zap className="h-3.5 w-3.5" />
            <span data-testid="text-transactions-rate">
              {progress.transactionsPerMinute > 0
                ? `${progress.transactionsPerMinute} tx/min`
                : "Calculating..."}
            </span>
          </div>
          <div className="text-right" data-testid="text-eta">
            {formatEta(progress.estimatedTimeRemaining)}
          </div>
        </div>
      )}

      {!isComplete && progress.total > 0 && (
        <div className="flex items-center justify-between text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
          <span data-testid="text-transactions-count">
            {progress.current} / {progress.total} transactions
          </span>
          {progress.phase === "ntropy" && (
            <span className="flex items-center gap-1">
              <Sparkles className="h-3 w-3" />
              Ntropy enrichment
            </span>
          )}
        </div>
      )}

      {progress.phase === "agentic" && progress.agenticQueued > 0 && (
        <div
          className="flex items-center justify-between text-xs bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300 rounded-md px-3 py-2"
          data-testid="agentic-sub-progress"
        >
          <div className="flex items-center gap-2">
            <Bot className="h-3.5 w-3.5" />
            <span>AI Analysis Queue</span>
          </div>
          <div className="flex items-center gap-3 font-mono">
            <span data-testid="text-agentic-queued">Queued: {progress.agenticQueued}</span>
            {progress.agenticProcessing > 0 && (
              <span className="flex items-center gap-1" data-testid="text-agentic-processing">
                <Loader2 className="h-3 w-3 animate-spin" />
                Processing: {progress.agenticProcessing}
              </span>
            )}
          </div>
        </div>
      )}

      {isComplete && (
        <div
          className="flex items-center gap-2 text-sm text-green-600 dark:text-green-400"
          data-testid="enrichment-complete"
        >
          <CheckCircle2 className="h-4 w-4" />
          <span>All transactions enriched successfully</span>
        </div>
      )}
    </div>
  );
}
