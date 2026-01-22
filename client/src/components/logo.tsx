interface LogoProps {
  className?: string;
  showTagline?: boolean;
  size?: "sm" | "md" | "lg";
}

export function Logo({ className = "", showTagline = false, size = "md" }: LogoProps) {
  const sizeClasses = {
    sm: "text-lg",
    md: "text-xl",
    lg: "text-2xl",
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <div className="flex flex-col">
        <span className={`${sizeClasses[size]} font-bold`}>Resolve</span>
        {showTagline && (
          <span className="text-xs text-muted-foreground">Re-solve the past. Resolve the future.</span>
        )}
      </div>
    </div>
  );
}
