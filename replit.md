# Resolve

## Overview
Resolve is a web-based debt optimization application designed to help users efficiently manage and pay off multiple credit accounts. Its core purpose is to minimize interest, fit user budgets, and honor promotional periods by providing clear, trustworthy financial guidance. The application aims to provide optimal repayment strategies and intelligent user interaction.

## User Preferences
Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend
- **Technology Stack**: React with TypeScript (Vite), Wouter, TanStack Query, shadcn/ui (Radix UI), Tailwind CSS.
- **Design Philosophy**: Hybrid design combining Material Design 3, Stripe, and Linear for trust, clarity, and efficient data entry.
- **Key Features**: Authentication, multi-step onboarding, account management, budget configuration, preference selection (optimization strategy, payment shape), plan generation, dashboard with ECharts visualizations, Payment Calendar, and an AI-powered Statement Guidance assistant.
- **Two-Truths UI**: Distinguishes between "Bank Reality" (raw ledger view including transfers) and "Budget Reality" (analysis-adjusted totals excluding internal transfers) for clarity in financial reporting.

### Backend
- **Technology Stack**: Express.js with TypeScript, Drizzle ORM, Passport.js for authentication. Python (FastAPI) for the optimization engine.
- **API Structure**: RESTful endpoints for core functionalities.
- **Authentication & Security**: Scrypt password hashing, session-based authentication, AES-256-GCM encryption for sensitive tokens.
- **Staged Onboarding Flow**: Allows users to connect multiple bank accounts before triggering a unified analysis, improving efficiency and user experience.
- **4-Layer Confidence-Gated Cascade**: A sequential transaction enrichment pipeline (Math Brain, Ntropy, Context Hunter, Sherlock) that prioritizes accuracy and stops when a high confidence threshold is met. Includes Ghost Pair detection for internal transfers and specific handling for bounced payments and refunds.
- **Recurring Payment Projection Engine**: Detects recurring bills based on transaction patterns and projects upcoming payments, categorizing them as PENDING, PAID, or OVERDUE.
- **Closed-Period Budget Analysis**: Calculates Safe-to-Spend using statistically accurate historical averages from complete past months, preventing inaccuracies from partial current month data.
- **Retroactive Consistency**: Ensures that changes or new detections in older transactions (e.g., transfers across month boundaries) trigger recalibrations across all affected accounts to maintain budget accuracy.
- **AI Research System**: Automates lender rule discovery.
- **Python Backend Integration**: FastAPI runs as a child process, utilizing the Google OR-Tools CP-SAT solver.

### Data Storage
- **Database**: PostgreSQL (Neon serverless) with Drizzle ORM.
- **Schema Design**: Tables for users, accounts, debt, budgets, preferences, plans, TrueLayer items, and more.
- **Key Data Patterns**: Monetary values in cents, percentages in basis points, JSONB for nested data, cascade deletes, encrypted sensitive data.

### Key Architectural Decisions
- **Two-Brain Separation**: Divides deterministic financial calculation (Python solver) from AI assistance (Anthropic Claude) for accuracy and user support.
- **Hybrid-Assisted Onboarding**: Combines TrueLayer automation, AI research, and human verification.
- **Monetary Precision**: All currency stored as cents and percentages as basis points to prevent floating-point errors.
- **Session-Based Authentication**: Secure, time-sensitive authentication.
- **Serverless Database**: Neon serverless PostgreSQL for scalability and reliability.
- **Client-Side State Management**: TanStack Query for efficient server state management and caching.
- **Component Design System**: shadcn/ui built on Radix UI for a consistent, accessible, and customizable UI.

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

**Database:**
- Neon serverless PostgreSQL: Cloud-hosted PostgreSQL.