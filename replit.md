# Resolve

## Overview
Resolve is a web-based debt optimization application designed to help users efficiently manage and pay off multiple credit accounts. Its core purpose is to minimize interest, fit user budgets, and honor promotional periods by providing clear, trustworthy financial guidance. The application uses a deterministic Math Brain (Google OR-Tools CP-SAT solver) for optimal repayment strategies and a Language Brain (Anthropic Claude) for user interaction and data research.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Technology Stack**: React with TypeScript (Vite), Wouter, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS.
- **Design Philosophy**: Hybrid design combining Material Design 3, Stripe, and Linear for trust, clarity, and efficient data entry.
- **Key Features**: Authentication, multi-step onboarding, account management, budget configuration (including future changes and lump sums), preference selection (optimization strategy, payment shape), plan generation, dashboard with ECharts visualizations, Payment Calendar with interactive event highlighting, and an AI-powered Statement Guidance assistant.

### Backend
- **Technology Stack**: Express.js with TypeScript, Drizzle ORM, Passport.js (local strategy), session-based authentication. Python (FastAPI) for the optimization engine.
- **API Structure**: RESTful endpoints for authentication, accounts, budget, preferences, plans, and integrations (TrueLayer, lender rules, statement guidance).
- **Authentication & Security**: Scrypt password hashing, express-session, AES-256-GCM encryption for TrueLayer tokens.
- **TrueLayer Integration**: Handles OAuth2 flow, encrypted token storage, and transaction fetching for budget analysis.
- **Staged Onboarding Flow (Phase 1)**: New batch initialization approach prevents "partial analysis" of user accounts:
  - Added `processing_status` column to `trueLayerItems` table with values: STAGED, ANALYZING, ACTIVE, ERROR (defaults to STAGED)
  - TrueLayer OAuth callback now only saves tokens/metadata and sets status to STAGED without fetching transactions
  - Users can connect multiple bank accounts before triggering analysis
  - POST `/api/finances/initialize-analysis` endpoint fetches transactions for ALL STAGED accounts in parallel and updates them to ACTIVE
  - Transaction fetching uses 6-month window (from `calculateDynamicDateRange()`)
  - Onboarding flow has 4 steps: Profile → Location → Connect Accounts → Generate Report
  - The "Generate Resolve Report" button is disabled until at least one STAGED account exists
  - GET `/api/truelayer/status` returns `processingStatus` per account and count summaries (stagedCount, analyzingCount, activeCount, errorCount)
- **4-Layer Confidence-Gated Cascade**: Sequential enrichment pipeline with 0.80 confidence threshold that stops when confident:
  - **Layer 0 (Math Brain/Ghost Pair)**: Detects internal transfers (same amount, opposite directions, within 2 days). Sets confidence=1.0, enrichment_source="math_brain", excludes from analysis. STOPS cascade.
  - **Layer 1 (Ntropy)**: Merchant enrichment via Ntropy SDK v5.x with ambiguity penalties (Amazon/PayPal/Tesco/eBay = 0.5x, "General Merchandise" = 0.6x). If ntropy_confidence >= 0.80, sets enrichment_source="ntropy" and STOPS cascade.
  - **Layer 2 (Context Hunter)**: Nylas email search + Mindee OCR for receipt data. If confidence >= 0.80, sets enrichment_source="context_hunter" and STOPS.
  - **Layer 3 (Sherlock)**: Claude claude-sonnet-4-20250514 + web search for opaque transactions. Final categorization with enrichment_source="sherlock".
- **Ntropy SDK v5.x Response Structure**: The SDK returns entities/categories dicts instead of flat fields:
  - `entities.counterparty`: dict with `id`, `name`, `website`, `logo`, `mccs`, `type`
  - `categories.general`: string category name (e.g., "digital content and streaming", "groceries")
  - Top-level `merchant`, `logo`, `website` fields are always None - must use `entities.counterparty` instead
  - `recurrence`: enum string ('one-off', 'recurring', 'subscription')
- **Cascade Field Tracking**: Each transaction stores enrichment_source, ntropy_confidence, reasoning_trace (array of layer decisions), and exclude_from_analysis.
- **Transaction Reconciliation**: Ghost Pair detection (Layer 0) now runs FIRST in cascade, detecting inter-account transfers before Ntropy. Refunds/reversals detected via keyword matching + merchant/amount/date fuzzy matching. **Bounced Payment Detection**: `_determine_entry_type()` uses a 3-priority system: (1) Description keywords for bounce patterns like "RETURNED DD" take priority and ALWAYS return "incoming", (2) TrueLayer transaction_type field, (3) Original amount sign as fallback. This ensures bounced payment credits are correctly identified as incoming even when transaction_type says DEBIT. Phase 1 of ghost pair detection matches incoming bounced credits to original outgoing payments within 7 days. Both transactions are marked `exclude_from_analysis=true` to prevent returned payments from being counted as income.
- **Ghost Protocol Reconciliation (Phase 2)**: Eliminates double-counting by detecting internal transfers between connected accounts:
  - Added `isInternalTransfer` (boolean) and `ecosystemPairId` (UUID) columns to enrichedTransactions table
  - `detectGhostPairs()` function in server/services/reconciliation.ts matches outgoing/incoming transactions across DIFFERENT accounts with same amount within ±3 days
  - Integrated into `/api/finances/initialize-analysis` endpoint (Step 4.5) - runs after batch fetch, updates matched pairs
  - Both sides of matched transfers flagged: isInternalTransfer=true, excludeFromAnalysis=true, transactionType="transfer", enrichmentSource="math_brain"
  - Already-matched transactions excluded from re-matching to prevent duplicate flagging
  - Response includes `ghostPairsDetected` count
