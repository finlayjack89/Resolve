# main.py (Production Ready - v1.6 - Streaming Enrichment with DB Persistence)

import sys
import asyncio
import time
import json
import httpx
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
    nylas_grant_id: Optional[str] = None


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
                country=request.country,
                nylas_grant_id=request.nylas_grant_id
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


# ============================================
# Phase C & D: Agentic Enrichment Endpoints
# ============================================

from fastapi import BackgroundTasks, Query
import os

# Import agentic enrichment components
try:
    from agents.enrichment_agent import (
        enrich_transaction,
        create_enrichment_job,
        get_enrichment_job,
        run_enrichment_pipeline
    )
    from agents.services.nylas_service import get_nylas_service
    from agents.parallel_enrichment import get_agentic_queue
    AGENTIC_ENRICHMENT_AVAILABLE = True
    print("[Agentic Enrichment] Successfully loaded enrichment agent")
except ImportError as e:
    AGENTIC_ENRICHMENT_AVAILABLE = False
    print(f"[Agentic Enrichment] Warning: Could not load enrichment agent: {e}")


# Node.js API base URL for enrichment persistence
NODE_API_URL = os.environ.get("NODE_API_URL", "http://localhost:5000")


async def db_upsert_func(
    transaction_id: str,
    enrichment_stage: str,
    agentic_confidence: Optional[float] = None,
    enrichment_source: Optional[str] = None,
    is_subscription: bool = False,
    context_data: Optional[Dict[str, Any]] = None,
    reasoning_trace: Optional[List[str]] = None
) -> bool:
    """
    Async function that calls the Node.js API to update enrichment results.
    This is passed to get_agentic_queue() to enable database persistence.
    """
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(
                f"{NODE_API_URL}/api/internal/enrichment-update",
                json={
                    "transaction_id": transaction_id,
                    "enrichment_stage": enrichment_stage,
                    "agentic_confidence": agentic_confidence,
                    "enrichment_source": enrichment_source,
                    "is_subscription": is_subscription,
                    "context_data": context_data,
                    "reasoning_trace": reasoning_trace
                }
            )
            
            if response.status_code == 200:
                result = response.json()
                if result.get("success"):
                    print(f"[DB Upsert] Successfully updated {transaction_id[:16]}...")
                    return True
                else:
                    print(f"[DB Upsert] API returned error for {transaction_id[:16]}...: {result.get('error')}")
                    return False
            else:
                print(f"[DB Upsert] HTTP {response.status_code} for {transaction_id[:16]}...: {response.text}")
                return False
                
    except httpx.TimeoutException:
        print(f"[DB Upsert] Timeout updating {transaction_id[:16]}...")
        return False
    except Exception as e:
        print(f"[DB Upsert] Error updating {transaction_id[:16]}...: {e}")
        return False


# Initialize the agentic queue with db_upsert_func at startup
if AGENTIC_ENRICHMENT_AVAILABLE:
    try:
        _agentic_queue = get_agentic_queue(db_upsert_func=db_upsert_func)
        print("[Agentic Enrichment] Initialized queue with db_upsert_func")
    except Exception as e:
        print(f"[Agentic Enrichment] Failed to initialize queue: {e}")


# --- Nylas OAuth Endpoints ---

class NylasAuthUrlResponse(schemas.BaseModel):
    auth_url: Optional[str]
    error: Optional[str] = None

class NylasCallbackRequest(schemas.BaseModel):
    code: str
    state: str  # user_id

class NylasGrantResponse(schemas.BaseModel):
    id: str
    grant_id: str
    email_address: str
    provider: Optional[str]
    created_at: Optional[str]


