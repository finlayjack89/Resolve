# enrichment_service.py - Ntropy Transaction Enrichment Service
# Handles TrueLayer → Ntropy → Budget Classification pipeline
# Version: 1.2 - With concurrent processing and streaming support

import os
import hashlib
import asyncio
from typing import List, Dict, Any, Optional, AsyncGenerator, Callable
from pydantic import BaseModel, Field
from concurrent.futures import ThreadPoolExecutor
import time

# Ntropy SDK import
NTROPY_AVAILABLE = False
NtropySDK = None

try:
    from ntropy_sdk import SDK
    NtropySDK = SDK
    NTROPY_AVAILABLE = True
    print("[EnrichmentService] Ntropy SDK loaded successfully")
except ImportError as e:
    print(f"[EnrichmentService] Warning: ntropy-sdk not available ({e}), running in fallback mode")

# Thread pool for concurrent Ntropy API calls
# Ntropy rate limit: max 10 concurrent enrichment operations, 500 credits/sec refill
# Source: https://docs.ntropy.com/api/rate-limits
_executor = ThreadPoolExecutor(max_workers=10)


# ============== Pydantic Models for Type Safety ==============

class TrueLayerIngestModel(BaseModel):
    """Validated input from TrueLayer transaction data"""
    transaction_id: str
    description: str
    amount: float
    currency: str = "GBP"
    transaction_type: Optional[str] = None  # DEBIT/CREDIT
    transaction_category: Optional[str] = None
    transaction_classification: Optional[List[str]] = None
    timestamp: str  # ISO format
    
class NtropyOutputModel(BaseModel):
    """Output model after Ntropy enrichment"""
    transaction_id: str
    original_description: str
    merchant_clean_name: Optional[str] = None
    merchant_logo_url: Optional[str] = None
    merchant_website_url: Optional[str] = None
    labels: List[str] = Field(default_factory=list)
    is_recurring: bool = False
    recurrence_frequency: Optional[str] = None
    recurrence_day: Optional[int] = None
    amount_cents: int
    entry_type: str  # 'incoming' or 'outgoing'
    budget_category: str  # 'debt', 'fixed', 'discretionary'
    transaction_date: str


# ============== Classification Constants ==============

# Labels that indicate potential debt payments
DEBT_LABELS = [
    'loan', 'mortgage', 'finance', 'bnpl', 'buy now pay later',
    'credit card', 'overdraft', 'klarna', 'clearpay', 'afterpay',
    'laybuy', 'paypal credit', 'very pay', 'littlewoods', 'studio',
    'car finance', 'personal loan', 'debt collection', 'debt recovery'
]

# Labels that indicate fixed/recurring costs
FIXED_COST_LABELS = [
    'utilities', 'utility', 'gas', 'electric', 'electricity', 'water',
    'council tax', 'insurance', 'home insurance', 'car insurance',
    'life insurance', 'health insurance', 'subscription', 'membership',
    'gym', 'streaming', 'netflix', 'spotify', 'amazon prime', 'disney+',
    'rent', 'mortgage payment', 'broadband', 'internet', 'phone', 'mobile',
    'tv license', 'childcare', 'nursery', 'school fees'
]

# Labels for discretionary spending
DISCRETIONARY_LABELS = [
    'food', 'dining', 'restaurant', 'takeaway', 'fast food', 'coffee',
    'shopping', 'retail', 'clothing', 'electronics', 'entertainment',
    'leisure', 'travel', 'holiday', 'gambling', 'betting', 'lottery'
]


# ============== Enrichment Service ==============