- **POTENTIAL_TRANSFER Category**: Added to UKBudgetCategory enum. `mapNtropyLabelsToCategory()` now accepts optional `connectedLenderNames` parameter - when a merchant name matches a connected lender (debt account), returns POTENTIAL_TRANSFER category instead of DEBT_PAYMENT. Wired into background-sync.ts and budget-analysis.ts call sites.
- **Re-enrichment Feature**: Existing transactions can be re-processed through the full enrichment cascade without requiring a new TrueLayer connection. Uses POST `/api/current-finances/account/:id/re-enrich` endpoint. Supports testing enrichment changes and triggering higher layers (Nylas/Sherlock) for low-confidence transactions.
- **Recalibration Endpoint**: POST `/api/current-finances/account/:id/recalibrate` forces recalculation of analysisSummary from existing transactions without requiring TrueLayer sync or Python enrichment. Useful when transaction flags (like excludeFromAnalysis) have been updated or budget calculation logic has changed.
- **PayPal/Amazon Confidence Penalty**: Payment processors (PayPal, Amazon, eBay, Klarna, Clearpay, Afterpay) detected in original bank description trigger 0.5x confidence penalty, dropping from 0.80 to 0.40 and triggering Layer 2 (Context Hunter) for better categorization.
- **Closed-Period Budget Analysis (Phase 3)**: Statistically accurate Safe-to-Spend calculation:
  - Transactions split into `closedHistory` (complete past months) and `activeMonth` (current partial month)
  - Historical averages calculated from ONLY closed history for statistical accuracy
  - `closedMonthsAnalyzed` field indicates number of full months used (capped at 6)
  - `currentMonthPacing` nested object contains: currentMonthSpendCents, currentMonthIncomeCents, projectedMonthSpendCents, projectedMonthIncomeCents, daysPassed, totalDaysInMonth, monthStartDate, monthEndDate
  - Edge case: When no closed history exists (new user in first month), projections from activeMonth are used as estimates with `analysisMonths=0` to indicate projected data
  - Legacy `analysisMonths` field preserved for backwards compatibility
- **Recurring Payment Projection Engine (Phase 4)**: Detects recurring bills and projects upcoming payments:
  - `recurring_patterns` table stores detected patterns with: merchantName, frequency (WEEKLY/FORTNIGHTLY/MONTHLY/QUARTERLY/ANNUAL), avgAmountCents, anchorDay, nextDueDate, confidenceScore
  - `detectRecurringPatterns()` function in server/services/frequency-detection.ts groups transactions by merchant, analyzes payment intervals, classifies frequency using median interval (±tolerance)
  - Frequency detection tolerances: WEEKLY (5-9 days), FORTNIGHTLY (12-16 days), MONTHLY (27-34 days), QUARTERLY (85-100 days), ANNUAL (350-380 days)
  - Minimum 2 occurrences required for pattern detection, 0.5 minimum confidence threshold
  - `getUpcomingBillsForCurrentMonth()` compares detected patterns against current month transactions to identify PENDING, PAID, or OVERDUE bills
  - Integrated into `/api/finances/initialize-analysis` endpoint (Step 5) - runs after ghost pair detection
  - GET `/api/projections/upcoming` returns upcoming and paid bills for current month with summary totals
  - GET `/api/projections/patterns` returns all detected recurring patterns for a user
  - PATCH `/api/projections/patterns/:id/deactivate` allows users to mark patterns as inactive
- **AI Research System**: Claude Sonnet 4.5 for automated lender rule discovery with human verification and intelligent caching.
- **Python Backend Integration**: FastAPI runs as a child process of the Node.js server, utilizing Google OR-Tools CP-SAT solver. Includes health checks, retry logic, and auto-restart.

### Data Storage
- **Database**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Schema Design**: Tables for users, accounts, debt buckets, budgets, preferences, plans, lender rules, lender products, TrueLayer items, subscription catalog, and Nylas grants.
- **Key Data Patterns**: Monetary values in cents, percentages in basis points, JSONB for nested data, cascade deletes, encrypted sensitive data.

### Key Architectural Decisions
- **Two-Brain Separation**: Divides deterministic financial calculation (Python solver) from AI assistance (Anthropic Claude) to ensure accuracy and intelligent user support.
- **Hybrid-Assisted Onboarding**: Combines TrueLayer automation, AI research, and human verification for a fast and accurate onboarding flow.
- **Monetary Precision**: All currency stored as cents and percentages as basis points to prevent floating-point errors.
- **Session-Based Authentication**: Passport.js with express-session for secure, time-sensitive authentication.
- **Serverless Database**: Neon serverless PostgreSQL for scalability and reliability.
- **Client-Side State Management**: TanStack Query for efficient server state management and caching.
- **Component Design System**: shadcn/ui built on Radix UI primitives for a consistent, accessible, and customizable UI.

## External Dependencies

**AI Services:**
- Anthropic Claude Sonnet 4.5: Used for lender rule discovery and plan explanations.

**Banking Integration:**
- TrueLayer: UK Open Banking connection for transaction fetching and budget analysis.

**Optimization Engine:**
- Google OR-Tools CP-SAT solver: Python implementation for deterministic mathematical debt optimization.

**UI Component Libraries:**
- Radix UI: Accessible component primitives.
- ECharts: Data visualization.
- shadcn/ui: Custom component library built on Radix UI.

**Database:**
- Neon serverless PostgreSQL: Cloud-hosted PostgreSQL.