@app.get("/api/nylas/auth-url")
async def get_nylas_auth_url(
    user_id: str = Query(..., description="User ID to associate with the grant"),
    redirect_uri: str = Query(..., description="OAuth callback URI")
) -> NylasAuthUrlResponse:
    """Generate OAuth URL for email connection"""
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        return NylasAuthUrlResponse(auth_url=None, error="Agentic enrichment not available")
    
    try:
        service = get_nylas_service()
        if not service.is_available():
            return NylasAuthUrlResponse(auth_url=None, error="Nylas service not configured")
        
        auth_url = service.get_auth_url(redirect_uri, user_id)
        if auth_url:
            return NylasAuthUrlResponse(auth_url=auth_url)
        else:
            return NylasAuthUrlResponse(auth_url=None, error="Failed to generate auth URL")
    except Exception as e:
        print(f"[Nylas] Error generating auth URL: {e}")
        return NylasAuthUrlResponse(auth_url=None, error=str(e))


@app.post("/api/nylas/callback")
async def handle_nylas_callback(request: NylasCallbackRequest) -> Dict[str, Any]:
    """Handle OAuth callback, store grant in nylas_grants table"""
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        raise HTTPException(status_code=503, detail="Agentic enrichment not available")
    
    try:
        service = get_nylas_service()
        if not service.is_available():
            raise HTTPException(status_code=503, detail="Nylas service not configured")
        
        # Note: In production, redirect_uri should be stored/retrieved securely
        # For now, we use an environment variable
        redirect_uri = os.environ.get("NYLAS_REDIRECT_URI", "")
        
        token_response = service.exchange_code_for_token(request.code, redirect_uri)
        
        if not token_response:
            raise HTTPException(status_code=400, detail="Failed to exchange code for token")
        
        # Return grant info - storage should be handled by the calling Express backend
        return {
            "success": True,
            "user_id": request.state,
            "grant_id": token_response.get("grant_id"),
            "email": token_response.get("email"),
            "provider": token_response.get("provider")
        }
        
    except HTTPException:
        raise
    except Exception as e:
        print(f"[Nylas] Callback error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/nylas/grants/{user_id}")
async def get_user_nylas_grants(user_id: str) -> Dict[str, Any]:
    """
    List user's connected email grants.
    Note: Grant storage/retrieval is managed by the Express backend.
    This endpoint checks if Nylas service is available and returns status info.
    """
    print(f"[Nylas] Checking grants for user: {user_id}")
    
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        print("[Nylas] AGENTIC_ENRICHMENT_AVAILABLE is False")
        return {
            "nylas_available": False,
            "has_grants": False,
            "message": "Agentic enrichment not available",
            "debug_info": "AGENTIC_ENRICHMENT_AVAILABLE=False"
        }
    
    service = get_nylas_service()
    is_available = service.is_available()
    
    print(f"[Nylas] Service available: {is_available}")
    
    return {
        "nylas_available": is_available,
        "has_grants": False,  # Express backend will override this with actual DB lookup
        "message": "Grant management handled by Express backend"
    }


@app.get("/api/nylas/list-all-grants")
async def list_all_nylas_grants() -> Dict[str, Any]:
    """
    List ALL grants from Nylas API (admin endpoint for debugging/syncing).
    This shows grants that exist in Nylas but may not be in our database.
    """
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        return {
            "success": False,
            "error": "Agentic enrichment not available",
            "grants": []
        }
    
    service = get_nylas_service()
    if not service.is_available():
        return {
            "success": False,
            "error": "Nylas service not configured",
            "grants": []
        }
    
    try:
        grants = service.list_grants()
        return {
            "success": True,
            "grants": grants,
            "count": len(grants)
        }
    except Exception as e:
        print(f"[Nylas] Error listing all grants: {e}")
        return {
            "success": False,
            "error": str(e),
            "grants": []
        }


# --- Agentic Enrichment Endpoints ---

class AgenticEnrichmentRequest(schemas.BaseModel):
    """Request for agentic transaction enrichment"""
    transaction_ids: List[str]
    transactions: Optional[List[Dict[str, Any]]] = None  # Full transaction data
    user_id: str
    nylas_grant_id: Optional[str] = None

class AgenticEnrichmentJobResponse(schemas.BaseModel):
    job_id: str
    status: str
    message: Optional[str] = None


