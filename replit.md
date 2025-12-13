# Resolve

## Overview
Resolve is a web-based debt optimization application designed to help users manage and pay off multiple credit accounts efficiently. The app's tagline is "Re-solve the past. Resolve the future." It utilizes a deterministic Math Brain (Google OR-Tools CP-SAT solver) for mathematically optimal repayment strategies and a Language Brain (Anthropic Claude) for user interaction and data research. The application aims to minimize interest, fit user budgets, and honor promotional periods, providing clear and trustworthy financial guidance.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Technology Stack**: React with TypeScript (Vite), Wouter, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS.
- **Design Philosophy**: Hybrid design combining Material Design 3, Stripe, and Linear for trust, clarity, and efficient data entry. Typography uses Inter for UI and JetBrains Mono for financial values.
- **Key Features**: Authentication, multi-step onboarding, account management (CRUD), budget configuration (including future changes and lump sums), preference selection (optimization strategy, payment shape), plan generation, dashboard with ECharts visualizations, Payment Calendar with interactive event highlighting.

### Recent Updates (December 2024)
- **UK Lender Products Database**: Comprehensive database of 73 UK credit card products from 28 major lenders (American Express, Barclays, HSBC, Lloyds, etc.). Features cascading dropdown UI in Statement Wizard: select lender → select product → confirmation dialog shows APR, minimum payment rules, and membership fees → auto-populates form fields. Uses `lender_products` table with proper data precision (cents for fees, basis points for APRs). Query pattern uses custom queryFn with URL-encoded parameters: `/api/lender-products?lender=${encodeURIComponent(lenderName)}`.
- **Membership Fee Tracking**: Accounts now store membership fee data (`membershipFeeCents`, `membershipFeeFrequency`) for solver calculations. Annual fees automatically converted to monthly (÷12) for optimization. Frequencies: 'none', 'annual', 'monthly'.
- **Minimum Payment Rule Confirmation Dialog**: AI-discovered minimum payment rules now require explicit user confirmation before auto-populating form fields. Nested Radix Dialog pattern ensures proper UX flow. Users can accept or reject discovered rules. **Technical Note**: The `discoverRuleMutation` in statement-wizard.tsx must parse the Response object with `.json()` before accessing rule data.
- **Full-Width Layout Fix**: SidebarProvider moved inside AppLayout component to prevent sidebar space reservation on full-width pages (onboarding, login, signup). This ensures these pages span the entire viewport width.
- **TrueLayer Integration**: Replaced Plaid with TrueLayer for UK Open Banking. New OAuth2 flow, encrypted token storage, transaction fetching via TrueLayer Data API. Budget analysis uses deterministic categorization from transaction data.
- **Confirm and Save Plan**: Plans are now temporary until confirmed. The delete button has been replaced with a "Confirm and Save Plan" button. If users exit without confirming, their plan is automatically deleted. After confirmation, the button shows "Plan Saved!" and becomes disabled.
- **Statement Guidance AI Assistant**: New AI-powered assistant helps users find their balance bucket breakdown on their bank statements. Accessible from Step 3 (Bucket Builder) of the Statement Wizard via "Help me find this on my statement" button. Uses Claude Sonnet 4.5 to provide bank-specific guidance based on UK credit card statement standards.
- **Comprehensive E2E Testing**: Full end-to-end testing completed with 15 diverse test personas covering the complete user journey.
- **AI Model Fix**: Updated Anthropic model names to Replit AI Integrations compatible format (`claude-sonnet-4-5`, `claude-haiku-4-5`).
- **AI Chat Improvements**: ChatGPT-style conversation history with user/assistant message bubbles; uses Claude Haiku for fast responses.
- **Refresh Dashboard Button**: Manual refresh to fetch latest account and plan data.
- **Account Bucket Breakdown**: Detailed view of credit card balance segments (buckets) showing individual APRs, promo periods, and balances.
- **Plan Generation UX**: Smooth animated progress bar with percentage display; rotating finance tips with fade animation during generation.
- **Payment Calendar Page**: Full-screen calendar at `/calendar` showing:
  - Payment dates (blue) with hover tooltips showing accounts and amounts
  - Budget change dates (amber) with old→new budget values
  - Lump sum dates (green) with payment amounts
  - Account payoff dates (purple) celebrating debt-free milestones
  - Month/year navigation controls and "Today" button
  - Upcoming events list for next 3 months
