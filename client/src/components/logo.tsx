import logoImage from "@assets/r6fabdpppdrgc0ctzdaafkpnnc_1765154340745.png";

interface LogoProps {
  className?: string;
  showTagline?: boolean;
  size?: "sm" | "md" | "lg";
}

export function Logo({ className = "", showTagline = false, size = "md" }: LogoProps) {
  const sizeClasses = {
    sm: "h-8 w-8",
    md: "h-10 w-10",
    lg: "h-12 w-12",
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <img 
        src={logoImage} 
        alt="Resolve Logo" 
        className={`${sizeClasses[size]} object-contain`}
      />
      <div className="flex flex-col">
        <span className="text-xl font-bold">Resolve</span>
        {showTagline && (
          <span className="text-xs text-muted-foreground">Re-solve the past. Resolve the future.</span>
        )}
      </div>
    </div>
  );
}

export { logoImage };
