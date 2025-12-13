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
