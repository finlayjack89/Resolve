import { Home, CreditCard, BarChart3, LogOut, Calendar, Wallet, RotateCw } from "lucide-react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth-context";
import { LogoIcon } from "@/components/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";

const navItems = [
  { href: "/", icon: Home, label: "Dashboard", testId: "link-dashboard" },
  { href: "/accounts", icon: CreditCard, label: "Accounts", testId: "link-accounts" },
  { href: "/current-finances", icon: Wallet, label: "Current Finances", testId: "link-current-finances" },
  { href: "/subscriptions", icon: RotateCw, label: "Subscriptions", testId: "link-subscriptions" },
  { href: "/plan", icon: BarChart3, label: "Plan Details", testId: "link-plan-details" },
  { href: "/calendar", icon: Calendar, label: "Payment Calendar", testId: "link-calendar" },
];

export function AppSidebar() {
  const [location] = useLocation();
  const { logout } = useAuth();
  
  return (
    <Sidebar>
      <SidebarHeader className="border-b border-sidebar-border">
        <div className="flex items-center gap-2 px-4 py-3">
          <LogoIcon size="md" />
          <span className="font-semibold">Resolve</span>
        </div>
      </SidebarHeader>
      
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Navigation</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton 
                    asChild 
                    isActive={location === item.href}
                    data-testid={item.testId}
                  >
                    <Link href={item.href}>
                      <item.icon />
                      <span>{item.label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      
      <SidebarFooter className="border-t border-sidebar-border">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={() => logout()} data-testid="button-logout">
              <LogOut />
              <span>Logout</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
