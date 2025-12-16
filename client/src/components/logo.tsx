import { Wallet } from "lucide-react";

interface LogoProps {
  className?: string;
  showTagline?: boolean;
  size?: "sm" | "md" | "lg";
}

export function Logo({ className = "", showTagline = false, size = "md" }: LogoProps) {
  const sizeClasses = {
    sm: "h-6 w-6",
    md: "h-8 w-8",
    lg: "h-10 w-10",
  };

  const iconSizes = {
    sm: "h-4 w-4",
    md: "h-5 w-5",
    lg: "h-6 w-6",
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className={`${sizeClasses[size]} rounded-lg bg-primary flex items-center justify-center`}>
        <Wallet className={`${iconSizes[size]} text-primary-foreground`} />
      </div>
      <div className="flex flex-col">
        <span className="text-xl font-bold">Resolve</span>
        {showTagline && (
          <span className="text-xs text-muted-foreground">Re-solve the past. Resolve the future.</span>
        )}
      </div>
    </div>
  );
}
