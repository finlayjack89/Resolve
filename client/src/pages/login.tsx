import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Logo } from "@/components/logo";
import { useToast } from "@/hooks/use-toast";
import { Loader2 } from "lucide-react";

export default function Login() {
  const [, setLocation] = useLocation();
  const { user, login, continueAsGuest } = useAuth();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isGuestMode, setIsGuestMode] = useState(false);

  // Redirect when user becomes authenticated
  // This ensures navigation happens AFTER React has processed the state update
  // Fixes race condition where setLocation() runs before setUser() is processed
  useEffect(() => {
    if (user) {
      // Guest users go to accounts, regular users go to home
      setLocation(isGuestMode ? "/accounts" : "/");
    }
  }, [user, setLocation, isGuestMode]);

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsLoading(true);

    // Get values directly from form to handle browser autofill
    const formData = new FormData(e.currentTarget);
    const formEmail = formData.get("email") as string;
    const formPassword = formData.get("password") as string;

    try {
      await login(formEmail || email, formPassword || password);
      // Navigation is handled by useEffect when user state updates
    } catch (error) {
      toast({
        title: "Login failed",
        description: error instanceof Error ? error.message : "Invalid credentials",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleGuestMode = async () => {
    try {
      setIsGuestMode(true);
      await continueAsGuest();
      // Navigation is handled by useEffect when user state updates
    } catch (error) {
      setIsGuestMode(false);
      toast({
        title: "Error",
        description: "Failed to start guest mode",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="flex min-h-screen w-full items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md mx-auto">
        <CardHeader className="space-y-4">
          <div className="flex justify-center">
            <Logo />
          </div>
          <div className="space-y-2 text-center">
            <CardTitle className="text-2xl font-bold">Welcome back</CardTitle>
            <CardDescription>
              Sign in to your account to continue optimizing your debt repayment
            </CardDescription>
          </div>
        </CardHeader>
        <form onSubmit={handleSubmit}>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email" className="text-sm font-medium">
                Email
              </Label>
              <Input
                id="email"
                name="email"
                type="email"
                placeholder="you@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                disabled={isLoading}
                data-testid="input-email"
                className="h-12"
                autoComplete="email"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password" className="text-sm font-medium">
                Password
              </Label>
              <Input
                id="password"
                name="password"
                type="password"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                disabled={isLoading}
                data-testid="input-password"
                className="h-12"
                autoComplete="current-password"
              />
            </div>
          </CardContent>
          <CardFooter className="flex flex-col gap-4">
            <Button
              type="submit"
              className="w-full h-12 text-base font-semibold"
              disabled={isLoading}
              data-testid="button-login"
            >
              {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Sign in
            </Button>
            <Button
              type="button"
              variant="outline"
              className="w-full h-12 text-base font-semibold"
              onClick={handleGuestMode}
              data-testid="button-guest"
            >
              Continue as Guest
            </Button>
            <div className="text-center text-sm text-muted-foreground">
              Don't have an account?{" "}
              <button
                type="button"
                onClick={() => setLocation("/signup")}
                className="text-primary hover:underline font-medium"
                data-testid="link-signup"
              >
                Sign up
              </button>
            </div>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}
