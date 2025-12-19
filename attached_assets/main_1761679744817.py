# main.py (Production Ready - v1.3)

import sys
from fastapi import FastAPI, HTTPException
from typing import Optional, List 

# Import our Pydantic schemas
import schemas

# Import the solver function AND the necessary dataclasses
# (We need the dataclasses to pass the correct type to the solver)
try:
    # Assuming solver_engine.py is in the same directory
    from solver_engine import (
        generate_payment_plan,
        DebtPortfolio as SolverDebtPortfolio, # Rename to avoid clash
        Account as SolverAccount,
        MinPaymentRule as SolverMinPaymentRule,
        Budget as SolverBudget,
        UserPreferences as SolverUserPreferences, # <-- This is the alias
        AccountType,
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
    title="Paydown Pilot API",
    description="API for generating optimized debt repayment plans.",
    version="0.1.0",
)

# --- Helper Function for Data Conversion ---
def convert_schema_to_solver_portfolio(
    portfolio_schema: schemas.DebtPortfolio
) -> SolverDebtPortfolio:
    """Converts Pydantic schema input to solver's dataclass input."""
    solver_accounts = []
    for acc_schema in portfolio_schema.accounts:
        # Convert the nested Pydantic MinPaymentRule to the solver's dataclass
        solver_rule = SolverMinPaymentRule(**acc_schema.min_payment_rule.model_dump())
        
        # Exclude the rule from the main account data to avoid TypeError
        acc_data = acc_schema.model_dump(exclude={'min_payment_rule'})
        
        # Create the solver's Account dataclass
        solver_accounts.append(SolverAccount(min_payment_rule=solver_rule, **acc_data))

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
