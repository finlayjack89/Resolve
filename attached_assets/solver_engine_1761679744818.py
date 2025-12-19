import sys
from dataclasses import dataclass, field
from datetime import date
from enum import Enum
from typing import List, Optional, Dict, Tuple

# Ensure we are using Python 3.10+
assert sys.version_info >= (3, 10), "Python 3.10 or higher is required."
# Import the CP-SAT model builder from Google OR-Tools
from ortools.sat.python import cp_model

# Import the relativedelta object for date calculations
from dateutil.relativedelta import relativedelta

# --- Enums for User Choices based on the product document ---

class AccountType(str, Enum):
    """
    Defines the type of credit account.
    """
    CREDIT_CARD = "Credit Card"
    BNPL = "Buy Now, Pay Later"
    LOAN = "Loan"

class OptimizationStrategy(str, Enum):
    """
    Defines the user's primary goal for the repayment plan.
    """
    MINIMIZE_TOTAL_INTEREST = "Minimize Total Interest"
    MINIMIZE_MONTHLY_SPEND = "Minimize Monthly Spend"
    TARGET_MAX_BUDGET = "Pay Off ASAP with Max Budget"
    PAY_OFF_IN_PROMO = "Pay Off Within Promo Windows"
    MINIMIZE_SPEND_TO_CLEAR_PROMOS = "Minimize Spend to Clear Promos" # <-- ADDED

class PaymentShape(str, Enum):
    """
    Defines the desired shape or consistency of payments.
    """
    LINEAR_PER_ACCOUNT = "Linear (Same Amount Per Account)"
    OPTIMIZED_MONTH_TO_MONTH = "Optimized (Variable Amounts)"


# --- Core Data Structures ---

@dataclass
class MinPaymentRule:
    """A structured definition for a complex minimum payment rule."""
    fixed_cents: int = 0    
     # The fixed amount (e.g., 500 for £5.00)
    percentage_bps: int = 0      # The percentage in basis points (e.g., 250 for 2.5%)
    includes_interest: bool = False # Flag for the UK-specific rule

@dataclass
class Account:
    """
    Represents a single credit account, such as a credit card, BNPL, or loan.
All monetary values are stored in integer cents.
    """
    # --- Fields without default values ---
    lender_name: str
    account_type: AccountType
    current_balance_cents: int
    apr_standard_bps: int
    payment_due_day: int
    
    # NEW: Replaces the old simple minimum_payment_cents
    min_payment_rule: MinPaymentRule 
    
    # --- Fields with default values ---
    promo_end_date: Optional[date] = None
    promo_duration_months: Optional[int] = None
    account_open_date: date = field(default_factory=date.today)
  
    notes: Optional[str] = None
    
    def __post_init__(self):
        """Validate that exactly one promotional field is provided."""
        if self.promo_end_date is not None and self.promo_duration_months is not None:
            raise ValueError("Provide either 'promo_end_date' or 'promo_duration_months', not both.")
        if self.current_balance_cents < 0:
            raise ValueError("'current_balance_cents' must not be negative.")
       
        if not (1 <= self.payment_due_day <= 28):
            raise ValueError("'payment_due_day' must be between 1 and 28 for simplicity.")
@dataclass
class Budget:
    """
    Represents the user's total monthly budget for debt repayment.
This includes one-time payments and planned future budget changes.
    """
    # The user's default monthly budget in cents.
    monthly_budget_cents: int
    
    # A list of planned future changes to the recurring monthly budget.
    # The list should be sorted by date.
    future_changes: List[tuple[date, int]] = field(default_factory=list)

    # A list of one-time, lump-sum payments to be added to the budget.
    # The tuple contains the date of the payment and the amount in cents.
    
    lump_sum_payments: List[tuple[date, int]] = field(default_factory=list)


@dataclass
class UserPreferences:
    """
    Captures the user's choices for the optimization process.
    """
    strategy: OptimizationStrategy
    payment_shape: PaymentShape


@dataclass
class DebtPortfolio:
    """
    A container for the entire problem definition, including all accounts,
    the user's budget, and their chosen preferences.
    """
    accounts: List[Account]
    budget: Budget
    preferences: UserPreferences
    
    # The starting date for the optimization plan.
    plan_start_date: date = field(default_factory=date.today)

