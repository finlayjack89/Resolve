import { useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Building2, CreditCard, ArrowLeft, Loader2, AlertTriangle } from "lucide-react";
import { useAuth } from "@/lib/auth-context";
import { useToast } from "@/hooks/use-toast";

type ConnectionType = "current_account" | "credit_card";

interface ConnectBankDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnUrl?: string;
}

export function ConnectBankDialog({ open, onOpenChange, returnUrl = "/current-finances" }: ConnectBankDialogProps) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [isConnecting, setIsConnecting] = useState(false);
  const [selectedType, setSelectedType] = useState<ConnectionType | null>(null);

  const handleConnect = async (connectionType: ConnectionType) => {
    if (user?.id === "guest-user") {
      toast({
        title: "Account Required",
        description: "Please create an account to connect your bank.",
        variant: "destructive",
      });
      return;
    }

    setIsConnecting(true);
    setSelectedType(connectionType);

    try {
      const response = await fetch(
        `/api/truelayer/auth-url?connectionType=${connectionType}&returnUrl=${encodeURIComponent(returnUrl)}`,
        { credentials: "include" }
      );
      const data = await response.json();

      if (data.authUrl) {
        // Close dialog before redirecting
        onOpenChange(false);
        window.location.href = data.authUrl;
      } else {
        throw new Error(data.message || "Failed to get authentication URL");
      }
    } catch (error: any) {
      console.error("Connect bank error:", error);
      setIsConnecting(false);
      setSelectedType(null);
      toast({
        title: "Connection Failed",
        description: error.message || "Could not start bank connection.",
        variant: "destructive",
      });
    }
  };

  const handleClose = () => {
    if (!isConnecting) {
      onOpenChange(false);
      setSelectedType(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="text-2xl">Connect Your Account</DialogTitle>
          <DialogDescription>
            Choose what type of account you'd like to connect
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <Card
            className={`p-5 cursor-pointer border-2 transition-all ${
              selectedType === "current_account" 
                ? "border-primary bg-primary/5" 
                : "hover-elevate"
            } ${isConnecting && selectedType !== "current_account" ? "opacity-50" : ""}`}
            onClick={() => !isConnecting && handleConnect("current_account")}
            data-testid="card-current-account"
          >
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-blue-100 dark:bg-blue-900/30">
                {isConnecting && selectedType === "current_account" ? (
                  <Loader2 className="h-6 w-6 text-blue-600 dark:text-blue-400 animate-spin" />
                ) : (
                  <Building2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                )}
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="font-semibold">Current Account</h4>
                  <Badge variant="secondary" className="text-xs">Recommended</Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Connect your main bank account to analyze income, spending patterns, and find your budget
                </p>
              </div>
            </div>
          </Card>

          <Card
            className={`p-5 cursor-pointer border-2 transition-all ${
              selectedType === "credit_card" 
                ? "border-primary bg-primary/5" 
                : "hover-elevate"
            } ${isConnecting && selectedType !== "credit_card" ? "opacity-50" : ""}`}
            onClick={() => !isConnecting && handleConnect("credit_card")}
            data-testid="card-credit-card-connect"
          >
            <div className="flex items-center gap-4">
              <div className="p-3 rounded-full bg-purple-100 dark:bg-purple-900/30">
                {isConnecting && selectedType === "credit_card" ? (
                  <Loader2 className="h-6 w-6 text-purple-600 dark:text-purple-400 animate-spin" />
                ) : (
                  <CreditCard className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                )}
              </div>
              <div className="flex-1">
                <h4 className="font-semibold">Credit Card</h4>
                <p className="text-sm text-muted-foreground mt-0.5">
                  Connect your credit card to track spending and see your balance
                </p>
              </div>
            </div>
          </Card>

          <div className="bg-muted/50 rounded-lg p-4 flex gap-3">
            <AlertTriangle className="h-5 w-5 text-muted-foreground flex-shrink-0 mt-0.5" />
            <div className="text-sm text-muted-foreground">
              <p className="font-medium text-foreground mb-1">Secure Open Banking Connection</p>
              <p>
                Your login details are never shared with us. You'll be securely redirected to your bank 
                to authorize read-only access to your transaction history.
              </p>
            </div>
          </div>
        </div>

        <div className="flex justify-between items-center pt-2">
          <Button
            variant="ghost"
            onClick={handleClose}
            disabled={isConnecting}
            data-testid="button-close-connect-dialog"
          >
            <ArrowLeft className="h-4 w-4 mr-2" />
            Cancel
          </Button>
          <p className="text-xs text-muted-foreground">
            Powered by TrueLayer Open Banking
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
