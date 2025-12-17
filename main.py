# main.py (Production Ready - v1.5 - Streaming Enrichment)

import sys
import asyncio
import time
import json
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from typing import Optional, List, Dict, Any

# Import our Pydantic schemas
import schemas

# Import the enrichment service
from enrichment_service import EnrichmentService, enrich_and_analyze_budget, NtropyOutputModel

# Import the solver function AND the necessary dataclasses
# (We need the dataclasses to pass the correct type to the solver)
try:
    # Assuming solver_engine.py is in the same directory
    from solver_engine import (
        generate_payment_plan,
        DebtPortfolio as SolverDebtPortfolio, # Rename to avoid clash
        Account as SolverAccount,
        MinPaymentRule as SolverMinPaymentRule,
        DebtBucket as SolverDebtBucket,
        Budget as SolverBudget,
        UserPreferences as SolverUserPreferences, # <-- This is the alias
        AccountType,
        BucketType,
        OptimizationStrategy,
        PaymentShape,
        MonthlyResult as SolverMonthlyResult # Keep solver's MonthlyResult separate
    )
except ImportError as e:
    print(f"Error importing from solver_engine: {e}", file=sys.stderr)
    print("Ensure solver_engine.py is in the same directory.", file=sys.stderr)
    raise e # Re-raise the original ImportError


# Create the FastAPI app instance
app = FastAPI(
    title="Resolve API",
    description="API for generating optimized debt repayment plans.",
    version="0.1.0",
)

# --- Health Check Endpoint ---
@app.get("/health")
async def health_check():
    """
    Simple health check endpoint to verify the service is running.
    Returns 200 OK when the server is ready to accept requests.
    """
    return {"status": "healthy", "service": "resolve-optimization-engine"}

# --- Helper Function for Data Conversion ---
def convert_schema_to_solver_portfolio(
    portfolio_schema: schemas.DebtPortfolio
) -> SolverDebtPortfolio:
    """Converts Pydantic schema input to solver's dataclass input."""
    solver_accounts = []
    for acc_schema in portfolio_schema.accounts:
        # Convert the nested Pydantic MinPaymentRule to the solver's dataclass
        solver_rule = SolverMinPaymentRule(**acc_schema.min_payment_rule.model_dump())
        
        # Convert buckets if present
        # Filter bucket_data to only include valid SolverDebtBucket dataclass fields
        # to avoid TypeError when database fields like "id" are present
        solver_bucket_fields = {'bucket_type', 'balance_cents', 'apr_bps', 'is_promo', 'promo_expiry_date', 'label'}
        solver_buckets = []
        for bucket_schema in acc_schema.buckets:
            bucket_data = bucket_schema.model_dump()
            # Filter to only include fields that exist in the solver's DebtBucket dataclass
            filtered_bucket_data = {k: v for k, v in bucket_data.items() if k in solver_bucket_fields}
            solver_buckets.append(SolverDebtBucket(**filtered_bucket_data))
        
        # Exclude the rule and buckets from the main account data to avoid TypeError
        acc_data = acc_schema.model_dump(exclude={'min_payment_rule', 'buckets'})
        
        # Create the solver's Account dataclass with buckets
        solver_accounts.append(SolverAccount(
            min_payment_rule=solver_rule, 
            buckets=solver_buckets,
            **acc_data
        ))

    # Convert the Budget schema to its dataclass
    solver_budget = SolverBudget(**portfolio_schema.budget.model_dump())
    
    # Convert the UserPreferences schema to its dataclass
    solver_prefs = SolverUserPreferences(**portfolio_schema.preferences.model_dump())

    # Assemble the final SolverDebtPortfolio
    return SolverDebtPortfolio(
        accounts=solver_accounts,
        budget=solver_budget,
        preferences=solver_prefs,
        plan_start_date=portfolio_schema.plan_start_date
    )

