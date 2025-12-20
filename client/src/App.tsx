import { Switch, Route, Redirect, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/lib/theme-provider";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { ThemeToggle } from "@/components/theme-toggle";
import NotFound from "@/pages/not-found";
import Login from "@/pages/login";
import Signup from "@/pages/signup";
import Onboarding from "@/pages/onboarding";
import Accounts from "@/pages/accounts";
import Budget from "@/pages/budget";
import Preferences from "@/pages/preferences";
import Generate from "@/pages/generate";
import HomePageWrapper from "@/pages/home-wrapper";
import PlanOverview from "@/pages/plan-overview";
import AccountDetail from "@/pages/account-detail";
import PaymentCalendar from "@/pages/payment-calendar";
import BudgetFinder from "@/pages/budget-finder";
import CurrentFinances from "@/pages/current-finances";
import BankAccountDetail from "@/pages/bank-account-detail";
import Permissions from "@/pages/permissions";
import { type ReactNode } from "react";

function ProtectedRoute({ component: Component }: { component: React.ComponentType }) {
  const { user, isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }
  
  return user ? <Component /> : <Redirect to="/login" />;
}

function HomeRoute() {
  const { user, isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }
  
  return user ? <HomePageWrapper /> : <Redirect to="/login" />;
}

function GenerateRoute() {
  const { user, isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center" data-testid="loading-generate">
        <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full" />
      </div>
    );
  }
  
  return user ? <Generate /> : <Redirect to="/login" />;
}

function DashboardRedirect() {
  return <Redirect to="/" />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={HomeRoute} />
      <Route path="/login" component={Login} />
      <Route path="/signup" component={Signup} />
      <Route path="/onboarding"><ProtectedRoute component={Onboarding} /></Route>
      <Route path="/accounts"><ProtectedRoute component={Accounts} /></Route>
      <Route path="/accounts/:id"><ProtectedRoute component={AccountDetail} /></Route>
      <Route path="/budget"><ProtectedRoute component={Budget} /></Route>
      <Route path="/preferences"><ProtectedRoute component={Preferences} /></Route>
      <Route path="/generate" component={GenerateRoute} />
      <Route path="/plan"><ProtectedRoute component={PlanOverview} /></Route>
      <Route path="/calendar"><ProtectedRoute component={PaymentCalendar} /></Route>
      <Route path="/budget-finder"><ProtectedRoute component={BudgetFinder} /></Route>
      <Route path="/current-finances"><ProtectedRoute component={CurrentFinances} /></Route>
      <Route path="/current-finances/:id"><ProtectedRoute component={BankAccountDetail} /></Route>
      <Route path="/permissions"><ProtectedRoute component={Permissions} /></Route>
      <Route path="/dashboard" component={DashboardRedirect} />
      <Route component={NotFound} />
    </Switch>
  );
}

function AppLayout({ children }: { children: ReactNode }) {
  const { user, isLoading } = useAuth();
  const [location] = useLocation();
  
  // Show sidebar for authenticated users, except on login, signup, and onboarding pages
  const showSidebar = user && !isLoading && !['/login', '/signup', '/onboarding'].includes(location);
  
  if (!showSidebar) {
    // No sidebar - render children directly without SidebarProvider
    return <>{children}</>;
  }
  
  // With sidebar - wrap in SidebarProvider
  return (
    <SidebarProvider>
      <div className="flex h-screen w-full">
        <AppSidebar />
        <div className="flex flex-col flex-1">
          <header className="flex items-center justify-between p-2 border-b">
            <SidebarTrigger data-testid="button-sidebar-toggle" />
            <ThemeToggle />
          </header>
          <main className="flex-1 overflow-auto">
            {children}
          </main>
        </div>
      </div>
    </SidebarProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <TooltipProvider>
            <AppLayout>
              <Router />
            </AppLayout>
            <Toaster />
          </TooltipProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