- **Ntropy Enrichment with Streaming Progress**: Transaction enrichment uses Ntropy SDK for accurate merchant identification, recurrence detection, and budget categorization. Features:
  - Concurrent processing with asyncio.gather() for significantly faster enrichment
  - Real-time SSE streaming of enrichment progress from Python → Express → Frontend
  - EnrichmentProgressModal with animated Resolve logo, progress bar, transaction count, and ETA
  - Fallback to deterministic categorization if Ntropy is unavailable
  - Job orchestration in Express with in-memory registry for SSE broadcasting
- **Current Finances Page**: Multi-account bank connection management at `/current-finances` with:
  - Tile-based grid layout showing connected bank accounts with institution logos
  - Per-account detail view with categorized income/outgoings breakdown (employment, benefits, fixed costs, essentials, discretionary, debt payments)
  - Combined view aggregating all accounts with total debt repayment budget calculation
  - Side hustle flag per account to categorize income correctly
  - Real-time sync status and transaction counts per account
  - UK-specific category mapping (council tax, utilities, subscriptions, etc.)
- **Background Sync Scheduler**: Automatic 30-minute refresh of TrueLayer accounts with:
  - Per-account concurrency guards to prevent duplicate syncs
  - Token refresh handling for expired connections
  - Incremental enrichment: only processes new transactions not already cached
  - Monthly budget recalibration with next recalibration date tracking
  - Month-safe date arithmetic for end-of-month edge cases
  - Fallback to deterministic categorization if Ntropy is unavailable
- **Ntropy Enrichment Fixes (Dec 2024)**:
  - User schema updated: `name` column split into `firstName` and `lastName`
  - Account holder creation: calls `sdk.account_holders.create()` before enrichment
  - Budget analyzer math fixed: now caps at 3 complete months, excludes current partial month
  - Dynamic date range: `calculateDynamicDateRange()` fetches from 1st of 4th month ago
- **Monthly Breakdown UI**: Bank account detail page (`/current-finances/:id`) now includes:
  - "Monthly" tab with accordion showing expandable month rows
  - Current month labeled as "(MTD)" - Month to Date
  - Category breakdown with transaction counts and totals when expanded
  - Transactions grouped by category within each month
- **Category Filtering**: Clickable category rows in the "Spending by Category" section:
  - Click any category to filter all transaction views to that category
  - Filter badge shows active category with clear button
  - All tabs (All, Income, Outgoing, Monthly) respect the filter

### Backend
- **Technology Stack**: Express.js with TypeScript, Drizzle ORM, Passport.js (local strategy), session-based authentication. Python backend (FastAPI) for the optimization engine.
- **API Structure**: RESTful endpoints (`/api/auth`, `/api/accounts`, `/api/budget`, `/api/preferences`, `/api/plans`, `/api/truelayer/*`, `/api/lender-rules/*`, `/api/statement-guidance/*`).
- **Authentication & Security**: Scrypt password hashing, express-session management (30-minute timeout), AES-256-GCM encryption for TrueLayer tokens, secure credential storage.
- **TrueLayer Integration**: UK Open Banking connection via TrueLayer OAuth2 flow, encrypted access/refresh token storage, transaction and direct debit fetching for budget analysis.
- **AI Research System**: Claude 4.5 Sonnet for automated lender rule discovery with human verification, intelligent caching of verified rules.

### Data Storage
- **Database**: PostgreSQL (Neon serverless) with WebSocket support, Drizzle ORM.
- **Schema Design**: `users`, `accounts`, `debt_buckets`, `budgets`, `preferences`, `plans`, `lenderRules`, `lenderProducts`, `trueLayerItems`.
- **Key Data Patterns**: Monetary values in cents (integers), percentages in basis points (bps), JSONB for nested data, cascade deletes, encrypted sensitive data (TrueLayer tokens).
- **Security**: TrueLayer access/refresh tokens encrypted with AES-256-GCM using ENCRYPTION_SECRET environment variable.

### TrueLayer Integration (UK Open Banking)
- **Purpose**: Enables users to securely connect their UK bank accounts to fetch transaction history for budget analysis.
- **OAuth2 Flow**: User initiates connection via `/api/truelayer/auth-url`, completes authentication on TrueLayer, callback at `/api/truelayer/callback` exchanges code for tokens.
- **Token Management**: Access and refresh tokens encrypted with AES-256-GCM before storage. Automatic token refresh when consent expires.
- **Data Fetching**: Fetches transactions using dynamic date range (3 complete months + current MTD) via TrueLayer Data API. The `calculateDynamicDateRange()` function in `server/truelayer.ts` calculates from 1st of 4th month ago to today.
- **Budget Engine**: `server/services/budget-engine.ts` categorizes transactions into income, fixed costs, variable essentials, and discretionary spending using TrueLayer's `transaction_classification` field.
- **Environment Variables**: `TRUELAYER_CLIENT_ID`, `TRUELAYER_CLIENT_SECRET` stored as secrets. `TRUELAYER_REDIRECT_URI` auto-configured from Replit domain.
- **Live Mode**: Now using TrueLayer production environment (`USE_TRUELAYER_SANDBOX=false`). Users can connect real UK bank accounts (Barclays, HSBC, Lloyds, NatWest, etc.).