@dataclass
class MonthlyResult:
    """
    Stores the calculated results for a single account in a single month.
    """
    month: int
    lender_name: str
    payment_cents: int
    interest_charged_cents: int
    ending_balance_cents: int


# --- Solver Function ---

def generate_payment_plan(portfolio: DebtPortfolio) -> Optional[List[MonthlyResult]]:
    """
    Creates, solves, and returns a debt repayment optimization plan.
    Args:
        portfolio: A DebtPortfolio object containing all accounts, budget,
                   and user preferences.
    Returns:
        A list of MonthlyResult objects representing the plan, or None if no
        solution is found.
    """
    # 1. Create the main model object.
    model = cp_model.CpModel()
    print("Model canvas created. Ready to define variables.")

    # 2. Define the time horizon for the plan.
    max_months: int = 120 # 10 years
    
    # 3. Create dictionaries to hold our decision variables.
    payments: Dict[Tuple[str, int], cp_model.IntVar] = {}
    balances: Dict[Tuple[str, int], cp_model.IntVar] = {}
    interest_charged: Dict[Tuple[str, int], cp_model.IntVar] = {}
    is_active: Dict[Tuple[str, int], cp_model.IntVar] = {} # Boolean: is there a balance?

    max_possible_cents = sum(acc.current_balance_cents for acc in portfolio.accounts)
    if max_possible_cents == 0:
        print("All accounts have a zero balance. Nothing to plan.")
        return []
    
    # Add a buffer for interest calculations. This domain is larger than the
    # original sum to safely accommodate accrued interest over time.
    max_possible_balance = int(max_possible_cents * 3) 
    
    print(f"Base domain max cents: {max_possible_balance}")
    
    # --- 4. Pre-calculate TIGHTER domains to improve model stability ---
    
    # Find the highest possible APR and Min Pay BPS in the portfolio
    max_apr_bps = max((acc.apr_standard_bps for acc in portfolio.accounts), default=0)
    max_min_pay_bps = max((acc.min_payment_rule.percentage_bps for acc in portfolio.accounts), default=0)
    max_min_pay_fixed = max((acc.min_payment_rule.fixed_cents for acc in portfolio.accounts), default=0)

    # 1. TIGHTEN: Max possible interest in one month
    # (Max Balance * Max APR) / 120,000
    domain_max_interest = (max_possible_balance * max_apr_bps) // 120000 + 1
    print(f"TIGHTENED Domain: Max monthly interest = {domain_max_interest}")

    # 2. TIGHTEN: Max base for min pay percentage
    # (Max Balance + Max Interest)
    domain_max_min_pay_base = max_possible_balance + domain_max_interest

    # 3. TIGHTEN: Max percentage component of a minimum payment
    # (Max Base * Max Min Pay BPS) / 10,000
    domain_max_percentage_comp = (domain_max_min_pay_base * max_min_pay_bps) // 10000 + 1
    print(f"TIGHTENED Domain: Max min-pay percentage comp = {domain_max_percentage_comp}")

    # 4. TIGHTEN: Max "raw" minimum payment
    # max(Max Fixed, Max Percentage)
    domain_max_raw_min_pay = max(max_min_pay_fixed, domain_max_percentage_comp)
    print(f"TIGHTENED Domain: Max 'raw' min pay = {domain_max_raw_min_pay}")

    # 5. TIGHTEN: Max total owed in a month
    # This is the same as the min pay base
    domain_max_total_owed = domain_max_min_pay_base
    print(f"TIGHTENED Domain: Max total owed = {domain_max_total_owed}")
    
    # 6. TIGHTEN: Max for the numerator variables (still big, but derived)
    # This is the largest value our numerators will *ever* need to hold
    interest_numerator_domain_max = max_possible_balance * (max_apr_bps or 1)
    min_pay_numerator_domain_max = domain_max_min_pay_base * (max_min_pay_bps or 1)
    
    # Find the absolute largest numerator domain we'll need
    max_numerator_domain = max(interest_numerator_domain_max, min_pay_numerator_domain_max)
    print(f"TIGHTENED Domain: Max numerator = {max_numerator_domain}")
    
    # 4. Create variables for each account for each month in the time horizon.
    for account in portfolio.accounts:
        for month in range(max_months):
            key = (account.lender_name, month)
            payments[key] = model.NewIntVar(0, max_possible_balance, f'payment_{key}')
            balances[key] = model.NewIntVar(0, max_possible_balance, f'balance_{key}')
            interest_charged[key] = model.NewIntVar(0, domain_max_interest, f'interest_{key}')
            is_active[key] = model.NewBoolVar(f'is_active_{key}')
         
   
    total_vars = len(payments) + len(balances) + len(interest_charged) + len(is_active)
    print(f"Created {total_vars} variables across {max_months} months.")
    
    # --- Pre-calculate promo end month index for all accounts ---
    print("...calculating promotional period end dates...")
    promo_end_month_map: Dict[str, int] = {}
    for account in portfolio.accounts:
        promo_month_index = -1 # Default: no promo
        
        if account.promo_end_date:
            # Calculate month difference
            delta = relativedelta(account.promo_end_date, portfolio.plan_start_date)
            promo_month_index = delta.years * 12 + delta.months
        
        elif account.promo_duration_months is not None:
            # Use duration directly (0-indexed)
            promo_month_index = account.promo_duration_months - 1
            
        promo_end_month_map[account.lender_name] = promo_month_index
    
    print("\n--- Adding Constraints ---")

    # --- 5. Define Model Constraints ---

    # 5.1. Dynamic Budget Constraint
    print("...Pre-calculations complete...")
    print("1. Adding dynamic monthly budget constraints...")
    
    if portfolio.preferences.strategy != OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS:
        lump_sum_map: Dict[int, int] = {}
        for payment_date, amount_cents in portfolio.budget.lump_sum_payments:
            month_diff = (payment_date.year - portfolio.plan_start_date.year) * 12 + \
                         (payment_date.month - portfolio.plan_start_date.month)
            if month_diff >= 0:
                lump_sum_map[month_diff] = lump_sum_map.get(month_diff, 0) + amount_cents
    
        for month in range(max_months):
            current_month_date = portfolio.plan_start_date + relativedelta(months=month)
            budget_for_this_month = portfolio.budget.monthly_budget_cents
            for change_date, new_amount_cents in sorted(portfolio.budget.future_changes):
                if change_date <= current_month_date:
                    budget_for_this_month = new_amount_cents
            budget_for_this_month += lump_sum_map.get(month, 0)
            
            monthly_payments = [payments[(acc.lender_name, month)] for acc in portfolio.accounts]
            model.Add(sum(monthly_payments) <= budget_for_this_month)
    else:
        print("   - SKIPPING budget constraint for 'Minimize Spend to Clear Promos' strategy.")

    # 5.2. Balance Update, Minimum Payments, and Interest Logic
    print("2. Adding core balance update, interest, and minimum payment logic...")
    for account in portfolio.accounts:
        for month in range(max_months):
            key = (account.lender_name, month)
            
            # Create a single, clean IntVar for previous_balance.
            # This resolves the int/IntVar type ambiguity in all subsequent expressions.
            previous_balance_var = model.NewIntVar(0, max_possible_balance, f'prev_bal_{key}')
            if month == 0:
                model.Add(previous_balance_var == account.current_balance_cents)
            else:
                model.Add(previous_balance_var == balances[(account.lender_name, month - 1)])

            # 5.2.a. 'is_active' constraint: Account is active if balance > 0
            # All logic below now uses 'previous_balance_var'
            model.Add(previous_balance_var > 0).OnlyEnforceIf(is_active[key])
            model.Add(previous_balance_var <= 0).OnlyEnforceIf(is_active[key].Not())
            
            # 5.2.b. Interest Calculation (with Promotional APR logic)
            promo_end_idx = promo_end_month_map[account.lender_name]

            if month <= promo_end_idx:
                # --- PROMO PERIOD: Interest is 0 ---
                model.Add(interest_charged[key] == 0)
            
            else:
                # --- STANDARD PERIOD: Calculate interest ---
                apr_bps_for_month = account.apr_standard_bps
            
                # Use the pre-calculated, absolute max domain for numerators
                numerator_var = model.NewIntVar(0, max_numerator_domain, f'num_{key}')
                
                # (IntVar == IntVar * constant)
                model.Add(numerator_var == previous_balance_var * apr_bps_for_month)
                
                # This division runs unconditionally.
                model.AddDivisionEquality(interest_charged[key], numerator_var, 120000)

            # This constraint handles the case where the account is inactive.
            # It is now OUTSIDE the if/else block, as it applies to both cases.
            model.Add(interest_charged[key] == 0).OnlyEnforceIf(is_active[key].Not())

            # 5.2.c. Complex Minimum Payment Logic (NEW)
            
            # 1. Define the 'max' components
            fixed_component = account.min_payment_rule.fixed_cents
            percentage_component_var = model.NewIntVar(0, domain_max_percentage_comp, f'min_pay_perc_var_{key}')
            
            # 2. Define the base for the percentage calculation
     
            base_for_percentage = model.NewIntVar(0, domain_max_min_pay_base, f'base_for_perc_{key}') 
            
            # This constraint is now clean: (IntVar == IntVar + IntVar) or (IntVar == IntVar)
            if account.min_payment_rule.includes_interest:
                model.Add(base_for_percentage == previous_balance_var + interest_charged[key])
 
            else:
                model.Add(base_for_percentage == previous_balance_var)

            # 3. Calculate the percentage component: (base * bps / 10000)
            if account.min_payment_rule.percentage_bps > 0:
              
                perc_numerator_var = model.NewIntVar(0, max_numerator_domain, f'perc_num_{key}')
                
                # This constraint is also clean: (IntVar == IntVar * constant)
                model.Add(perc_numerator_var == base_for_percentage * account.min_payment_rule.percentage_bps)
                
                
                # This division does not need enforcement; it runs unconditionally.
                model.AddDivisionEquality(
                    percentage_component_var,
                    perc_numerator_var,
                    10000
                )
            else:
            
                model.Add(percentage_component_var == 0)
            
            # 4. Calculate the 'raw' minimum: max(fixed, percentage)
            raw_minimum_payment_var = model.NewIntVar(0, domain_max_raw_min_pay, f'raw_min_pay_{key}')
            model.AddMaxEquality(
                raw_minimum_payment_var,
                [fixed_component, percentage_component_var]
  
            )

            # 5. Calculate the total amount owed
            total_owed_var = model.NewIntVar(0, domain_max_total_owed, f'total_owed_{key}')
            model.Add(total_owed_var == previous_balance_var + interest_charged[key])

            # 6. The *actual* minimum payment is the LESSER of the raw 
            # minimum or the total owed.
            final_minimum_payment_var = model.NewIntVar(0, domain_max_total_owed, f'final_min_pay_{key}')
            model.AddMinEquality(
                final_minimum_payment_var,
                [raw_minimum_payment_var, total_owed_var]
            )
            
            # 7. Enforce the final minimum payment and non-activity
  
            model.Add(payments[key] >= final_minimum_payment_var).OnlyEnforceIf(is_active[key])
            model.Add(payments[key] == 0).OnlyEnforceIf(is_active[key].Not())
            
            # 5.2.d. Balance Update (REMAINS AT END)
            # This constraint is also clean: (IntVar == IntVar + IntVar - IntVar)
            model.Add(balances[key] == previous_balance_var + interest_charged[key] - payments[key])

    # 5.3. Payoff Constraint
    print("3. Adding final payoff constraint...")
    for account in portfolio.accounts:
        final_month_key = (account.lender_name, max_months - 1)
        model.Add(balances[final_month_key] <= 0)

    # 5.4. Strategy-Specific Constraints
    if portfolio.preferences.strategy == OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS:
        print("4. Adding 'Minimize Spend to Clear Promos' hard constraints...")
        
        non_promo_accounts: List[str] = []
        has_promo_accounts = False
        for account in portfolio.accounts:
            promo_end_idx = promo_end_month_map[account.lender_name]
            
            if promo_end_idx > -1:
                # This is a promo account. Add the hard constraint.
                has_promo_accounts = True
                promo_end_key = (account.lender_name, promo_end_idx)
                print(f"   - Constraint added: {account.lender_name} balance <= 0 by month {promo_end_idx + 1}")
                model.Add(balances[promo_end_key] <= 0)
            else:
                # This account has no promo period.
                non_promo_accounts.append(account.lender_name)
        
        # Validation: This strategy is only valid if ALL accounts have promos.
        if non_promo_accounts:
            raise ValueError(
                f"The '{OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS.value}' strategy is only valid "
                f"when ALL accounts have a promotional period. The following accounts do not: {non_promo_accounts}"
            )
        
        if not has_promo_accounts:
            raise ValueError(
                f"The '{OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS.value}' strategy requires "
                f"at least one account with a promotional period."
            )

    # 5.5. Payment Shape Constraints
    # We check for the user's choice OR our new strategy, which forces this shape.
    if portfolio.preferences.payment_shape == PaymentShape.LINEAR_PER_ACCOUNT or \
       portfolio.preferences.strategy == OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS:
        
        if portfolio.preferences.strategy == OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS:
            print("5. (Forcing) 'Linear Per-Account' payment shape for this strategy.")
        else:
            print("5. Adding 'Linear Per-Account' payment shape constraints...")
        
        for account in portfolio.accounts:
            for month in range(max_months - 1): # Stop one month early to look ahead
                key = (account.lender_name, month)
                next_key = (account.lender_name, month + 1)
                
                # Enforce that payment[m] == payment[m+1] as long as
                # the account is still active in month m+1.
                model.Add(payments[key] == payments[next_key]).OnlyEnforceIf(is_active[next_key])

    print("All constraints have been added to the model.")
    print("\n--- Defining Objective ---")

    # --- 6. Define the Optimization Objective ---
    
    strategy = portfolio.preferences.strategy
    
    # This is the base objective component for all strategies (except MINIMIZE_MONTHLY_SPEND).
    all_interest_variables: List[cp_model.IntVar] = list(interest_charged.values())
    total_interest_cost = sum(all_interest_variables)

    if strategy == OptimizationStrategy.MINIMIZE_TOTAL_INTEREST or \
       strategy == OptimizationStrategy.TARGET_MAX_BUDGET:
        
        # For these strategies, the goal is simple: minimize total interest.
        model.Minimize(total_interest_cost)
        print(f"Objective set to: {strategy.value}")
    
    elif strategy == OptimizationStrategy.PAY_OFF_IN_PROMO:
        # NEW LOGIC: This is a "soft constraint".
        # We minimize interest PLUS a penalty for any balance
        # left at the end of a promo period.
        print(f"Objective set to: {strategy.value}")
        print("   - Adding promo balance penalties to objective...")

        promo_penalties: List[cp_model.IntVar] = []
        
        for account in portfolio.accounts:
            promo_end_idx = promo_end_month_map[account.lender_name]
            
            if promo_end_idx > -1:
                # This account has a promo.
                # Get the balance variable for the month the promo ends.
                promo_end_key = (account.lender_name, promo_end_idx)
                
                # The 'penalty' is simply the balance left over.
                # Since the balance variable (balances[promo_end_key]) is
                # already constrained to be >= 0, it perfectly
                # represents the penalty.
                promo_penalties.append(balances[promo_end_key])
                print(f"   - Penalizing balance of '{account.lender_name}' at end of month {promo_end_idx + 1}")

        if promo_penalties:
            # The total cost is the sum of all interest PLUS all penalties.
            # The solver will try to make 'total_penalty' zero if possible,
            # but will not fail if it can't.
            total_penalty = sum(promo_penalties)
            model.Minimize(total_interest_cost + total_penalty)
        else:
            # No accounts had promos, so we fall back to the default.
            print("   - No promo accounts found. Defaulting to Minimize Total Interest.")
            model.Minimize(total_interest_cost)

    elif strategy == OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS:
        # This strategy minimizes the PEAK monthly payment required to clear
        # all promo balances exactly by their end dates, using linear payments.
        print(f"Objective set to: {strategy.value} (Minimize Peak Monthly Payment)")
        
        # 1. Determine the maximum relevant month index (longest promo period)
        max_promo_end_idx = -1
        if promo_end_month_map:
            max_promo_end_idx = max(promo_end_month_map.values())
        
        if max_promo_end_idx == -1:
             # Should have been caught by validation in 5.4, but handle defensively
             raise ValueError("MINIMIZE_SPEND_TO_CLEAR_PROMOS requires at least one promo account.")
            
        # 2. Create the objective variable (the peak monthly payment)
        # Domain: 0 to the total initial balance (absolute max possible payment in one month)
        max_total_monthly_payment = model.NewIntVar(0, max_possible_cents, 'max_total_monthly_payment')
        
        # 3. Add constraints linking monthly totals to the objective variable
        print(f"   - Adding peak payment constraints up to month {max_promo_end_idx + 1}...")
        for month in range(max_promo_end_idx + 1):
            monthly_total = model.NewIntVar(0, max_possible_cents, f'monthly_total_{month}')
            payments_this_month = [payments[(acc.lender_name, month)] for acc in portfolio.accounts]
            model.Add(monthly_total == sum(payments_this_month))
            # Constraint: The total payment this month must be <= our objective variable
            model.Add(monthly_total <= max_total_monthly_payment)
            
        # 4. Set the objective: Minimize the peak payment variable
        model.Minimize(max_total_monthly_payment)

    elif strategy == OptimizationStrategy.MINIMIZE_MONTHLY_SPEND:
        # This strategy finds the "laziest" plan. It minimizes the total
        # sum of all payments, while still obeying the 5.3 Payoff Constraint.
        # This results in a plan that only pays the bare minimums.
        all_payment_variables: List[cp_model.IntVar] = list(payments.values())
        model.Minimize(sum(all_payment_variables))
        print(f"Objective set to: {strategy.value}")
    
    else:
        # Fallback in case a strategy is not implemented
        raise NotImplementedError(f"Strategy '{strategy.value}' is not yet implemented in the solver.")

    # --- 7. Solve the Model and Process Results ---
    print("\n--- Solving the Model ---")
    
    # Add model validation for better error logging
    try:
        validation_error = model.Validate()
        if validation_error:
            print(f"!!! Model Validation Error: {validation_error}", file=sys.stderr)
            # You could optionally print the full model proto for deep debugging:
            # 
            print(model.Proto(), file=sys.stderr)
    except Exception as e:
        print(f"!!! An exception occurred during model.Validate(): {e}", file=sys.stderr)
        
    solver = cp_model.CpSolver()
    solver.parameters.max_time_in_seconds = 60.0
    status = solver.Solve(model)
    
    if status == cp_model.OPTIMAL or status == cp_model.FEASIBLE:
        print(f"\n✅ Solution Found! Status: {solver.StatusName(status)}")
        
        # a. Create an empty list for results.
        results_list: List[MonthlyResult] = []
       
 
        # b/c. Populate the results list from the solver's solution.
        for month in range(max_months):
            # Optimization: if all balances are zero, we can stop.
            total_balance_at_month_start = 0
            for account in portfolio.accounts:
                if month == 0:
  
                  total_balance_at_month_start += account.current_balance_cents
                else:
                     total_balance_at_month_start += solver.Value(balances[(account.lender_name, month - 1)])
            
            if total_balance_at_month_start <= 0:
           
                print(f"All balances at zero or below. Stopping at month {month + 1}.")
                break

            for account in portfolio.accounts:
                key = (account.lender_name, month)
                result = MonthlyResult(
                    month=month + 1,
     
                    lender_name=account.lender_name,
                    payment_cents=int(solver.Value(payments[key])),
                    interest_charged_cents=int(solver.Value(interest_charged[key])),
                    ending_balance_cents=int(solver.Value(balances[key])),
                )
         
       
                # Only append if there's activity. This cleans up the final log.
                is_active_last_month = (month > 0 and solver.Value(balances[(account.lender_name, month - 1)]) > 0)
                if result.payment_cents > 0 or result.ending_balance_cents > 0 or result.interest_charged_cents > 0 or is_active_last_month:
          
                    results_list.append(result)
        
        # d. Process the results_list to print summaries.
        print("\n--- Plan Summary ---")
        
        # i. Total interest for the entire plan..
        total_interest = sum(r.interest_charged_cents for r in results_list)
        print(f"Minimized Total Interest Paid: ${total_interest / 100.0:,.2f}")
        
        # ii. Total interest per account.
        print("\nInterest Breakdown by Account:")
        interest_by_account: Dict[str, int] = {acc.lender_name: 0 for acc in portfolio.accounts}
        for res in results_list:
            interest_by_account[res.lender_name] += res.interest_charged_cents
        for name, total_cents in interest_by_account.items():
             print(f"  - {name}: ${total_cents / 100.0:,.2f}")
             
       
        # iii. Total interest per year.
        print("\nInterest Breakdown by Year:")
        interest_by_year: Dict[int, int] = {}
        for res in results_list:
            year = (res.month - 1) // 12 + 1
            interest_by_year[year] = interest_by_year.get(year, 0) + res.interest_charged_cents
        for year, total_cents in sorted(interest_by_year.items()):
            print(f"  - Year {year}: ${total_cents / 100.0:,.2f}")
        
        # e. Print the detailed month-by-month plan.
        print("\n--- Optimized Payment Plan Details ---")
        last_month_printed = -1
        
        payoff_month = 0
        if results_list:
            # The payoff month is the highest month number in the results list,
            # because the loop breaks when all balances hit zero.
            payoff_month = max(r.month for r in results_list)

        for res in results_list:
            # Only print rows where a payment was made
            if res.payment_cents > 0:
                if res.month != last_month_printed:
                    print(f'\n--- Month {res.month} ---')
      
                    last_month_printed = res.month
                
                payment_str = f"${res.payment_cents / 100.0:,.2f}"
                interest_str = f"${res.interest_charged_cents / 100.0:,.2f}"
                balance_str = f"${res.ending_balance_cents / 100.0:,.2f}"
        
                print(f"  - {res.lender_name}: Pay {payment_str} "
                      f"(Interest: {interest_str}, New Balance: {balance_str})")

        print(f"\n🎉 All accounts paid off in {payoff_month} months!")

        return results_list

    else:
        # Handle cases where no- solution is found.
        print(f"\n❌ Solution Not Found. Status: {solver.StatusName(status)}")
        if status == cp_model.INFEASIBLE:
            print("Model is INFEASIBLE. This often means the monthly budget is less than the")
            print("sum of the minimum payments, or the payoff constraint could not be met.")
        elif status == cp_model.MODEL_INVALID:
            print("Model is INVALID. This is a critical error in the solver's constraint logic.")
 
            print("The most recent change (e.g., complex minimum payments) likely introduced")
            print("a contradictory or malformed rule (e.g., type ambiguity, circular dependency).")
            print("Please review the `model.Validate()` output above.")
        else:
            print(f"The solver stopped for an unknown reason: {solver.StatusName(status)}")
        return None

