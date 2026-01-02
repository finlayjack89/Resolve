import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { type Express } from "express";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import type { User } from "@shared/schema";
import { pool } from "./db";

const scryptAsync = promisify(scrypt);
const PgSessionStore = connectPgSimple(session);

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function comparePasswords(
  supplied: string,
  stored: string,
): Promise<boolean> {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express) {
  const isProduction = process.env.NODE_ENV === "production";
  
  // Create the session table if it doesn't exist
  const pgStore = new PgSessionStore({
    pool: pool as any, // Use the existing database pool
    tableName: 'session', // Table will be auto-created
    createTableIfMissing: true,
    ttl: 60 * 60, // 1 hour TTL to match cookie maxAge
  });
  
  // Replit dev domain uses HTTPS, so we need secure cookies and sameSite=none
  // to survive cross-site redirects (e.g., TrueLayer OAuth callback)
  const isSecureContext = isProduction || !!process.env.REPLIT_DEV_DOMAIN;
  
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || "paydown-pilot-secret-key",
    resave: false,
    saveUninitialized: false,
    cookie: {
      maxAge: 60 * 60 * 1000, // 1 hour
      httpOnly: true,
      // Use secure cookies on HTTPS (production or Replit dev domain)
      secure: isSecureContext,
      // CRITICAL: Must be 'none' for cross-site redirects (TrueLayer OAuth)
      // 'lax' blocks cookies on third-party redirects in modern browsers
      sameSite: isSecureContext ? "none" : "lax",
    },
    store: pgStore,
  };

  // Enable trust proxy for Replit deployment (required for secure cookies behind proxy)
  app.set("trust proxy", 1);

  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(
      { usernameField: "email" },
      async (email, password, done) => {
        try {
          const user = await storage.getUserByEmail(email);
          if (!user) {
            return done(null, false, { message: "Incorrect email or password" });
          }
          const isValid = await comparePasswords(password, user.password);
          if (!isValid) {
            return done(null, false, { message: "Incorrect email or password" });
          }
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      },
    ),
  );

  passport.serializeUser((user: any, done) => {
    // For guest users, serialize the entire user object
    // For regular users, just serialize the ID
    if (user.id === "guest-user") {
      done(null, user);
    } else {
      done(null, user.id);
    }
  });

  passport.deserializeUser(async (idOrUser: string | any, done) => {
    try {
      // Add logging to diagnose deserialization issues
      console.log("[deserializeUser] Input type:", typeof idOrUser, "Value:", 
        typeof idOrUser === "object" ? JSON.stringify(idOrUser) : idOrUser);
      
      // If it's a guest user object, return it directly
      if (typeof idOrUser === "object" && idOrUser.id === "guest-user") {
        console.log("[deserializeUser] Returning guest user");
        return done(null, idOrUser);
      }
      
      // If it's a string ID, fetch from database
      const id = typeof idOrUser === "string" ? idOrUser : idOrUser?.id;
      
      if (!id) {
        console.error("[deserializeUser] No valid ID found in:", idOrUser);
        return done(null, false);
      }
      
      const user = await storage.getUser(id);
      
      if (!user) {
        console.error("[deserializeUser] User not found for ID:", id);
        return done(null, false);
      }
      
      console.log("[deserializeUser] Successfully deserialized user:", user.email);
      done(null, user);
    } catch (err) {
      console.error("[deserializeUser] Error during deserialization:", err);
      done(err);
    }
  });
}

export function requireAuth(req: any, res: any, next: any) {
  if (!req.isAuthenticated()) {
    return res.status(401).send({ message: "Not authenticated" });
  }
  next();
}