class EnrichmentService:
    """
    Handles the full transaction enrichment lifecycle:
    ingest → convert → enrich → classify
    """
    
    def __init__(self, api_key: Optional[str] = None):
        """Initialize the Ntropy SDK with the provided API key"""
        self.api_key = api_key or os.environ.get("NTROPY_API_KEY")
        self.sdk = None
        
        # Detailed initialization logging
        print(f"[EnrichmentService] Initializing...")
        print(f"[EnrichmentService] NTROPY_AVAILABLE: {NTROPY_AVAILABLE}")
        print(f"[EnrichmentService] API key present: {bool(self.api_key)}")
        print(f"[EnrichmentService] API key length: {len(self.api_key) if self.api_key else 0}")
        
        if NTROPY_AVAILABLE and self.api_key and NtropySDK:
            try:
                self.sdk = NtropySDK(self.api_key)
                print("[EnrichmentService] ✓ Ntropy SDK initialized successfully - LIVE enrichment enabled")
            except Exception as e:
                print(f"[EnrichmentService] ✗ Failed to initialize Ntropy SDK: {e}")
                self.sdk = None
        else:
            reasons = []
            if not NTROPY_AVAILABLE:
                reasons.append("ntropy-sdk module not installed")
            if not self.api_key:
                reasons.append("NTROPY_API_KEY not set")
            if not NtropySDK:
                reasons.append("SDK class not loaded")
            print(f"[EnrichmentService] ⚠ Running in FALLBACK mode - reasons: {', '.join(reasons)}")
    
    def normalize_truelayer_transaction(self, raw_tx: Dict[str, Any]) -> TrueLayerIngestModel:
        """
        Phase 1: Normalize raw TrueLayer transaction data
        - Determine entry type from amount sign OR transaction_type field
        - Normalize amounts to positive values
        - Truncate timestamps to date strings
        """
        # Extract amount and determine direction
        amount = raw_tx.get("amount", 0)
        
        # TrueLayer: positive = credit, negative = debit
        # OR use transaction_type field (normalize to uppercase for comparison)
        tx_type = raw_tx.get("transaction_type", "")
        tx_type_upper = tx_type.upper() if isinstance(tx_type, str) else ""
        
        # Normalize amount to positive
        normalized_amount = abs(amount)
        
        # Truncate timestamp to date
        timestamp = raw_tx.get("timestamp", "")
        if "T" in timestamp:
            date_str = timestamp.split("T")[0]
        else:
            date_str = timestamp[:10] if len(timestamp) >= 10 else timestamp
        
        return TrueLayerIngestModel(
            transaction_id=raw_tx.get("transaction_id", str(hash(raw_tx.get("description", "")))),
            description=raw_tx.get("description", ""),
            amount=normalized_amount,
            currency=raw_tx.get("currency", "GBP"),
            transaction_type=tx_type_upper,  # Store normalized uppercase type
            transaction_category=raw_tx.get("transaction_category"),
            transaction_classification=raw_tx.get("transaction_classification", []),
            timestamp=date_str
        )
    
    def _hash_user_id(self, user_id: str) -> str:
        """Create a hashed account holder ID for Ntropy recurrence detection"""
        return hashlib.sha256(user_id.encode()).hexdigest()[:32]
    
    def _create_or_get_account_holder(
        self,
        hashed_user_id: str,
        account_holder_name: Optional[str] = None,
        country: str = "GB"
    ) -> bool:
        """
        Ensure account holder exists in Ntropy before enrichment.
        Creates if doesn't exist, ignores if already exists.
        
        Returns True if account holder exists/was created, False otherwise.
        """
        if not self.sdk:
            print(f"[EnrichmentService] ⚠ Cannot create account holder - SDK not initialized")
            return False
        
        print(f"[EnrichmentService] Creating/verifying account holder:")
        print(f"  - ID: {hashed_user_id[:8]}...")
        print(f"  - Name: {account_holder_name or '(not provided)'}")
        print(f"  - Country: {country}")
        
        try:
            self.sdk.account_holders.create(
                id=hashed_user_id,
                type="consumer",
                name=account_holder_name,
                country=country
            )
            print(f"[EnrichmentService] ✓ Created NEW account holder: {hashed_user_id[:8]}... (name={account_holder_name}, country={country})")
            return True
        except Exception as e:
            error_str = str(e).lower()
            if "already exists" in error_str or "409" in error_str:
                print(f"[EnrichmentService] ✓ Account holder already exists: {hashed_user_id[:8]}...")
                return True
            print(f"[EnrichmentService] ✗ Failed to create account holder: {e}")
            print(f"[EnrichmentService] Error details: {type(e).__name__}: {str(e)}")
            return False
    
    def _determine_entry_type(self, norm_tx: TrueLayerIngestModel) -> str:
        """
        Determine if a transaction is incoming (income) or outgoing (expense).
        
        TrueLayer transaction_type values (after uppercase normalization):
        - CREDIT: Money received
        - DEBIT: Money spent  
        - STANDING_ORDER: Recurring outgoing payment
        - DIRECT_DEBIT: Recurring outgoing payment
        - FEE: Outgoing fee
        """
        outgoing_types = {"DEBIT", "STANDING_ORDER", "DIRECT_DEBIT", "FEE"}
        incoming_types = {"CREDIT"}
        
        # Check transaction_type first (more reliable)
        if norm_tx.transaction_type in outgoing_types:
            return "outgoing"
        if norm_tx.transaction_type in incoming_types:
            return "incoming"
        
        # Fallback to amount sign if transaction_type is unknown
        # In TrueLayer raw data, negative = outgoing, positive = incoming
        # But we normalize to absolute values, so check the original amount in raw_tx
        # Since we don't have access to raw_tx here, assume unknown types with any amount are outgoing
        # unless explicitly marked as credit
        return "outgoing"
    
    def _enrich_single_sync(self, tx_data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """Synchronous single transaction enrichment for thread pool"""
        try:
            enriched = self.sdk.transactions.create(
                id=tx_data["id"],
                description=tx_data["description"],
                amount=tx_data["amount"],
                entry_type=tx_data["entry_type"],
                currency=tx_data["currency"],
                date=tx_data["date"],
                account_holder_id=tx_data["account_holder_id"],
            )
            result = enriched.model_dump() if hasattr(enriched, 'model_dump') else None
            if result:
                merchant_name = result.get('merchant', {}).get('name', 'Unknown') if result.get('merchant') else 'Unknown'
                labels = result.get('labels', [])
                print(f"[EnrichmentService] ✓ Enriched: {tx_data['description'][:30]}... → {merchant_name} [{', '.join(labels[:3])}]")
            return result
        except Exception as e:
            print(f"[EnrichmentService] ✗ Error enriching {tx_data['id']}: {e}")
            return None
    
    async def _enrich_concurrent(
        self, 
        tx_data_list: List[Dict[str, Any]], 
        loop: asyncio.AbstractEventLoop
    ) -> List[Optional[Dict[str, Any]]]:
        """
        Enrich transactions concurrently using thread pool.
        Significantly faster than sequential processing.
        """
        tasks = [
            loop.run_in_executor(_executor, self._enrich_single_sync, tx_data)
            for tx_data in tx_data_list
        ]
        return await asyncio.gather(*tasks)
    
    async def enrich_transactions_streaming(
        self,
        raw_transactions: List[Dict[str, Any]],
        user_id: str,
        account_holder_name: Optional[str] = None,
        country: str = "GB",
        progress_callback: Optional[Callable[[int, int, str], None]] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream enrichment progress with real-time updates.
        Yields progress events and final result.
        
        Args:
            raw_transactions: List of raw TrueLayer transaction dicts
            user_id: User ID for recurrence detection
            account_holder_name: Optional name for Ntropy account holder
            country: Country code for account holder (default: GB)
            progress_callback: Optional callback(current, total, status)
            
        Yields:
            Progress events: {"type": "progress", "current": N, "total": M, "status": "enriching"}
            Complete event: {"type": "complete", "result": {...}}
        """
        total = len(raw_transactions)
        start_time = time.time()
        
        # Phase 1: Normalize
        yield {"type": "progress", "current": 0, "total": total, "status": "extracting", "startTime": int(start_time * 1000)}
        
        normalized = [self.normalize_truelayer_transaction(tx) for tx in raw_transactions]
        
        # Ensure account holder exists before enrichment - only abort if SDK is available but call fails
        hashed_user_id = self._hash_user_id(user_id)
        
        # Only attempt account holder creation if SDK is available
        if self.sdk and NTROPY_AVAILABLE:
            account_holder_created = self._create_or_get_account_holder(hashed_user_id, account_holder_name, country)
            
            if not account_holder_created:
                print(f"[EnrichmentService] CRITICAL: Account holder creation failed for user {user_id[:8]}... - aborting Ntropy enrichment and using fallback")
                # Fall back to classification-only mode without Ntropy
                yield {"type": "progress", "current": 0, "total": total, "status": "classifying", "startTime": int(start_time * 1000)}
                results = self._fallback_classification(normalized)
                
                yield {"type": "progress", "current": total, "total": total, "status": "classifying", "startTime": int(start_time * 1000)}
                
                budget_analysis = self._compute_budget_breakdown(results)
                detected_debts = self._extract_detected_debts(results)
                
                yield {
                    "type": "complete",
                    "result": {
                        "enriched_transactions": [r.model_dump() for r in results],
                        "budget_analysis": budget_analysis,
                        "detected_debts": detected_debts,
                        "warning": "Ntropy account holder creation failed - using fallback classification"
                    }
                }
                return
        
        # Phase 2: Enrich with Ntropy
        results: List[NtropyOutputModel] = []
        
        if self.sdk and NTROPY_AVAILABLE:
            yield {"type": "progress", "current": 0, "total": total, "status": "enriching", "startTime": int(start_time * 1000)}
            
            loop = asyncio.get_event_loop()
            
            # Process in batches of 10 for better progress visibility
            batch_size = 10
            for batch_start in range(0, total, batch_size):
                batch_end = min(batch_start + batch_size, total)
                batch = normalized[batch_start:batch_end]
                
                # Prepare batch data
                tx_data_list = []
                for norm_tx in batch:
                    entry_type = self._determine_entry_type(norm_tx)
                    tx_data_list.append({
                        "id": norm_tx.transaction_id,
                        "description": norm_tx.description,
                        "amount": norm_tx.amount,
                        "entry_type": entry_type,
                        "currency": norm_tx.currency,
                        "date": norm_tx.timestamp,
                        "account_holder_id": self._hash_user_id(user_id),
                    })
                
                # Enrich batch concurrently
                enriched_batch = await self._enrich_concurrent(tx_data_list, loop)
                
                # Process results
                for i, enriched_dict in enumerate(enriched_batch):
                    norm_tx = batch[i]
                    
                    if enriched_dict is None:
                        results.append(self._create_fallback_output(norm_tx))
                    else:
                        labels = enriched_dict.get('labels', []) or []
                        merchant = enriched_dict.get('merchant', {}) or {}
                        recurrence = enriched_dict.get('recurrence', {}) or {}
                        
                        entry_type = self._determine_entry_type(norm_tx)
                        budget_category = self.classify_transaction(
                            labels=labels,
                            is_recurring=recurrence.get('is_recurring', False),
                            entry_type=entry_type
                        )
                        
                        results.append(NtropyOutputModel(
                            transaction_id=norm_tx.transaction_id,
                            original_description=norm_tx.description,
                            merchant_clean_name=merchant.get('name'),
                            merchant_logo_url=merchant.get('logo'),
                            merchant_website_url=merchant.get('website'),
                            labels=labels,
                            is_recurring=recurrence.get('is_recurring', False),
                            recurrence_frequency=recurrence.get('frequency'),
                            recurrence_day=recurrence.get('day_of_month'),
                            amount_cents=int(norm_tx.amount * 100),
                            entry_type=entry_type,
                            budget_category=budget_category,
                            transaction_date=norm_tx.timestamp
                        ))
                
                # Emit progress update
                current = len(results)
                yield {
                    "type": "progress", 
                    "current": current, 
                    "total": total, 
                    "status": "enriching",
                    "startTime": int(start_time * 1000)
                }
        else:
            # Fallback mode
            yield {"type": "progress", "current": 0, "total": total, "status": "classifying", "startTime": int(start_time * 1000)}
            results = self._fallback_classification(normalized)
        
        # Phase 3: Compute budget analysis
        yield {"type": "progress", "current": total, "total": total, "status": "classifying", "startTime": int(start_time * 1000)}
        
        budget_analysis = self._compute_budget_breakdown(results)
        detected_debts = self._extract_detected_debts(results)
        
        # Final result
        yield {
            "type": "complete",
            "result": {
                "enriched_transactions": [r.model_dump() for r in results],
                "budget_analysis": budget_analysis,
                "detected_debts": detected_debts
            }
        }
    
    def _compute_budget_breakdown(self, enriched: List[NtropyOutputModel], analysis_horizon_months: int = 3) -> Dict[str, Any]:
        """
        Compute budget breakdown from enriched transactions.
        
        Calculates monthly averages using only COMPLETE months from the data,
        capped at the analysis horizon (default: 3 months).
        Current (partial) month is excluded from the average calculation.
        """
        from datetime import datetime
        
        today = datetime.now()
        first_of_current_month = datetime(today.year, today.month, 1)
        
        # Calculate the analysis window: 1st of (current - analysis_horizon_months) to end of last complete month
        # Example: If today is Dec 13 and horizon is 3, window is Sept 1 - Nov 30
        analysis_start_year = today.year
        analysis_start_month = today.month - analysis_horizon_months
        while analysis_start_month <= 0:
            analysis_start_month += 12
            analysis_start_year -= 1
        analysis_start = datetime(analysis_start_year, analysis_start_month, 1)
        
        income_total = 0
        fixed_total = 0
        discretionary_total = 0
        debt_total = 0
        
        # Only count transactions within the analysis window (complete months only)
        for tx in enriched:
            if not tx.transaction_date:
                continue
            
            try:
                tx_date = datetime.strptime(tx.transaction_date, "%Y-%m-%d")
            except ValueError:
                continue
            
            # Include only transactions from complete months within the analysis window
            # Exclude current month (partial) and transactions before the analysis start
            if tx_date < analysis_start or tx_date >= first_of_current_month:
                continue
            
            if tx.entry_type == "incoming":
                income_total += tx.amount_cents
            elif tx.budget_category == "fixed":
                fixed_total += tx.amount_cents
            elif tx.budget_category == "discretionary":
                discretionary_total += tx.amount_cents
            elif tx.budget_category == "debt":
                debt_total += tx.amount_cents
        
        # Calculate actual complete months in the analysis window
        # Count months from analysis_start to first_of_current_month
        complete_months = 0
        check_year, check_month = analysis_start_year, analysis_start_month
        while datetime(check_year, check_month, 1) < first_of_current_month:
            complete_months += 1
            check_month += 1
            if check_month > 12:
                check_month = 1
                check_year += 1
        
        # Cap at analysis horizon and ensure minimum of 1
        months = min(complete_months, analysis_horizon_months)
        months = max(1, months)
        
        monthly_income = income_total // months
        monthly_fixed = fixed_total // months
        monthly_discretionary = discretionary_total // months
        monthly_debt = debt_total // months
        
        safe_to_spend = max(0, monthly_income - monthly_fixed - monthly_debt)
        
        return {
            "averageMonthlyIncomeCents": monthly_income,
            "fixedCostsCents": monthly_fixed,
            "discretionaryCents": monthly_discretionary,
            "debtPaymentsCents": monthly_debt,
            "safeToSpendCents": safe_to_spend,
            "analysisMonths": months
        }
    
    def _extract_detected_debts(self, enriched: List[NtropyOutputModel]) -> List[Dict[str, Any]]:
        """Extract detected debt payments from enriched transactions"""
        debts = []
        seen = set()
        
        for tx in enriched:
            if tx.budget_category == "debt":
                key = (tx.merchant_clean_name or tx.original_description, tx.amount_cents)
                if key not in seen:
                    seen.add(key)
                    debts.append({
                        "description": tx.original_description,
                        "merchant_name": tx.merchant_clean_name,
                        "amount_cents": tx.amount_cents,
                        "logo_url": tx.merchant_logo_url,
                        "is_recurring": tx.is_recurring,
                        "recurrence_frequency": tx.recurrence_frequency
                    })
        
        return debts
    
    def classify_transaction(
        self,
        labels: List[str],
        is_recurring: bool,
        entry_type: str
    ) -> str:
        """
        Phase 3: The "Triage Nurse" - classify into budget buckets
        
        Bucket A: "debt" - Loan/BNPL/credit payments
        Bucket B: "fixed" - Recurring bills and subscriptions  
        Bucket C: "discretionary" - Variable spending
        """
        labels_lower = [l.lower() for l in labels]
        labels_text = " ".join(labels_lower)
        
        # Bucket A: Check for debt indicators
        for debt_keyword in DEBT_LABELS:
            if debt_keyword in labels_text:
                return "debt"
        
        # Bucket B: Check for fixed costs OR recurring non-debt
        for fixed_keyword in FIXED_COST_LABELS:
            if fixed_keyword in labels_text:
                return "fixed"
        
        # If it's recurring but not matched above, assume fixed cost
        if is_recurring and entry_type == "outgoing":
            return "fixed"
        
        # Bucket C: Everything else that's outgoing is discretionary
        if entry_type == "outgoing":
            return "discretionary"
        
        # Income
        return "income"
    
    async def enrich_transactions(
        self,
        raw_transactions: List[Dict[str, Any]],
        user_id: str,
        account_holder_name: Optional[str] = None,
        country: str = "GB"
    ) -> List[NtropyOutputModel]:
        """
        Main enrichment pipeline: ingest → normalize → enrich → classify
        
        Args:
            raw_transactions: List of raw TrueLayer transaction dicts
            user_id: User ID for recurrence detection
            account_holder_name: Optional name for Ntropy account holder
            country: Country code for account holder (default: GB)
            
        Returns:
            List of enriched and classified transactions
        """
        results: List[NtropyOutputModel] = []
        
        # Phase 1: Normalize all transactions
        normalized = [
            self.normalize_truelayer_transaction(tx)
            for tx in raw_transactions
        ]
        
        # Ensure account holder exists before enrichment - only abort if SDK is available but call fails
        hashed_user_id = self._hash_user_id(user_id)
        
        # Phase 2: Enrich with Ntropy (if available)
        if self.sdk and NTROPY_AVAILABLE:
            # Create account holder before enrichment - abort if this fails
            account_holder_created = self._create_or_get_account_holder(hashed_user_id, account_holder_name, country)
            
            if not account_holder_created:
                print(f"[EnrichmentService] CRITICAL: Account holder creation failed for user {user_id[:8]}... - using fallback classification")
                return self._fallback_classification(normalized)
            try:
                # Prepare transaction data for concurrent processing
                tx_data_list = []
                for norm_tx in normalized:
                    entry_type = self._determine_entry_type(norm_tx)
                    tx_data_list.append({
                        "id": norm_tx.transaction_id,
                        "description": norm_tx.description,
                        "amount": norm_tx.amount,
                        "entry_type": entry_type,
                        "currency": norm_tx.currency,
                        "date": norm_tx.timestamp,
                        "account_holder_id": self._hash_user_id(user_id),
                    })
                
                print(f"[EnrichmentService] Enriching {len(tx_data_list)} transactions with Ntropy (concurrent)...")
                
                # Use concurrent processing for speed
                loop = asyncio.get_event_loop()
                enriched_batch = await self._enrich_concurrent(tx_data_list, loop)
                
                # Process enriched results
                for i, enriched_dict in enumerate(enriched_batch):
                    norm_tx = normalized[i]
                    
                    # Skip if enrichment failed for this transaction
                    if enriched_dict is None:
                        results.append(self._create_fallback_output(norm_tx))
                        continue
                    
                    # enriched_dict is already a dict from _enrich_concurrent
                    labels = enriched_dict.get('labels', []) or []
                    merchant = enriched_dict.get('merchant', {}) or {}
                    recurrence = enriched_dict.get('recurrence', {}) or {}
                    
                    merchant_name = merchant.get('name')
                    logo_url = merchant.get('logo')
                    website_url = merchant.get('website')
                    
                    is_recurring = recurrence.get('is_recurring', False)
                    recurrence_freq = recurrence.get('frequency')
                    recurrence_day = recurrence.get('day_of_month')
                    
                    entry_type = self._determine_entry_type(norm_tx)
                    
                    # Phase 3: Classify
                    budget_category = self.classify_transaction(
                        labels=labels,
                        is_recurring=is_recurring,
                        entry_type=entry_type
                    )
                    
                    results.append(NtropyOutputModel(
                        transaction_id=norm_tx.transaction_id,
                        original_description=norm_tx.description,
                        merchant_clean_name=merchant_name,
                        merchant_logo_url=logo_url,
                        merchant_website_url=website_url,
                        labels=labels,
                        is_recurring=is_recurring,
                        recurrence_frequency=recurrence_freq,
                        recurrence_day=recurrence_day,
                        amount_cents=int(norm_tx.amount * 100),
                        entry_type=entry_type,
                        budget_category=budget_category,
                        transaction_date=norm_tx.timestamp
                    ))
                
                print(f"[EnrichmentService] Successfully enriched {len(results)} transactions")
                
            except Exception as e:
                print(f"[EnrichmentService] Ntropy enrichment failed: {e}")
                print("[EnrichmentService] Falling back to basic classification")
                results = self._fallback_classification(normalized)
        else:
            # Fallback mode - use TrueLayer classifications and basic rules
            print("[EnrichmentService] Using fallback classification (no Ntropy)")
            results = self._fallback_classification(normalized)
        
        return results
    
    def _create_fallback_output(self, norm_tx: TrueLayerIngestModel) -> NtropyOutputModel:
        """Create a fallback output for a single transaction when Ntropy enrichment fails"""
        labels = norm_tx.transaction_classification or []
        desc_lower = norm_tx.description.lower()
        is_recurring = any(kw in desc_lower for kw in [
            'dd ', 'direct debit', 'standing order', 's/o',
            'subscription', 'monthly', 'recurring'
        ])
        entry_type = self._determine_entry_type(norm_tx)
        budget_category = self._classify_by_keywords(desc_lower, labels, is_recurring, entry_type)
        
        return NtropyOutputModel(
            transaction_id=norm_tx.transaction_id,
            original_description=norm_tx.description,
            merchant_clean_name=None,
            merchant_logo_url=None,
            merchant_website_url=None,
            labels=labels,
            is_recurring=is_recurring,
            recurrence_frequency="monthly" if is_recurring else None,
            recurrence_day=None,
            amount_cents=int(norm_tx.amount * 100),
            entry_type=entry_type,
            budget_category=budget_category,
            transaction_date=norm_tx.timestamp
        )
    
    def _fallback_classification(
        self,
        normalized_transactions: List[TrueLayerIngestModel]
    ) -> List[NtropyOutputModel]:
        """
        Fallback when Ntropy is unavailable - use TrueLayer classifications
        and keyword matching for basic categorization
        """
        results = []
        
        for norm_tx in normalized_transactions:
            # Use TrueLayer classification as labels
            labels = norm_tx.transaction_classification or []
            
            # Basic keyword matching on description
            desc_lower = norm_tx.description.lower()
            
            # Detect recurring based on common patterns
            is_recurring = any(kw in desc_lower for kw in [
                'dd ', 'direct debit', 'standing order', 's/o',
                'subscription', 'monthly', 'recurring'
            ])
            
            entry_type = self._determine_entry_type(norm_tx)
            
            # Enhanced classification using description keywords
            budget_category = self._classify_by_keywords(desc_lower, labels, is_recurring, entry_type)
            
            results.append(NtropyOutputModel(
                transaction_id=norm_tx.transaction_id,
                original_description=norm_tx.description,
                merchant_clean_name=None,  # No merchant info without Ntropy
                merchant_logo_url=None,
                merchant_website_url=None,
                labels=labels,
                is_recurring=is_recurring,
                recurrence_frequency="monthly" if is_recurring else None,
                recurrence_day=None,
                amount_cents=int(norm_tx.amount * 100),
                entry_type=entry_type,
                budget_category=budget_category,
                transaction_date=norm_tx.timestamp
            ))
        
        return results
    
    def _classify_by_keywords(
        self,
        description: str,
        labels: List[str],
        is_recurring: bool,
        entry_type: str
    ) -> str:
        """Classify using keyword matching on description"""
        combined_text = description + " " + " ".join([l.lower() for l in labels])
        
        # Check for debt
        for kw in DEBT_LABELS:
            if kw in combined_text:
                return "debt"
        
        # Check for fixed costs
        for kw in FIXED_COST_LABELS:
            if kw in combined_text:
                return "fixed"
        
        # Recurring outgoing = fixed
        if is_recurring and entry_type == "outgoing":
            return "fixed"
        
        # Everything else outgoing = discretionary
        if entry_type == "outgoing":
            return "discretionary"
        
        return "income"


# ============== Batch Processing Helper ==============

async def enrich_and_analyze_budget(
    raw_transactions: List[Dict[str, Any]],
    user_id: str,
    analysis_months: int = 3,
    account_holder_name: Optional[str] = None,
    country: str = "GB"
) -> Dict[str, Any]:
    """
    High-level function to enrich transactions and compute budget breakdown
    
    Returns:
        Dict containing:
        - enriched_transactions: List of enriched transaction data
        - budget_analysis: Computed budget figures
        - detected_debts: List of potential debt payments for user confirmation
    """
    service = EnrichmentService()
    
    # Enrich all transactions
    enriched = await service.enrich_transactions(
        raw_transactions, 
        user_id,
        account_holder_name=account_holder_name,
        country=country
    )
    
    # Compute budget breakdown
    total_income_cents = 0
    total_fixed_cents = 0
    total_discretionary_cents = 0
    detected_debts = []
    
    for tx in enriched:
        if tx.entry_type == "incoming":
            total_income_cents += tx.amount_cents
        elif tx.budget_category == "debt":
            detected_debts.append({
                "description": tx.original_description,
                "merchant_name": tx.merchant_clean_name or tx.original_description,
                "logo_url": tx.merchant_logo_url,
                "amount_cents": tx.amount_cents,
                "is_recurring": tx.is_recurring,
                "recurrence_frequency": tx.recurrence_frequency,
                "transaction_id": tx.transaction_id
            })
        elif tx.budget_category == "fixed":
            total_fixed_cents += tx.amount_cents
        elif tx.budget_category == "discretionary":
            total_discretionary_cents += tx.amount_cents
    
    # Calculate monthly averages
    avg_income = total_income_cents // analysis_months
    avg_fixed = total_fixed_cents // analysis_months
    avg_discretionary = total_discretionary_cents // analysis_months
    
    return {
        "enriched_transactions": [tx.model_dump() for tx in enriched],
        "budget_analysis": {
            "averageMonthlyIncomeCents": avg_income,
            "fixedCostsCents": avg_fixed,
            "discretionaryCents": avg_discretionary,
            "safeToSpendCents": avg_income - avg_fixed,
            "transactionCount": len(enriched)
        },
        "detected_debts": detected_debts
    }
