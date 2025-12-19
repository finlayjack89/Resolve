# schemas.py

import sys
from datetime import date
from enum import Enum
from typing import List, Optional, Tuple

# Ensure we are using Python 3.10+
assert sys.version_info >= (3, 10), "Python 3.10 or higher is required."

# Import Pydantic BaseModel and validation tools
from pydantic import BaseModel, Field, field_validator, model_validator

# --- Enums (Copied/Imported for clarity) ---
# In a real project, ensure these are imported correctly from your solver module
class AccountType(str, Enum):
    CREDIT_CARD = "Credit Card"
    BNPL = "Buy Now, Pay Later"
    LOAN = "Loan"

class OptimizationStrategy(str, Enum):
    MINIMIZE_TOTAL_INTEREST = "Minimize Total Interest"
    MINIMIZE_MONTHLY_SPEND = "Minimize Monthly Spend"
    TARGET_MAX_BUDGET = "Pay Off ASAP with Max Budget"
    PAY_OFF_IN_PROMO = "Pay Off Within Promo Windows"
    MINIMIZE_SPEND_TO_CLEAR_PROMOS = "Minimize Spend to Clear Promos"

class PaymentShape(str, Enum):
    LINEAR_PER_ACCOUNT = "Linear (Same Amount Per Account)"
    OPTIMIZED_MONTH_TO_MONTH = "Optimized (Variable Amounts)"

# --- Pydantic Models ---

class MinPaymentRule(BaseModel):
    """Pydantic model for minimum payment rules."""
    fixed_cents: int = Field(default=0, ge=0)
    percentage_bps: int = Field(default=0, ge=0)
    includes_interest: bool = False

class Account(BaseModel):
    """Pydantic model representing a single credit account."""
    lender_name: str = Field(..., min_length=1)
    account_type: AccountType
    current_balance_cents: int = Field(..., ge=0)
    apr_standard_bps: int = Field(..., ge=0)
    payment_due_day: int = Field(..., ge=1, le=28)
    min_payment_rule: MinPaymentRule

    promo_end_date: Optional[date] = None
    promo_duration_months: Optional[int] = Field(default=None, ge=1)

    account_open_date: Optional[date] = None
    notes: Optional[str] = None

    @model_validator(mode='after')
    def check_promo_mutual_exclusion(self) -> 'Account':
        """Ensure only one promo field is set."""
        if self.promo_end_date is not None and self.promo_duration_months is not None:
            raise ValueError("Provide either 'promo_end_date' or 'promo_duration_months', not both.")
        return self

class Budget(BaseModel):
    """Pydantic model representing the user's budget."""
    # Note: For MINIMIZE_SPEND_TO_CLEAR_PROMOS, this might be optional or ignored.
    # We can handle that logic in the API endpoint. For now, keep it required.
    monthly_budget_cents: int = Field(..., ge=0)

    future_changes: List[Tuple[date, int]] = Field(default_factory=list)
    lump_sum_payments: List[Tuple[date, int]] = Field(default_factory=list)

    @field_validator('future_changes', 'lump_sum_payments', mode='before')
    @classmethod
    def check_amounts_non_negative(cls, v: List[Tuple[date, int]]):
        """Validate that amounts in budget change/lump sum tuples are non-negative."""
        if v: # Check only if the list is not empty
            for item in v:
                # Ensure item is a tuple/list of expected length before indexing
                if not isinstance(item, (tuple, list)) or len(item) != 2:
                     raise ValueError("Budget changes/lump sums must be tuples of (date, amount).")
                dt, amount = item
                if not isinstance(amount, int) or amount < 0:
                    raise ValueError("Budget change and lump sum amounts cannot be negative.")
        return v

class UserPreferences(BaseModel):
    """Pydantic model capturing user's optimization choices."""
    strategy: OptimizationStrategy
    payment_shape: PaymentShape

# schemas.py (continued)

class DebtPortfolio(BaseModel):
    """Pydantic model for the entire input portfolio to the API."""
    accounts: List[Account] = Field(..., min_length=1) # Require at least one account
    budget: Budget
    preferences: UserPreferences
    plan_start_date: date = Field(default_factory=date.today) # Default to today if not provided

class MonthlyResult(BaseModel):
    """Pydantic model for a single month's RAW result from the solver."""
    month: int = Field(..., ge=1)
    lender_name: str
    payment_cents: int = Field(..., ge=0)
    interest_charged_cents: int = Field(..., ge=0)
    ending_balance_cents: int # Can be negative if overpaid

# --- API Response Model ---

class OptimizationPlanResponse(BaseModel):
    """
    Pydantic model for the standard API response after running the optimizer.
    Initially, the 'plan' will contain the raw MonthlyResult list.
    Later, we'll adapt this or add a field for the structured dashboard data.
    """
    status: str # e.g., "OPTIMAL", "FEASIBLE", "INFEASIBLE", "ERROR"
    message: Optional[str] = None
    plan: Optional[List[MonthlyResult]] = None # The raw plan from the solver
    # Future: Add summary fields (total_interest, payoff_month)
    # Future: Add structured dashboard_data field