# --- VALIDATION TEST: MINIMIZE SPEND TO CLEAR PROMOS ---
if __name__ == "__main__":
    print("--- Creating Test for 'Minimize Spend to Clear Promos' Strategy ---")
    
    # 1. Define the user's accounts. MUST all be promo accounts.
    account_promo_1 = Account(
        lender_name="Card A (3-Month Promo)",
        account_type=AccountType.CREDIT_CARD,
        current_balance_cents=90000,     # £900.00
        apr_standard_bps=2999,
        min_payment_rule=MinPaymentRule(fixed_cents=1000, percentage_bps=100),
        payment_due_day=10,
        promo_duration_months=3 # Expect ~£300/mo linear payment
    )
    
    account_promo_2 = Account(
        lender_name="Card B (6-Month Promo)",
        account_type=AccountType.CREDIT_CARD,
        current_balance_cents=120000,    # £1,200.00
        apr_standard_bps=2499,
        min_payment_rule=MinPaymentRule(fixed_cents=1000, percentage_bps=100),
        payment_due_day=15,
        promo_duration_months=6 # Expect ~£200/mo linear payment
    )
    
    # 2. Define the budget.
    # This will be IGNORED by our new logic in Section 5.1.
    # We set it to 0 to prove this.
    user_budget = Budget(
        monthly_budget_cents=0,  # <-- SET TO 0, WILL BE IGNORED
        future_changes=[],           
        lump_sum_payments=[]         
    )
    
    # 3. Define the user's preferences.
    user_prefs = UserPreferences(
        strategy=OptimizationStrategy.MINIMIZE_SPEND_TO_CLEAR_PROMOS, # <-- NEW STRATEGY
        payment_shape=PaymentShape.OPTIMIZED_MONTH_TO_MONTH # <-- We expect this to be IGNORED & overridden
    )
    
    # 4. Bundle everything into the main portfolio object.
    test_portfolio = DebtPortfolio(
        accounts=[account_promo_1, account_promo_2],
        budget=user_budget,
        preferences=user_prefs
    )
    
    # 5. Call the solver to generate and print the plan!
    print("...Starting solver to validate 'Minimize Spend to Clear Promos' logic...")
    generate_payment_plan(test_portfolio)