@app.post("/api/enrich")
async def trigger_agentic_enrichment(
    request: AgenticEnrichmentRequest,
    background_tasks: BackgroundTasks
) -> AgenticEnrichmentJobResponse:
    """
    Trigger background agentic enrichment for transactions.
    
    This runs the full AI-powered enrichment pipeline:
    1. Subscription matching (DB + Serper + Claude)
    2. Email receipt search (if Nylas grant exists)
    3. Event correlation (placeholder)
    4. Merge results with confidence scoring
    """
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        raise HTTPException(status_code=503, detail="Agentic enrichment not available")
    
    print(f"[Agentic Enrichment] Received request to enrich {len(request.transaction_ids)} transactions")
    
    try:
        job_id = create_enrichment_job(request.transaction_ids)
        
        # Build transaction list with nylas_grant_id included
        transactions_to_enrich = request.transactions or [
            {"transaction_id": tid, "user_id": request.user_id, "nylas_grant_id": request.nylas_grant_id}
            for tid in request.transaction_ids
        ]
        
        # Add nylas_grant_id to each transaction if provided
        if request.nylas_grant_id:
            for tx in transactions_to_enrich:
                if "nylas_grant_id" not in tx:
                    tx["nylas_grant_id"] = request.nylas_grant_id
        
        # Run enrichment in background
        background_tasks.add_task(
            run_enrichment_pipeline,
            job_id,
            transactions_to_enrich
        )
        
        return AgenticEnrichmentJobResponse(
            job_id=job_id,
            status="pending",
            message=f"Enrichment job created for {len(request.transaction_ids)} transactions"
        )
        
    except Exception as e:
        print(f"[Agentic Enrichment] Error creating job: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/enrich/{job_id}")
async def get_agentic_enrichment_status(job_id: str) -> Dict[str, Any]:
    """Get status of enrichment job"""
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        raise HTTPException(status_code=503, detail="Agentic enrichment not available")
    
    job = get_enrichment_job(job_id)
    
    if not job:
        raise HTTPException(status_code=404, detail=f"Job {job_id} not found")
    
    return {
        "job_id": job_id,
        "status": job.get("status", "unknown"),
        "completed": job.get("completed", 0),
        "total": job.get("total", 0),
        "results": job.get("results", []),
        "created_at": job.get("created_at"),
        "started_at": job.get("started_at"),
        "completed_at": job.get("completed_at")
    }


# --- Single Transaction Enrichment (Sync) ---

class SingleEnrichmentRequest(schemas.BaseModel):
    """Request for single transaction enrichment"""
    transaction_id: str
    merchant_name: Optional[str] = None
    amount_cents: int = 0
    currency: str = "GBP"
    transaction_date: Optional[str] = None
    description: Optional[str] = None
    user_id: Optional[str] = None
    nylas_grant_id: Optional[str] = None
    location_lat: Optional[float] = None
    location_long: Optional[float] = None


@app.post("/api/enrich/single")
async def enrich_single_transaction(request: SingleEnrichmentRequest) -> Dict[str, Any]:
    """
    Enrich a single transaction synchronously.
    Use this for immediate enrichment of individual transactions.
    """
    if not AGENTIC_ENRICHMENT_AVAILABLE:
        raise HTTPException(status_code=503, detail="Agentic enrichment not available")
    
    try:
        result = await enrich_transaction(
            transaction_id=request.transaction_id,
            merchant_name=request.merchant_name,
            amount_cents=request.amount_cents,
            currency=request.currency,
            transaction_date=request.transaction_date,
            description=request.description,
            user_id=request.user_id,
            nylas_grant_id=request.nylas_grant_id,
            location_lat=request.location_lat,
            location_long=request.location_long
        )
        
        return {
            "transaction_id": result.transaction_id,
            "is_subscription": result.is_subscription,
            "subscription_product_name": result.subscription_product_name,
            "subscription_category": result.subscription_category,
            "email_receipt_found": result.email_receipt_found,
            "email_receipt_data": result.email_receipt_data,
            "events_nearby": result.events_nearby,
            "context_data": result.context_data,
            "reasoning_trace": result.reasoning_trace,
            "ai_confidence": result.ai_confidence,
            "needs_review": result.needs_review,
            "error": result.error
        }
        
    except Exception as e:
        print(f"[Agentic Enrichment] Single enrichment error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
