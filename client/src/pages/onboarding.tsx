import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { ProgressStepper } from "@/components/progress-stepper";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/components/theme-toggle";
import { ArrowRight, ArrowLeft, Check, ChevronsUpDown, Loader2, FileText, Building2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { countries } from "@/lib/countries";
import { cn } from "@/lib/utils";

const steps = [
  { id: 1, name: "Profile", description: "Basic information" },
  { id: 2, name: "Location", description: "Country & currency" },
  { id: 3, name: "Connect", description: "Link accounts" },
  { id: 4, name: "Report", description: "Generate analysis" },
];

export default function Onboarding() {
  const [, setLocation] = useLocation();
  const { user, updateUser } = useAuth();
  const { toast } = useToast();
  const [currentStep, setCurrentStep] = useState(1);
  
  // Form state - initialize only once on mount
  const [country, setCountry] = useState(() => user?.country || "");
  const [region, setRegion] = useState(() => user?.region || "");
  const [currency, setCurrency] = useState(() => user?.currency || "");
  const [countryOpen, setCountryOpen] = useState(false);
  const [regionOpen, setRegionOpen] = useState(false);
  const [isDetectingLocation, setIsDetectingLocation] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);

  const selectedCountry = countries.find(c => c.code === country);

  // Query to check connected accounts
  const { data: trueLayerStatus, refetch: refetchStatus } = useQuery<{
    connected: boolean;
    accounts: Array<{ id: string; institutionName: string; accountName: string; connectionType: string; processingStatus: string }>;
    totalAccounts: number;
    stagedCount: number;
    analyzingCount: number;
    activeCount: number;
    errorCount: number;
  }>({
    queryKey: ["/api/truelayer/status"],
    enabled: currentStep >= 3,
    refetchInterval: currentStep === 3 ? 3000 : false,
  });

  const connectedAccountsCount = trueLayerStatus?.accounts?.length || 0;
  const stagedCount = trueLayerStatus?.stagedCount || 0;
  const analyzingCount = trueLayerStatus?.analyzingCount || 0;
  const hasConnectedAccounts = connectedAccountsCount > 0;
  const hasStagedAccounts = stagedCount > 0;
  const isAnalyzing = analyzingCount > 0;

  // Auto-detect location using IP geolocation when entering step 2
  useEffect(() => {
    if (currentStep === 2 && !country && !isDetectingLocation) {
      setIsDetectingLocation(true);
      fetch("https://ipapi.co/json/")
        .then(res => res.json())
        .then(data => {
          if (data.country_code) {
            const detectedCountry = countries.find(c => c.code === data.country_code);
            if (detectedCountry) {
              setCountry(detectedCountry.code);
              setCurrency(detectedCountry.currency);
              // Try to match region
              if (data.region && detectedCountry.regions.includes(data.region)) {
                setRegion(data.region);
              }
            }
          }
        })
        .catch(err => {
          console.log("[Onboarding] IP geolocation failed:", err);
        })
        .finally(() => {
          setIsDetectingLocation(false);
        });
    }
  }, [currentStep, country, isDetectingLocation]);

  const handleNext = async () => {
    console.log("[Onboarding] handleNext called, currentStep:", currentStep);
    
    if (currentStep === 2) {
      // Validate location selection
      if (!country || !region || !currency) {
        console.log("[Onboarding] Validation failed:", { country, region, currency });
        toast({
          title: "Missing information",
          description: "Please select your country, region, and currency",
          variant: "destructive",
        });
        return;
      }

      // Save location data
      try {
        console.log("[Onboarding] Saving profile:", { country, region, currency });
        const response = await fetch("/api/user/profile", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ country, region, currency }),
          credentials: "include",
        });

        if (!response.ok) throw new Error("Failed to update profile");
        
        const updatedUser = await response.json();
        console.log("[Onboarding] Profile saved successfully:", updatedUser);

        updateUser({ country, region, currency });
        console.log("[Onboarding] Updated auth context, setting step to 3");
        setCurrentStep(3);
        console.log("[Onboarding] Step should now be 3");
      } catch (error) {
        console.error("[Onboarding] Error saving profile:", error);
        toast({
          title: "Error",
          description: "Failed to save your information. Please try again.",
          variant: "destructive",
        });
      }
    } else if (currentStep === 3) {
      // Move to Generate Report step
      console.log("[Onboarding] Moving to Generate Report step");
      setCurrentStep(4);
    } else if (currentStep === 4) {
      // Complete onboarding
      console.log("[Onboarding] Completing onboarding, navigating to /accounts");
      setLocation("/accounts");
    } else {
      console.log("[Onboarding] Advancing from step", currentStep, "to", currentStep + 1);
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleConnectBank = async (connectionType: "current_account" | "credit_card") => {
    try {
      setIsConnecting(true);
      const returnUrl = window.location.pathname;
      const response = await fetch(`/api/truelayer/auth-url?connectionType=${connectionType}&returnUrl=${encodeURIComponent(returnUrl)}`, {
        credentials: "include",
      });
      
      if (!response.ok) {
        throw new Error("Failed to get authentication URL");
      }
      
      const data = await response.json();
      window.location.href = data.authUrl;
    } catch (error: any) {
      console.error("[Onboarding] Connect bank error:", error);
      toast({
        title: "Connection Error",
        description: error.message || "Failed to connect to bank. Please try again.",
        variant: "destructive",
      });
      setIsConnecting(false);
    }
  };

  const handleGenerateReport = async () => {
    try {
      setIsGeneratingReport(true);
      
      const response = await fetch("/api/finances/initialize-analysis", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.message || "Failed to generate report");
      }
      
      toast({
        title: "Success",
        description: data.message || "Ecosystem synchronized.",
      });
      
      // Navigate to the dashboard/accounts page
      setLocation("/budget");
    } catch (error: any) {
      console.error("[Onboarding] Generate report error:", error);
      toast({
        title: "Error",
        description: error.message || "Failed to generate report. Please try again.",
        variant: "destructive",
      });
    } finally {
      setIsGeneratingReport(false);
    }
  };

  return (
    <div className="flex flex-col min-h-screen bg-background">
      <header className="border-b shrink-0">
        <div className="flex h-16 items-center justify-between px-6">
          <Logo />
          <ThemeToggle />
        </div>
      </header>

      <main className="flex-1 flex flex-col px-6 py-12">
        <ProgressStepper steps={steps} currentStep={currentStep} />

        {currentStep === 1 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl font-semibold">Welcome to Resolve!</CardTitle>
              <CardDescription className="space-y-1">
                <span className="block italic">Re-solve the past. Resolve the future.</span>
                <span className="block">Let's get you set up with a personalized debt repayment plan. This will only take a few minutes.</span>
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="rounded-lg bg-muted p-6">
                <h3 className="font-medium mb-2">What we'll do together:</h3>
                <ul className="space-y-2 text-sm text-muted-foreground">
                  <li>• Set up your location and currency preferences</li>
                  <li>• Add your credit cards, loans, and BNPL accounts</li>
                  <li>• Configure your monthly budget</li>
                  <li>• Choose your optimization strategy</li>
                  <li>• Generate your personalized payment plan</li>
                </ul>
              </div>
              <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-6">
                <p className="text-sm font-medium">
                  <span className="text-primary">Your information is secure.</span> We use bank-level encryption to protect your financial data.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {currentStep === 2 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl font-semibold">Location & Currency</CardTitle>
              <CardDescription>
                This helps us apply the correct minimum payment rules and display amounts in your currency.
              </CardDescription>
              {isDetectingLocation && (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Detecting your location...
                </div>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-6 md:grid-cols-2">
                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    Country
                  </Label>
                  <Popover open={countryOpen} onOpenChange={setCountryOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={countryOpen}
                        className="h-12 w-full justify-between font-normal"
                        data-testid="select-country"
                      >
                        {country
                          ? countries.find((c) => c.code === country)?.name
                          : "Select country..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                      <Command>
                        <CommandInput placeholder="Search countries..." />
                        <CommandList>
                          <CommandEmpty>No country found.</CommandEmpty>
                          <CommandGroup>
                            {countries.map((c) => (
                              <CommandItem
                                key={c.code}
                                value={c.name}
                                onSelect={() => {
                                  setCountry(c.code);
                                  setCurrency(c.currency);
                                  setRegion("");
                                  setCountryOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    country === c.code ? "opacity-100" : "opacity-0"
                                  )}
                                />
                                {c.name}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>

                <div className="space-y-2">
                  <Label className="text-sm font-medium">
                    Region/State
                  </Label>
                  <Popover open={regionOpen} onOpenChange={setRegionOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        aria-expanded={regionOpen}
                        disabled={!selectedCountry}
                        className="h-12 w-full justify-between font-normal"
                        data-testid="select-region"
                      >
                        {region || "Select region..."}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0">
                      <Command>
                        <CommandInput placeholder="Search regions..." />
                        <CommandList>
                          <CommandEmpty>No region found.</CommandEmpty>
                          <CommandGroup>
                            {selectedCountry?.regions.map((r) => (
                              <CommandItem
                                key={r}
                                value={r}
                                onSelect={() => {
                                  setRegion(r);
                                  setRegionOpen(false);
                                }}
                              >
                                <Check
                                  className={cn(
                                    "mr-2 h-4 w-4",
                                    region === r ? "opacity-100" : "opacity-0"
                                  )}
                                />
                                {r}
                              </CommandItem>
                            ))}
                          </CommandGroup>
                        </CommandList>
                      </Command>
                    </PopoverContent>
                  </Popover>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="currency" className="text-sm font-medium">
                  Currency
                </Label>
                <Input
                  id="currency"
                  value={currency}
                  disabled
                  className="h-12"
                  data-testid="input-currency"
                />
                <p className="text-xs text-muted-foreground">
                  Currency is automatically set based on your country selection
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {currentStep === 3 && (
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl font-semibold">Connect Your Bank Accounts</CardTitle>
              <CardDescription>
                Securely link your bank accounts to analyze your spending and income patterns.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 md:grid-cols-2">
                <div 
                  onClick={() => !isConnecting && handleConnectBank("current_account")}
                  className={cn(
                    "flex flex-col items-center justify-center gap-3 p-6 rounded-lg border-2 cursor-pointer transition-colors",
                    isConnecting ? "opacity-50 cursor-not-allowed" : "hover-elevate"
                  )}
                  data-testid="button-connect-current-account"
                >
                  {isConnecting ? (
                    <Loader2 className="h-8 w-8 animate-spin" />
                  ) : (
                    <Building2 className="h-8 w-8 text-primary" />
                  )}
                  <span className="font-medium">Connect Current Account</span>
                </div>
                <div 
                  onClick={() => !isConnecting && handleConnectBank("credit_card")}
                  className={cn(
                    "flex flex-col items-center justify-center gap-3 p-6 rounded-lg border-2 cursor-pointer transition-colors",
                    isConnecting ? "opacity-50 cursor-not-allowed" : "hover-elevate"
                  )}
                  data-testid="button-connect-credit-card"
                >
                  {isConnecting ? (
                    <Loader2 className="h-8 w-8 animate-spin" />
                  ) : (
                    <FileText className="h-8 w-8 text-primary" />
                  )}
                  <span className="font-medium">Connect Credit Card</span>
                </div>
              </div>
              
              {hasConnectedAccounts && (
                <div className="rounded-lg border bg-muted/50 p-4">
                  <h4 className="font-medium mb-2">Connected Accounts ({connectedAccountsCount})</h4>
                  <ul className="space-y-2">
                    {trueLayerStatus?.accounts?.map((account) => (
                      <li key={account.id} className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Check className="h-4 w-4 text-green-500" />
                        {account.institutionName} - {account.accountName}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              
              <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-4">
                <p className="text-sm">
                  <span className="font-medium">Tip:</span> Connect all your current accounts and credit cards for the most accurate analysis. You can add more accounts later.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {currentStep === 4 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-2xl font-semibold">Generate Your Resolve Report</CardTitle>
              <CardDescription>
                {hasConnectedAccounts 
                  ? `Analyze ${connectedAccountsCount} connected account${connectedAccountsCount > 1 ? 's' : ''} to create your personalized financial overview.`
                  : "Connect at least one bank account to generate your report."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex justify-center">
                <Button
                  size="lg"
                  onClick={handleGenerateReport}
                  disabled={!hasStagedAccounts || isGeneratingReport || isAnalyzing}
                  data-testid="button-generate-report"
                >
                  {isGeneratingReport || isAnalyzing ? (
                    <>
                      <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                      {isAnalyzing ? "Processing..." : "Analyzing..."}
                    </>
                  ) : (
                    <>
                      <FileText className="mr-2 h-5 w-5" />
                      Generate Resolve Report
                    </>
                  )}
                </Button>
              </div>
              
              {!hasConnectedAccounts && (
                <div className="text-center">
                  <p className="text-sm text-muted-foreground mb-4">
                    You haven't connected any bank accounts yet.
                  </p>
                  <Button
                    variant="outline"
                    onClick={() => setCurrentStep(3)}
                    data-testid="button-go-back-to-connect"
                  >
                    Go Back to Connect Accounts
                  </Button>
                </div>
              )}
              
              {hasConnectedAccounts && !hasStagedAccounts && (
                <div className="text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    All accounts have already been analyzed. You can connect more accounts or continue to your dashboard.
                  </p>
                  <Button variant="outline" onClick={() => setLocation("/budget")}>
                    Go to Dashboard
                  </Button>
                </div>
              )}
              
              {hasStagedAccounts && (
                <div className="text-center space-y-2">
                  <p className="text-sm text-muted-foreground">
                    This will analyze 6 months of transaction history across {stagedCount} account{stagedCount > 1 ? 's' : ''}.
                  </p>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <div className="mt-auto pt-8 flex justify-between gap-4">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 1}
            data-testid="button-back"
          >
            <ArrowLeft className="mr-2 h-4 w-4" />
            Back
          </Button>
          {currentStep !== 4 && (
            <Button
              onClick={handleNext}
              disabled={currentStep === 3 && !hasConnectedAccounts}
              data-testid="button-next"
            >
              {currentStep === 3 
                ? (hasConnectedAccounts ? "Next: Generate Report" : "Connect Account First")
                : "Continue"}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          )}
        </div>
      </main>
    </div>
  );
}