### Debt Buckets (UK Credit Card Feature)
- **Purpose**: UK credit cards often have multiple balance segments at different APRs (0% balance transfers, 24.9% purchases, 39.9% cash advances). The bucket system allows users to track these separately for accurate interest calculations and payment prioritization.
- **Bucket Types**: PURCHASES (blue), BALANCE_TRANSFER (green), MONEY_TRANSFER (purple), CASH_ADVANCE (amber), CUSTOM (gray).
- **Data Model**: Each bucket has `bucketType`, `balanceCents`, `aprBps`, `isPromo`, `promoExpiryDate`, and `label`. Bucket totals must equal the account's `currentBalanceCents`.
- **Solver Integration**: The Python solver uses weighted-average APR across buckets for interest calculations and respects bucket-level promo periods. When a promo expires, the bucket reverts to the account's standard APR. Validation ensures only Credit Card accounts can have buckets.
- **UI Flow**: 3-step Statement Wizard (Headline → Split Decision → Bucket Builder) guides users through creating bucket-enabled credit card accounts. Dashboard tiles show colored bucket segments with tooltips.
- **API Integration**: Use `GET /api/accounts?withBuckets=true` to fetch accounts with their bucket data. The frontend accounts and dashboard pages use this endpoint.
- **Guest Mode**: Buckets are fully supported in guest mode with in-memory storage via GuestStorageWrapper.

### Python Backend Integration
- **Setup**: FastAPI backend (`main.py`, `solver_engine.py`, `schemas.py`) runs as a child process of the Node.js server (port 8000).
- **Functionality**: Uses Google OR-Tools CP-SAT solver for mathematical optimization. Node.js proxies requests to Python.
- **Reliability**: Includes health checks, retry logic with exponential backoff for plan generation, and auto-restart capability for crashed Python processes.

### Key Architectural Decisions
- **Two-Brain Separation**: Divides financial calculation (deterministic Python solver) from AI assistance (Anthropic Claude "Language Brain") to ensure accuracy and intelligent user support. The Math Brain receives only verified structured data; the Language Brain handles research and explanations only.
- **Hybrid-Assisted Onboarding**: Combines TrueLayer automation (bank connections, transaction history) with AI research (minimum payment rules) and human verification to create a fast yet accurate onboarding flow.
- **Monetary Precision**: All currency stored as cents and percentages as basis points to prevent floating-point errors.
- **Session-Based Authentication**: Uses Passport.js with express-session for secure, time-sensitive authentication.
- **Serverless Database**: Neon serverless PostgreSQL for scalability and reliability.
- **Client-Side State Management**: TanStack Query for efficient server state management and caching.
- **Form Handling**: React Hook Form with Zod for type-safe, validated forms.
- **Component Design System**: shadcn/ui built on Radix UI primitives for a consistent, accessible, and customizable UI.

## External Dependencies

**AI Services:**
- Anthropic Claude Sonnet 4.5: Used for lender rule discovery (AI "Research Team") and plan explanations. Strictly forbidden from performing financial calculations per Two-Brain architecture.

**Banking Integration:**
- TrueLayer: UK Open Banking connection, transaction fetching, direct debit data for budget analysis. Supports UK banks via PSD2 Open Banking.

**Optimization Engine:**
- Google OR-Tools CP-SAT solver: Python implementation for deterministic mathematical debt optimization.

**UI Component Libraries:**
- Radix UI: Accessible component primitives.
- ECharts: Data visualization (debt timeline).
- React Hook Form with Zod: Form validation.
- date-fns: Date manipulation.
- shadcn/ui: Custom component library built on Radix UI.

**Database:**
- Neon serverless PostgreSQL: Cloud-hosted PostgreSQL with WebSocket support.
- Drizzle Kit: Database schema migrations.

**Development Tools:**
- Vite: Frontend build tool.
- TypeScript: Type safety.
- ESBuild: Server bundling.