# --- API Endpoint ---
@app.post("/generate-plan", response_model=schemas.OptimizationPlanResponse)
async def create_payment_plan(portfolio_input: schemas.DebtPortfolio):
    """
    Receives debt portfolio details, generates an optimized payment plan,
    and returns the plan or an error status.
    """
    print("Received request to /generate-plan")
    try:
        # 1. Convert Pydantic input schemas to the solver's dataclasses
        print("Converting Pydantic schemas to solver dataclasses...")
        solver_portfolio = convert_schema_to_solver_portfolio(portfolio_input)

        # 2. Call the solver engine
        print("Calling solver engine...")
        plan_results: Optional[List[SolverMonthlyResult]] = generate_payment_plan(
            solver_portfolio
        )
        print("Solver finished.")


        # 3. Process the results
        if plan_results is not None:
            solver_status = "OPTIMAL" 

            # --- THIS IS THE FIX ---
            # Convert solver's dataclass results back to Pydantic models
            print("Converting solver results back to Pydantic schemas...")
            plan_output = [
                # Use .model_validate() and the dataclass's __dict__
                schemas.MonthlyResult.model_validate(result.__dict__) 
                for result in plan_results
            ]
            # --- END OF FIX ---
            
            print(f"Plan generated successfully. Status: {solver_status}")
            return schemas.OptimizationPlanResponse(
                status=solver_status, 
                message="Optimization plan generated successfully.",
                plan=plan_output
            )
        else:
            solver_status = "INFEASIBLE" 
            print("Solver failed to find a solution.")
            return schemas.OptimizationPlanResponse(
                status=solver_status, 
                message="Could not find a feasible payment plan within the given constraints and time limit.",
                plan=None
            )

    except ValueError as ve:
        print(f"Input validation error: {ve}")
        raise HTTPException(status_code=400, detail=str(ve))
    except NotImplementedError as nie:
        print(f"Solver error: {nie}")
        raise HTTPException(status_code=400, detail=str(nie))
    except Exception as e:
        print(f"An unexpected error occurred: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail="An internal server error occurred during plan generation.")


# --- Transaction Enrichment Endpoint ---
class EnrichmentRequest(schemas.BaseModel):
    """Request for transaction enrichment"""
    transactions: List[Dict[str, Any]]
    user_id: str
    truelayer_item_id: str
    analysis_months: int = 3
    account_holder_name: Optional[str] = None
    country: str = "GB"

class EnrichmentResponse(schemas.BaseModel):
    """Response from transaction enrichment"""
    success: bool
    enriched_transactions: List[Dict[str, Any]]
    budget_analysis: Dict[str, Any]
    detected_debts: List[Dict[str, Any]]
    message: Optional[str] = None


@app.post("/enrich-transactions", response_model=EnrichmentResponse)
async def enrich_transactions(request: EnrichmentRequest):
    """
    Enriches TrueLayer transactions with Ntropy and returns budget classification.
    
    This endpoint:
    1. Normalizes raw TrueLayer transaction data
    2. Enriches with Ntropy for merchant info and labels (if available)
    3. Classifies transactions into budget categories (debt/fixed/discretionary)
    4. Computes budget breakdown
    """
    print(f"[Enrichment] Received request to enrich {len(request.transactions)} transactions")
    
    try:
        result = await enrich_and_analyze_budget(
            raw_transactions=request.transactions,
            user_id=request.user_id,
            truelayer_item_id=request.truelayer_item_id,
            analysis_months=request.analysis_months,
            account_holder_name=request.account_holder_name,
            country=request.country
        )
        
        print(f"[Enrichment] Successfully enriched transactions. Found {len(result['detected_debts'])} potential debts.")
        
        return EnrichmentResponse(
            success=True,
            enriched_transactions=result["enriched_transactions"],
            budget_analysis=result["budget_analysis"],
            detected_debts=result["detected_debts"],
            message=f"Enriched {len(result['enriched_transactions'])} transactions"
        )
        
    except Exception as e:
        print(f"[Enrichment] Error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Enrichment failed: {str(e)}")


# --- Streaming Enrichment Endpoint ---
class StreamingEnrichmentRequest(schemas.BaseModel):
    """Request for streaming transaction enrichment"""
    transactions: List[Dict[str, Any]]
    user_id: str
    truelayer_item_id: str
    analysis_months: int = 3
    account_holder_name: Optional[str] = None
    country: str = "GB"


@app.post("/enrich-transactions-stream")
async def enrich_transactions_streaming(request: StreamingEnrichmentRequest):
    """
    Streams enrichment progress as Server-Sent Events.
    
    Returns SSE stream with events:
    - {"type": "progress", "current": N, "total": M, "status": "...", "startTime": ...}
    - {"type": "complete", "result": {...}}
    - {"type": "error", "message": "..."}
    """
    print(f"[Enrichment Stream] Starting streaming enrichment for {len(request.transactions)} transactions")
    
    service = EnrichmentService()
    
    async def generate_events():
        try:
            async for event in service.enrich_transactions_streaming(
                raw_transactions=request.transactions,
                user_id=request.user_id,
                truelayer_item_id=request.truelayer_item_id,
                account_holder_name=request.account_holder_name,
                country=request.country
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            print(f"[Enrichment Stream] Error: {e}", file=sys.stderr)
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
    
    return StreamingResponse(
        generate_events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no"
        }
    )


# --- Subscription Detective Endpoint (Phase 2) ---
try:
    from agents.graph import classify_subscription, TransactionInput, SubscriptionClassification
    SUBSCRIPTION_DETECTIVE_AVAILABLE = True
    print("[SubscriptionDetective] LangGraph agent loaded successfully")
except ImportError as e:
    SUBSCRIPTION_DETECTIVE_AVAILABLE = False
    print(f"[SubscriptionDetective] Warning: Agent not available - {e}")


class ClassifySubscriptionRequest(schemas.BaseModel):
    """Request to classify a transaction as subscription or one-off"""
    transaction_id: str
    merchant_name: str
    amount_cents: int
    currency: str = "GBP"
    description: Optional[str] = None


class ClassifySubscriptionResponse(schemas.BaseModel):
    """Response from subscription classification"""
    transaction_id: str
    is_subscription: bool
    subscription_id: Optional[str] = None
    product_name: Optional[str] = None
    confidence: float
    reasoning_trace: List[Dict[str, str]]


@app.post("/classify-subscription", response_model=ClassifySubscriptionResponse)
async def classify_subscription_endpoint(request: ClassifySubscriptionRequest):
    """
    Classify a transaction as a subscription or one-off purchase.
    
    This endpoint runs the Subscription Detective LangGraph agent:
    1. Checks the subscription_catalog for exact matches
    2. If no match, searches the web for subscription pricing
    3. Updates the catalog with discovered plans
    4. Returns classification with reasoning trace
    """
    if not SUBSCRIPTION_DETECTIVE_AVAILABLE:
        raise HTTPException(
            status_code=503,
            detail="Subscription Detective agent not available"
        )
    
    print(f"[SubscriptionDetective] Classifying: {request.merchant_name} ({request.amount_cents/100:.2f} {request.currency})")
    
    try:
        transaction = TransactionInput(
            transaction_id=request.transaction_id,
            merchant_name=request.merchant_name,
            amount_cents=request.amount_cents,
            currency=request.currency,
            description=request.description
        )
        
        result = await classify_subscription(transaction=transaction, db_connection=None)
        
        print(f"[SubscriptionDetective] Result: is_subscription={result.is_subscription}, confidence={result.confidence:.0%}")
        
        return ClassifySubscriptionResponse(
            transaction_id=result.transaction_id,
            is_subscription=result.is_subscription,
            subscription_id=result.subscription_id,
            product_name=result.product_name,
            confidence=result.confidence,
            reasoning_trace=result.reasoning_trace
        )
        
    except Exception as e:
        print(f"[SubscriptionDetective] Error: {e}", file=sys.stderr)
        raise HTTPException(status_code=500, detail=f"Classification failed: {str(e)}")


# --- Email Context Hunter Endpoints (Phase 3) ---
try:
    from agents.email_context import (
        get_nylas_connector,
        parse_receipt_content,
        EmailReceipt,
        ParsedReceiptData
    )
    EMAIL_CONTEXT_AVAILABLE = True
    print("[EmailContext] Email context module loaded successfully")
except ImportError as e:
    EMAIL_CONTEXT_AVAILABLE = False
    print(f"[EmailContext] Warning: Module not available - {e}")


class NylasAuthUrlRequest(schemas.BaseModel):
    """Request to generate Nylas OAuth URL"""
    redirect_uri: str
    state: Optional[str] = None


class NylasAuthUrlResponse(schemas.BaseModel):
    """Response with Nylas OAuth URL"""
    auth_url: Optional[str] = None
    error: Optional[str] = None


class NylasExchangeCodeRequest(schemas.BaseModel):
    """Request to exchange OAuth code for grant"""
    code: str
    redirect_uri: str


class NylasExchangeCodeResponse(schemas.BaseModel):
    """Response with Nylas grant information"""
    grant_id: Optional[str] = None
    email: Optional[str] = None
    provider: Optional[str] = None
    error: Optional[str] = None


class FetchReceiptsRequest(schemas.BaseModel):
    """Request to fetch receipt emails"""
    grant_id: str
    since_days: int = 30
    limit: int = 50


class FetchReceiptsResponse(schemas.BaseModel):
    """Response with fetched receipts"""
    receipts: List[Dict[str, Any]] = []
    count: int = 0
    error: Optional[str] = None


class ParseReceiptRequest(schemas.BaseModel):
    """Request to parse a receipt email"""
    subject: str
    body: str
    sender_email: str


class ParseReceiptResponse(schemas.BaseModel):
    """Response with parsed receipt data"""
    merchant_name: Optional[str] = None
    amount_cents: Optional[int] = None
    currency: Optional[str] = None
    transaction_date: Optional[str] = None
    items: List[Dict[str, Any]] = []
    confidence: float = 0.0
    error: Optional[str] = None


@app.get("/email/status")
async def email_status():
    """Check if email integration is available and configured"""
    if not EMAIL_CONTEXT_AVAILABLE:
        return {"available": False, "reason": "Module not loaded"}
    
    connector = get_nylas_connector()
    return {
        "available": connector.is_available(),
        "nylas_configured": connector.client is not None,
        "client_id_set": connector.client_id is not None
    }


@app.post("/email/auth-url", response_model=NylasAuthUrlResponse)
async def get_nylas_auth_url(request: NylasAuthUrlRequest):
    """
    Generate Nylas OAuth URL for email connection.
    
    The user should be redirected to this URL to authorize email access.
    """
    if not EMAIL_CONTEXT_AVAILABLE:
        return NylasAuthUrlResponse(error="Email integration not available")
    
    connector = get_nylas_connector()
    
    if not connector.is_available():
        return NylasAuthUrlResponse(error="Nylas not configured - check API keys")
    
    auth_url = connector.get_auth_url(
        redirect_uri=request.redirect_uri,
        state=request.state
    )
    
    if auth_url:
        print(f"[EmailContext] Generated auth URL for redirect to: {request.redirect_uri}")
        return NylasAuthUrlResponse(auth_url=auth_url)
    else:
        return NylasAuthUrlResponse(error="Failed to generate auth URL")


@app.post("/email/exchange-code", response_model=NylasExchangeCodeResponse)
async def exchange_nylas_code(request: NylasExchangeCodeRequest):
    """
    Exchange OAuth authorization code for Nylas grant.
    
    This should be called after the user completes OAuth and is redirected
    back to your application with a code parameter.
    """
    if not EMAIL_CONTEXT_AVAILABLE:
        return NylasExchangeCodeResponse(error="Email integration not available")
    
    connector = get_nylas_connector()
    
    if not connector.is_available():
        return NylasExchangeCodeResponse(error="Nylas not configured")
    
    result = connector.exchange_code_for_grant(
        code=request.code,
        redirect_uri=request.redirect_uri
    )
    
    if result:
        print(f"[EmailContext] Exchanged code for grant: {result.get('grant_id')}")
        return NylasExchangeCodeResponse(
            grant_id=result.get("grant_id"),
            email=result.get("email"),
            provider=result.get("provider")
        )
    else:
        return NylasExchangeCodeResponse(error="Failed to exchange code for grant")


@app.post("/email/fetch-receipts", response_model=FetchReceiptsResponse)
async def fetch_receipt_emails(request: FetchReceiptsRequest):
    """
    Fetch receipt emails from user's mailbox.
    
    Requires a valid Nylas grant_id obtained from the OAuth flow.
    """
    if not EMAIL_CONTEXT_AVAILABLE:
        return FetchReceiptsResponse(error="Email integration not available")
    
    connector = get_nylas_connector()
    
    if not connector.is_available():
        return FetchReceiptsResponse(error="Nylas not configured")
    
    from datetime import datetime, timedelta
    since = datetime.now() - timedelta(days=request.since_days)
    
    receipts = connector.fetch_receipt_emails(
        grant_id=request.grant_id,
        since=since,
        limit=request.limit
    )
    
    receipt_dicts = [
        {
            "message_id": r.message_id,
            "sender_email": r.sender_email,
            "subject": r.subject,
            "received_at": r.received_at.isoformat(),
            "has_body": r.body_text is not None
        }
        for r in receipts
    ]
    
    print(f"[EmailContext] Fetched {len(receipts)} receipts for grant {request.grant_id}")
    return FetchReceiptsResponse(receipts=receipt_dicts, count=len(receipts))


@app.post("/email/parse-receipt", response_model=ParseReceiptResponse)
async def parse_receipt_email(request: ParseReceiptRequest):
    """
    Parse a receipt email to extract structured data.
    
    Uses Claude to intelligently extract merchant, amount, and items.
    """
    if not EMAIL_CONTEXT_AVAILABLE:
        return ParseReceiptResponse(error="Email integration not available")
    
    try:
        result = await parse_receipt_content(
            email_subject=request.subject,
            email_body=request.body,
            sender_email=request.sender_email
        )
        
        print(f"[EmailContext] Parsed receipt: merchant={result.merchant_name}, amount={result.amount_cents}, confidence={result.confidence}")
        
        return ParseReceiptResponse(
            merchant_name=result.merchant_name,
            amount_cents=result.amount_cents,
            currency=result.currency,
            transaction_date=result.transaction_date,
            items=result.items,
            confidence=result.confidence
        )
        
    except Exception as e:
        print(f"[EmailContext] Parse error: {e}")
        return ParseReceiptResponse(error=f"Failed to parse receipt: {str(e)}")


# --- Context Hunter: Receipt-to-Transaction Matching ---
try:
    from agents.context_hunter import find_matches_for_user, apply_matches, ReceiptMatch
    CONTEXT_HUNTER_AVAILABLE = True
    print("[ContextHunter] Context Hunter module loaded successfully")
except ImportError as e:
    CONTEXT_HUNTER_AVAILABLE = False
    print(f"[ContextHunter] Warning: Module not available - {e}")


class MatchReceiptsRequest(schemas.BaseModel):
    """Request to match receipts to transactions"""
    connection_id: str
    user_id: str
    days_back: int = 60
    min_confidence: float = 0.6
    apply_matches: bool = False


class MatchReceiptsResponse(schemas.BaseModel):
    """Response with matched receipts and transactions"""
    matches: List[Dict[str, Any]] = []
    match_count: int = 0
    applied_count: int = 0
    error: Optional[str] = None


@app.post("/email/match-receipts", response_model=MatchReceiptsResponse)
async def match_receipts_to_transactions(request: MatchReceiptsRequest):
    """
    Match email receipts to bank transactions.
    
    Uses fuzzy matching on merchant name, amount, and date proximity
    to find the best matches between receipts and transactions.
    
    Args:
        connection_id: The email connection ID (from emailConnections table)
        user_id: The user ID
        days_back: How many days of transactions to consider (default 60)
        min_confidence: Minimum confidence threshold (default 0.6)
        apply_matches: If true, updates the database with matches
    
    Returns:
        List of matches with confidence scores and match details
    """
    if not CONTEXT_HUNTER_AVAILABLE:
        return MatchReceiptsResponse(error="Context Hunter not available")
    
    print(f"[ContextHunter] Matching receipts for connection {request.connection_id}")
    
    try:
        matches = await find_matches_for_user(
            connection_id=request.connection_id,
            user_id=request.user_id,
            days_back=request.days_back,
            min_confidence=request.min_confidence
        )
        
        applied_count = 0
        if request.apply_matches and matches:
            applied_count = await apply_matches(matches)
        
        match_dicts = [
            {
                "receipt_id": m.receipt_id,
                "transaction_id": m.transaction_id,
                "confidence": m.confidence,
                "match_details": m.match_details
            }
            for m in matches
        ]
        
        print(f"[ContextHunter] Found {len(matches)} matches, applied {applied_count}")
        
        return MatchReceiptsResponse(
            matches=match_dicts,
            match_count=len(matches),
            applied_count=applied_count
        )
        
    except Exception as e:
        print(f"[ContextHunter] Error: {e}")
        return MatchReceiptsResponse(error=f"Matching failed: {str(e)}")
