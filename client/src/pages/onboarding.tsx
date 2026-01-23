import { useState, useEffect } from "react";
import { useLocation, useSearch } from "wouter";
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
import { ArrowRight, ArrowLeft, Check, ChevronsUpDown, Loader2, Landmark, CreditCard, Zap } from "lucide-react";
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
  const searchString = useSearch();
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
            <CardHeader className="text-center">
              <CardTitle className="text-2xl font-semibold">Connect Your Bank Accounts</CardTitle>
              <CardDescription>
                Securely link your bank accounts and credit cards to analyze your spending patterns.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="flex flex-col items-center gap-6 py-4">
                <div className="grid grid-cols-2 gap-4 text-center">
                  <div className="flex flex-col items-center gap-2 p-4 rounded-lg bg-muted/50">
                    <Landmark className="h-8 w-8 text-primary" />
                    <span className="text-sm font-medium">Bank Accounts</span>
                    <span className="text-xs text-muted-foreground">Current & savings accounts</span>
                  </div>
                  <div className="flex flex-col items-center gap-2 p-4 rounded-lg bg-muted/50">
                    <CreditCard className="h-8 w-8 text-primary" />
                    <span className="text-sm font-medium">Credit Cards</span>
                    <span className="text-xs text-muted-foreground">All your credit accounts</span>
                  </div>
                </div>
                
                <p className="text-sm text-muted-foreground text-center max-w-md">
                  You can connect your bank accounts later from the Current Finances page. 
                  Click Continue to proceed with onboarding.
                </p>
              </div>
              
              {hasConnectedAccounts && (
                <div className="rounded-lg border bg-muted/50 p-4">
                  <h4 className="font-medium mb-2">Connected Accounts ({connectedAccountsCount})</h4>
                  <ul className="space-y-2">
                    {trueLayerStatus?.accounts?.map((account) => (
                      <li key={account.id} className="flex items-center justify-between text-sm" data-testid={`li-account-${account.id}`}>
                        <div className="flex items-center gap-2 text-muted-foreground">
                          <Check className="h-4 w-4 text-green-500" />
                          {account.institutionName} - {account.accountName}
                        </div>
                        {account.processingStatus === "STAGED" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400" data-testid={`badge-staged-${account.id}`}>
                            Ready to Analyze
                          </span>
                        ) : account.processingStatus === "ACTIVE" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400" data-testid={`badge-active-${account.id}`}>
                            Analyzed
                          </span>
                        ) : account.processingStatus === "ANALYZING" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400" data-testid={`badge-analyzing-${account.id}`}>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            Analyzing...
                          </span>
                        ) : account.processingStatus === "ERROR" ? (
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium rounded-full bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400" data-testid={`badge-error-${account.id}`}>
                            Error
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              
              <div className="rounded-lg border-2 border-primary/20 bg-primary/5 p-4">
                <p className="text-sm">
                  <span className="font-medium">Why staged connection?</span> Resolve analyzes all your accounts together to detect internal transfers and give you an accurate "Safe to Spend" amount. Connect everything first, then analyze once.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {currentStep === 4 && (
          <Card>
            <CardHeader className="text-center">
              <CardTitle className="text-2xl font-semibold">Ready to Analyze</CardTitle>
              <CardDescription>
                {hasConnectedAccounts 
                  ? `You have ${connectedAccountsCount} account${connectedAccountsCount > 1 ? 's' : ''} ready for analysis.`
                  : "Connect at least one bank account to generate your report."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!hasConnectedAccounts ? (
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
              ) : !hasStagedAccounts ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-600">
                    <Check className="h-6 w-6" />
                    <span className="font-medium">All accounts analyzed</span>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Your transaction history has been analyzed. You can view your insights on the dashboard.
                  </p>
                  <Button onClick={() => setLocation("/budget")} data-testid="button-go-to-dashboard">
                    View Dashboard
                    <ArrowRight className="ml-2 h-4 w-4" />
                  </Button>
                </div>
              ) : (
                <div className="text-center space-y-4">
                  <p className="text-sm text-muted-foreground">
                    {stagedCount} account{stagedCount > 1 ? 's' : ''} ready for analysis.
                    Head to Current Finances to analyze your transactions.
                  </p>
                  <Button 
                    size="lg"
                    onClick={() => setLocation("/current-finances?wizard=open")}
                    className="gap-2"
                    data-testid="button-analyze-accounts"
                  >
                    <Zap className="h-5 w-5" />
                    Go to Current Finances
                  </Button>
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
