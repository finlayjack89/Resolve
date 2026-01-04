import { createContext, useContext, useState, useEffect, useCallback, useMemo, ReactNode } from "react";
import type { User } from "@shared/schema";

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string, firstName: string, lastName: string) => Promise<void>;
  continueAsGuest: () => Promise<void>;
  logout: () => Promise<void>;
  updateUser: (updates: Partial<User>) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    // Check for existing session on mount
    const checkAuth = async () => {
      try {
        // Check server-side session only - no localStorage auto-login
        const response = await fetch("/api/auth/me", {
          credentials: "include",
        });
        if (response.ok) {
          const userData = await response.json();
          setUser(userData);
        } else {
          // Clear any stale guest mode flag
          localStorage.removeItem("guestMode");
        }
      } catch (error) {
        console.error("Auth check failed:", error);
        localStorage.removeItem("guestMode");
      } finally {
        setIsLoading(false);
      }
    };
    checkAuth();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
      credentials: "include",
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Login failed");
    }

    const userData = await response.json();
    setUser(userData);
  }, []);

  const signup = useCallback(async (email: string, password: string, firstName?: string, lastName?: string) => {
    const response = await fetch("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password, firstName, lastName }),
      credentials: "include",
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.message || "Signup failed");
    }

    const userData = await response.json();
    setUser(userData);
  }, []);

  const continueAsGuest = useCallback(async () => {
    const response = await fetch("/api/auth/guest", {
      method: "POST",
      credentials: "include",
    });

    if (!response.ok) {
      throw new Error("Guest mode failed");
    }

    const userData = await response.json();
    localStorage.setItem("guestMode", "true");
    setUser(userData);
  }, []);

  const logout = useCallback(async () => {
    localStorage.removeItem("guestMode");
    await fetch("/api/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    setUser(null);
  }, []);

  const updateUser = useCallback((updates: Partial<User>) => {
    setUser(prev => prev ? { ...prev, ...updates } : null);
  }, []);

  const value = useMemo(() => ({ 
    user, 
    isLoading, 
    login, 
    signup, 
    continueAsGuest, 
    logout, 
    updateUser 
  }), [user, isLoading, login, signup, continueAsGuest, logout, updateUser]);

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
