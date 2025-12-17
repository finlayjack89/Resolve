import { Router } from "express";
import { requireAuth } from "../auth";

const router = Router();
const PYTHON_API_URL = "http://127.0.0.1:8000";

router.get("/status", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${PYTHON_API_URL}/email/status`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("[Email] Status check failed:", error);
    res.status(500).json({ available: false, error: "Failed to check email status" });
  }
});

router.post("/auth-url", requireAuth, async (req, res) => {
  try {
    const { redirectUri, state } = req.body;
    
    const response = await fetch(`${PYTHON_API_URL}/email/auth-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uri: redirectUri,
        state: state
      })
    });
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("[Email] Auth URL generation failed:", error);
    res.status(500).json({ error: "Failed to generate auth URL" });
  }
});

router.post("/callback", requireAuth, async (req, res) => {
  try {
    const { code, redirectUri } = req.body;
    
    const response = await fetch(`${PYTHON_API_URL}/email/exchange-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: code,
        redirect_uri: redirectUri
      })
    });
    
    const data = await response.json();
    
    if (data.grant_id && data.email) {
      res.json({
        success: true,
        grantId: data.grant_id,
        email: data.email,
        provider: data.provider
      });
    } else {
      res.status(400).json({ success: false, error: data.error || "Failed to exchange code" });
    }
  } catch (error) {
    console.error("[Email] Code exchange failed:", error);
    res.status(500).json({ success: false, error: "Failed to exchange authorization code" });
  }
});

router.post("/fetch-receipts", requireAuth, async (req, res) => {
  try {
    const { grantId, sinceDays = 30, limit = 50 } = req.body;
    
    if (!grantId) {
      return res.status(400).json({ error: "grantId is required" });
    }
    
    const response = await fetch(`${PYTHON_API_URL}/email/fetch-receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_id: grantId,
        since_days: sinceDays,
        limit: limit
      })
    });
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("[Email] Fetch receipts failed:", error);
    res.status(500).json({ error: "Failed to fetch receipts" });
  }
});

router.post("/parse-receipt", requireAuth, async (req, res) => {
  try {
    const { subject, body, senderEmail } = req.body;
    
    if (!subject || !body || !senderEmail) {
      return res.status(400).json({ error: "subject, body, and senderEmail are required" });
    }
    
    const response = await fetch(`${PYTHON_API_URL}/email/parse-receipt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        subject: subject,
        body: body,
        sender_email: senderEmail
      })
    });
    
    const data = await response.json();
    res.json(data);
  } catch (error) {
    console.error("[Email] Parse receipt failed:", error);
    res.status(500).json({ error: "Failed to parse receipt" });
  }
});

router.post("/match-receipts", requireAuth, async (req, res) => {
  try {
    const { connectionId, userId, daysBack = 60, minConfidence = 0.6, applyMatches = false } = req.body;
    
    if (!connectionId || !userId) {
      return res.status(400).json({ error: "connectionId and userId are required" });
    }
    
    const response = await fetch(`${PYTHON_API_URL}/email/match-receipts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        connection_id: connectionId,
        user_id: userId,
        days_back: daysBack,
        min_confidence: minConfidence,
        apply_matches: applyMatches
      })
    });
    
    const data = await response.json();
    
    if (data.error) {
      return res.status(500).json({ error: data.error });
    }
    
    res.json({
      matches: data.matches || [],
      matchCount: data.match_count || 0,
      appliedCount: data.applied_count || 0
    });
  } catch (error) {
    console.error("[Email] Match receipts failed:", error);
    res.status(500).json({ error: "Failed to match receipts to transactions" });
  }
});

export default router;
