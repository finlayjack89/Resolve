import { useQuery } from "@tanstack/react-query";
import { Mail, Shield } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ConnectEmailButton } from "@/components/enrichment-ui";
import { useAuth } from "@/lib/auth-context";

export default function PermissionsPage() {
  const { user } = useAuth();

  const { data: grantStatus } = useQuery<{
    nylas_available: boolean;
    has_grants: boolean;
    connected_email?: string;
    message: string;
  }>({
    queryKey: ["/api/nylas/grants", user?.id],
    enabled: !!user?.id && user.id !== "guest-user",
  });

  const isConnected = grantStatus?.has_grants;

  return (
    <div className="container mx-auto max-w-4xl px-4 py-8" data-testid="page-permissions">
      <div className="mb-8">
        <h1 className="text-3xl font-bold">Permissions</h1>
        <p className="text-muted-foreground mt-2">
          Manage your connected services and data access preferences
        </p>
      </div>

      <div className="space-y-6">
        <Card data-testid="card-context-hunting">
          <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
            <div className="flex items-start gap-4">
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10">
                <Mail className="h-6 w-6 text-primary" />
              </div>
              <div>
                <CardTitle className="text-xl">Allow Context Hunting</CardTitle>
                <div className="mt-2">
                  {isConnected ? (
                    <Badge variant="secondary" data-testid="badge-status-connected">
                      <Shield className="h-3 w-3 mr-1" />
                      Connected
                    </Badge>
                  ) : (
                    <Badge variant="outline" data-testid="badge-status-not-connected">
                      Not connected
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-muted-foreground">
              Enable email inbox access to find receipts that match your transactions. 
              Our AI performs targeted searches for specific merchants and amounts - nothing else is read or stored.
            </p>
            <p className="text-sm text-muted-foreground border-l-2 border-primary/30 pl-3">
              Your privacy is protected: searches are targeted, temporary, and no email content is saved.
            </p>
            
            {grantStatus?.connected_email && (
              <p className="text-sm">
                <span className="text-muted-foreground">Connected email: </span>
                <span className="font-medium">{grantStatus.connected_email}</span>
              </p>
            )}

            <div className="pt-2">
              <ConnectEmailButton />
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
