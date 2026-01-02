# enrichment_service.py - Ntropy Transaction Enrichment Service
# Handles TrueLayer → Ntropy → Budget Classification pipeline
# Version: 1.3 - With parallel agentic enrichment and streaming support

import os
import hashlib
import asyncio
from typing import List, Dict, Any, Optional, AsyncGenerator, Callable
from pydantic import BaseModel, Field
from concurrent.futures import ThreadPoolExecutor
import time

# Import parallel agentic enrichment components
try:
    from agents.parallel_enrichment import (
        AgenticEnrichmentQueue,
        EnrichmentProgress,
        EnrichmentStage,
        needs_agentic_enrichment,
        get_agentic_queue
    )
    AGENTIC_ENRICHMENT_AVAILABLE = True
    print("[EnrichmentService] Agentic enrichment module loaded successfully")
except ImportError as e:
    AGENTIC_ENRICHMENT_AVAILABLE = False
    print(f"[EnrichmentService] Warning: Agentic enrichment not available ({e})")

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
    # Fields for 4-layer confidence-gated cascade
    ntropy_confidence: float = 0.8
    agentic_confidence: Optional[float] = None  # Final confidence after agentic enrichment
    enrichment_stage: str = "ntropy_done"  # 'ntropy_done', 'agentic_done', etc.
    enrichment_source: Optional[str] = None  # 'math_brain', 'ntropy', 'context_hunter', 'sherlock'
    reasoning_trace: List[str] = Field(default_factory=list)
    context_data: Optional[Dict[str, Any]] = None  # Additional context from cascade layers
    exclude_from_analysis: bool = False
    transaction_type: str = "regular"  # 'regular', 'transfer', 'refund'
    linked_transaction_id: Optional[str] = None


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

# ============== Layer 1 Ambiguity Penalties ==============
# Penalties applied to Ntropy confidence for ambiguous merchants/labels
# Lower penalty = less confident (multiply base_confidence * penalty)
AMBIGUITY_PENALTIES = {
    # Marketplace merchants - could be anything
    "amazon": 0.5,
    "paypal": 0.5,
    "tesco": 0.5,
    "ebay": 0.5,
    "walmart": 0.5,
    "target": 0.5,
    # Generic labels
    "general merchandise": 0.6,
    "retail": 0.7,
    "services": 0.7,
    "other": 0.5,
    "miscellaneous": 0.5,
    "unknown": 0.3,
    "uncategorized": 0.3,
    "general": 0.6,
    "purchase": 0.7,
    "payment": 0.7,
    "transfer": 0.6,
}

# Confidence threshold for stopping the cascade
# Lowered to 0.80 to respect Ntropy as primary enrichment layer
# Claude should only enhance transactions where Ntropy is uncertain
CONFIDENCE_THRESHOLD = 0.80


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
        
        # Truncate timestamp to date - ensure it's a string first
        timestamp = raw_tx.get("timestamp", "")
        if not isinstance(timestamp, str):
            timestamp = str(timestamp) if timestamp else ""
        
        if "T" in timestamp:
            date_str = timestamp.split("T")[0]
        elif len(timestamp) >= 10:
            date_str = timestamp[:10]
        else:
            date_str = timestamp
        
        # Ensure transaction_id is always a string
        raw_tx_id = raw_tx.get("transaction_id")
        if raw_tx_id is None:
            tx_id = str(hash(raw_tx.get("description", "")))
        else:
            tx_id = str(raw_tx_id)
        
        return TrueLayerIngestModel(
            transaction_id=tx_id,
            description=raw_tx.get("description", "") or "",
            amount=normalized_amount,
            currency=raw_tx.get("currency", "GBP"),
            transaction_type=tx_type_upper,  # Store normalized uppercase type
            transaction_category=raw_tx.get("transaction_category"),
            transaction_classification=raw_tx.get("transaction_classification", []),
            timestamp=date_str
        )
    
    def _detect_ghost_pairs(
        self,
        normalized_transactions: List[TrueLayerIngestModel]
    ) -> Dict[str, Dict[str, Any]]:
        """
        Layer 0: Ghost Pair Detection (Math Brain)
        
        Detects internal transfers between accounts:
        - Same amount as another transaction (opposite direction)
        - Within 2 days of each other
        - Opposite entry types (incoming vs outgoing)
        
        Returns:
            Dict mapping transaction_id -> ghost pair match info
        """
        from datetime import datetime, timedelta
        
        ghost_pairs: Dict[str, Dict[str, Any]] = {}
        processed_ids = set()
        
        # Group transactions by amount for faster matching
        amount_groups: Dict[int, List[TrueLayerIngestModel]] = {}
        for tx in normalized_transactions:
            amount_cents = int(tx.amount * 100)
            if amount_cents not in amount_groups:
                amount_groups[amount_cents] = []
            amount_groups[amount_cents].append(tx)
        
        for tx in normalized_transactions:
            if tx.transaction_id in processed_ids:
                continue
                
            amount_cents = int(tx.amount * 100)
            candidates = amount_groups.get(amount_cents, [])
            
            tx_entry_type = self._determine_entry_type(tx)
            
            try:
                tx_date = datetime.strptime(tx.timestamp, "%Y-%m-%d")
            except ValueError:
                continue
            
            for candidate in candidates:
                if candidate.transaction_id == tx.transaction_id:
                    continue
                if candidate.transaction_id in processed_ids:
                    continue
                    
                candidate_entry_type = self._determine_entry_type(candidate)
                
                # Check opposite entry types
                if tx_entry_type == candidate_entry_type:
                    continue
                    
                try:
                    candidate_date = datetime.strptime(candidate.timestamp, "%Y-%m-%d")
                except ValueError:
                    continue
                
                # Check within 2 days
                days_diff = abs((tx_date - candidate_date).days)
                if days_diff > 2:
                    continue
                
                # Found a ghost pair!
                ghost_pairs[tx.transaction_id] = {
                    "linked_id": candidate.transaction_id,
                    "amount_cents": amount_cents,
                    "days_apart": days_diff,
                    "entry_type": tx_entry_type,
                    "linked_entry_type": candidate_entry_type
                }
                ghost_pairs[candidate.transaction_id] = {
                    "linked_id": tx.transaction_id,
                    "amount_cents": amount_cents,
                    "days_apart": days_diff,
                    "entry_type": candidate_entry_type,
                    "linked_entry_type": tx_entry_type
                }
                
                processed_ids.add(tx.transaction_id)
                processed_ids.add(candidate.transaction_id)
                
                # Safe string slicing for logging
                tx_id_short = str(tx.transaction_id)[:16] if tx.transaction_id else "unknown"
                cand_id_short = str(candidate.transaction_id)[:16] if candidate.transaction_id else "unknown"
                print(f"[EnrichmentService] Layer 0: Ghost Pair detected - {tx_id_short}... <-> {cand_id_short}... ({amount_cents/100:.2f})")
                break
        
        return ghost_pairs
    
    def _calculate_ntropy_confidence(
        self,
        merchant_name: Optional[str],
        labels: List[str],
        recurrence_confidence: Optional[float] = None,
        is_recurring: bool = False,
        original_description: Optional[str] = None
    ) -> tuple[float, Optional[str]]:
        """
        Layer 1: Calculate Ntropy confidence with ambiguity penalties
        
        Ntropy SDK v5.x does NOT return a confidence score directly.
        We derive confidence from the quality/specificity of returned data:
        - Base: 0.7 (Ntropy returned something)
        - +0.1 if merchant name was extracted
        - +0.1 if specific labels (not generic) were returned
        - +0.1 if recurrence was detected
        - Then apply ambiguity penalties for generic merchants/labels
        - ALSO check original_description for payment processor keywords (PayPal, Amazon, etc.)
        
        Returns:
            Tuple of (final_confidence, penalty_reason or None)
        """
        # Build confidence from Ntropy response quality
        # Start with base of 0.7 (Ntropy processed successfully)
        base_confidence = 0.7
        
        # Add confidence for having a merchant name
        if merchant_name and len(merchant_name) >= 3:
            base_confidence += 0.1
        
        # Add confidence for having specific labels (not just generic ones)
        generic_labels = {'retail', 'services', 'general', 'other', 'miscellaneous', 
                         'purchase', 'payment', 'transfer', 'unknown', 'uncategorized'}
        if labels:
            specific_labels = [l for l in labels if l.lower() not in generic_labels]
            if specific_labels:
                base_confidence += 0.1
        
        # Add confidence for recurrence detection
        if is_recurring:
            base_confidence += 0.1
        
        # Cap base at 1.0
        base_confidence = min(base_confidence, 1.0)
        
        # Find lowest applicable penalty
        lowest_penalty = 1.0
        penalty_reason = None
        
        # Check merchant name for ambiguity
        if merchant_name:
            merchant_lower = merchant_name.lower()
            for ambiguous_name, penalty in AMBIGUITY_PENALTIES.items():
                if ambiguous_name in merchant_lower:
                    if penalty < lowest_penalty:
                        lowest_penalty = penalty
                        penalty_reason = f"ambiguous merchant: {ambiguous_name}"
        
        # Check labels for ambiguity
        for label in labels:
            label_lower = label.lower()
            for ambiguous_label, penalty in AMBIGUITY_PENALTIES.items():
                if ambiguous_label in label_lower:
                    if penalty < lowest_penalty:
                        lowest_penalty = penalty
                        penalty_reason = f"ambiguous label: {ambiguous_label}"
        
        # CRITICAL: Check original bank description for payment processor keywords
        # Even if Ntropy extracted a clean merchant name (e.g., "Uber" from "PAYPAL *UBERTRIP"),
        # the presence of payment processors in the raw description signals uncertainty
        if original_description:
            desc_lower = original_description.lower()
            # Payment processors that hide actual merchants
            payment_processors = {
                'paypal': 0.5,    # PayPal hides actual merchant
                'amazon': 0.5,   # Amazon marketplace has many sellers
                'ebay': 0.5,     # eBay marketplace
                'klarna': 0.6,   # Buy-now-pay-later
                'clearpay': 0.6, # Buy-now-pay-later
                'afterpay': 0.6, # Buy-now-pay-later
            }
            for processor, penalty in payment_processors.items():
                if processor in desc_lower:
                    if penalty < lowest_penalty:
                        lowest_penalty = penalty
                        penalty_reason = f"payment processor in description: {processor}"
        
        final_confidence = base_confidence * lowest_penalty
        return (final_confidence, penalty_reason)
    
    def _hash_account_holder_id(self, user_id: str, truelayer_item_id: str) -> str:
        """
        Create a unique hashed account holder ID for Ntropy recurrence detection.
        
        By combining user_id + truelayer_item_id, we ensure complete data isolation
        when bank accounts are removed and re-added. Each bank connection gets a 
        unique Ntropy account holder, preventing data carryover.
        """
        combined = f"{user_id}:{truelayer_item_id}"
        hashed_id = hashlib.sha256(combined.encode()).hexdigest()[:32]
        print(f"[EnrichmentService] Generated unique account_holder_id: {hashed_id[:16]}... (user: {user_id[:8]}..., item: {truelayer_item_id[:8]}...)")
        return hashed_id
    
    def _create_or_get_account_holder(
        self,
        hashed_user_id: str,
        account_holder_name: Optional[str] = None,
        country: str = "GB"
    ) -> bool:
        """
        Ensure an account holder exists in Ntropy before enriching transactions.
        
        As of Ntropy SDK v5.x, account holders MUST be created explicitly before
        enriching transactions. The account holder name is set here, NOT on 
        individual transactions.
        
        Returns True if account holder exists/created, False on error.
        """
        if not self.sdk or not NTROPY_AVAILABLE:
            print(f"[EnrichmentService] SDK not available, skipping account holder creation")
            return False
            
        try:
            print(f"[EnrichmentService] Creating/verifying account holder {hashed_user_id[:16]}...")
            self.sdk.account_holders.create(
                id=hashed_user_id,
                type="consumer",
                name=account_holder_name or "Account Holder"
            )
            print(f"[EnrichmentService] ✓ Account holder {hashed_user_id[:16]}... created with name: {account_holder_name}")
            return True
        except Exception as e:
            error_str = str(e).lower()
            if "already exists" in error_str or "conflict" in error_str or "409" in error_str:
                print(f"[EnrichmentService] ✓ Account holder {hashed_user_id[:16]}... already exists")
                return True
            print(f"[EnrichmentService] ✗ Failed to create account holder: {e}")
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
            # Build the transaction create call
            # Note: account_holder_name is set on the account holder, NOT on transactions
            create_kwargs = {
                "id": tx_data["id"],
                "description": tx_data["description"],
                "amount": tx_data["amount"],
                "entry_type": tx_data["entry_type"],
                "currency": tx_data["currency"],
                "date": tx_data["date"],
                "account_holder_id": tx_data["account_holder_id"],
                "location": {"country": tx_data.get("country", "GB")},
            }
            
            # Log the API call for debugging
            print(f"[EnrichmentService] >>> Calling Ntropy SDK transactions.create() with:")
            print(f"  - id: {create_kwargs['id'][:20]}...")
            print(f"  - description: {create_kwargs['description'][:40]}...")
            print(f"  - account_holder_id: {create_kwargs['account_holder_id'][:16]}...")
            print(f"  - location: {create_kwargs['location']}")
            
            enriched = self.sdk.transactions.create(**create_kwargs)
            result = enriched.model_dump() if hasattr(enriched, 'model_dump') else None
            if result:
                # Ntropy SDK v5.x response structure (ACTUAL, confirmed via debug):
                # - 'entities': dict with 'counterparty' (dict) and 'intermediaries' (list) keys
                #   - counterparty: {id, name, website, logo, mccs, type}
                # - 'categories': dict with 'general' (string) and 'accounting' (string or None) keys
                # - 'merchant' at top level is ALWAYS None - use entities.counterparty.name instead
                # - 'logo'/'website' at top level are ALWAYS None - use entities.counterparty instead
                
                entities = result.get('entities') or {}
                counterparty = entities.get('counterparty') or {}
                categories = result.get('categories') or {}
                
                # Extract merchant info from counterparty entity
                merchant_name = counterparty.get('name') if isinstance(counterparty, dict) else None
                logo_url = counterparty.get('logo') if isinstance(counterparty, dict) else None
                website_url = counterparty.get('website') if isinstance(counterparty, dict) else None
                
                # Extract category - it's a dict with 'general' key, not a list
                general_category = categories.get('general') if isinstance(categories, dict) else None
                
                print(f"[EnrichmentService] ✓ Enriched: {tx_data['description'][:30]}... → {merchant_name} [{general_category or 'no category'}]")
                
                # Normalize the result to a consistent format for downstream processing
                # This makes it compatible with the rest of the codebase
                result['_normalized'] = {
                    'merchant_name': merchant_name,
                    'logo_url': logo_url,
                    'website_url': website_url,
                    'category': general_category,
                    'labels': [general_category] if general_category else [],
                }
            else:
                print(f"[EnrichmentService] ⚠ No result from Ntropy for {tx_data['id'][:20]}...")
            return result
        except Exception as e:
            print(f"[EnrichmentService] ✗ Error enriching {tx_data['id']}: {e}")
            import traceback
            traceback.print_exc()
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
        truelayer_item_id: str,
        account_holder_name: Optional[str] = None,
        country: str = "GB",
        progress_callback: Optional[Callable[[int, int, str], None]] = None,
        enable_agentic_enrichment: bool = True,
        nylas_grant_id: Optional[str] = None
    ) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Stream enrichment progress with real-time updates.
        Yields progress events and final result.
        
        Now includes parallel agentic enrichment that runs concurrently with Ntropy.
        Transactions that need deeper analysis are immediately queued for AI processing.
        
        Args:
            raw_transactions: List of raw TrueLayer transaction dicts
            user_id: User ID for recurrence detection
            truelayer_item_id: TrueLayer item ID for unique account holder isolation
            account_holder_name: Optional name for Ntropy account holder
            country: Country code for account holder (default: GB)
            progress_callback: Optional callback(current, total, status)
            enable_agentic_enrichment: Whether to run parallel agentic enrichment
            nylas_grant_id: Optional Nylas grant ID for email receipt search
            
        Yields:
            Progress events: {"type": "progress", "current": N, "total": M, "status": "enriching", ...}
            Complete event: {"type": "complete", "result": {...}}
        """
        total = len(raw_transactions)
        start_time = time.time()
        
        # Initialize extended progress tracking
        progress_stats = {
            "total_transactions": total,
            "ntropy_completed": 0,
            "agentic_queued": 0,
            "agentic_completed": 0,
            "start_time": start_time
        }
        
        # Initialize agentic enrichment queue if available
        agentic_queue = None
        if enable_agentic_enrichment and AGENTIC_ENRICHMENT_AVAILABLE:
            agentic_queue = get_agentic_queue()
            agentic_queue.set_total_transactions(total)
            print(f"[EnrichmentService] Agentic enrichment enabled for {total} transactions")
        
        # Phase 1: Normalize
        yield {
            "type": "progress", 
            "current": 0, 
            "total": total, 
            "status": "extracting", 
            "startTime": int(start_time * 1000),
            **progress_stats
        }
        
        normalized = [self.normalize_truelayer_transaction(tx) for tx in raw_transactions]
        
        # ============== LAYER 0: Ghost Pair Detection (Math Brain) ==============
        # Run BEFORE Ntropy to catch internal transfers first
        ghost_pairs = self._detect_ghost_pairs(normalized)
        ghost_pair_count = len(ghost_pairs) // 2  # Each pair has 2 entries
        print(f"[EnrichmentService] Layer 0: Detected {ghost_pair_count} ghost pairs (transfers)")
        
        progress_stats["ghost_pairs_detected"] = ghost_pair_count
        
        yield {
            "type": "progress",
            "current": 0,
            "total": total,
            "status": "detecting_transfers",
            "startTime": int(start_time * 1000),
            "ghost_pairs_detected": ghost_pair_count,
            **progress_stats
        }
        
        # Hash user ID + truelayer_item_id for unique Ntropy account holder isolation
        hashed_account_holder_id = self._hash_account_holder_id(user_id, truelayer_item_id)
        
        print(f"[EnrichmentService] Account holder context:")
        print(f"  - Hashed ID: {hashed_account_holder_id[:16]}...")
        print(f"  - Name: {account_holder_name or '(not provided)'}")
        print(f"  - Country: {country}")
        
        # Create account holder explicitly (required in Ntropy SDK v5.x)
        self._create_or_get_account_holder(hashed_account_holder_id, account_holder_name, country)
        
        # Start agentic worker in parallel (runs concurrently with Ntropy enrichment)
        if agentic_queue:
            await agentic_queue.start()
            print("[EnrichmentService] Started agentic enrichment workers (parallel)")
        
        # Phase 2: Enrich with Ntropy (with parallel agentic queueing)
        results: List[NtropyOutputModel] = []
        
        # Track high-confidence transactions that don't need agentic enrichment
        high_confidence_count = 0
        
        if self.sdk and NTROPY_AVAILABLE:
            yield {
                "type": "progress", 
                "current": 0, 
                "total": total, 
                "status": "enriching", 
                "startTime": int(start_time * 1000),
                **progress_stats
            }
            
            loop = asyncio.get_event_loop()
            
            # Process in batches of 10 for better progress visibility
            batch_size = 10
            for batch_start in range(0, total, batch_size):
                batch_end = min(batch_start + batch_size, total)
                batch = normalized[batch_start:batch_end]
                raw_batch = raw_transactions[batch_start:batch_end]
                
                # Prepare batch data with all enrichment context
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
                        "account_holder_id": hashed_account_holder_id,
                        "country": country,
                    })
                
                # Enrich batch concurrently with Ntropy
                enriched_batch = await self._enrich_concurrent(tx_data_list, loop)
                
                # Process results and check for agentic enrichment needs
                for i, enriched_dict in enumerate(enriched_batch):
                    norm_tx = batch[i]
                    raw_tx = raw_batch[i]
                    entry_type = self._determine_entry_type(norm_tx)
                    
                    # ============== LAYER 0 CHECK: Ghost Pair ==============
                    # If this is a ghost pair, skip Ntropy processing entirely
                    if norm_tx.transaction_id in ghost_pairs:
                        ghost_info = ghost_pairs[norm_tx.transaction_id]
                        
                        result = NtropyOutputModel(
                            transaction_id=norm_tx.transaction_id,
                            original_description=norm_tx.description,
                            merchant_clean_name=None,
                            merchant_logo_url=None,
                            merchant_website_url=None,
                            labels=["transfer", "internal"],
                            is_recurring=False,
                            recurrence_frequency=None,
                            recurrence_day=None,
                            amount_cents=int(norm_tx.amount * 100),
                            entry_type=entry_type,
                            budget_category="transfer",
                            transaction_date=norm_tx.timestamp,
                            # Layer 0 cascade fields
                            ntropy_confidence=1.0,
                            enrichment_source="math_brain",
                            reasoning_trace=[f"Layer 0: Ghost Pair detected - matched with TX {str(ghost_info['linked_id'])[:16]}..."],
                            exclude_from_analysis=True,
                            transaction_type="transfer",
                            linked_transaction_id=ghost_info["linked_id"]
                        )
                        results.append(result)
                        progress_stats["ntropy_completed"] += 1
                        high_confidence_count += 1
                        # Safe string slicing for logging
                        tx_id_short = str(norm_tx.transaction_id)[:16] if norm_tx.transaction_id else "unknown"
                        print(f"[EnrichmentService] Layer 0: Skipping Ntropy for ghost pair {tx_id_short}... (confidence=1.0)")
                        continue
                    
                    # ============== LAYER 1: Ntropy Processing ==============
                    if enriched_dict is None:
                        result = self._create_fallback_output(norm_tx)
                        result.reasoning_trace = ["Layer 1: Ntropy enrichment failed - using fallback"]
                        result.ntropy_confidence = 0.3
                        results.append(result)
                        
                        # Mark as ntropy_done and check for agentic enrichment
                        progress_stats["ntropy_completed"] += 1
                        if agentic_queue:
                            agentic_queue.mark_ntropy_complete(norm_tx.transaction_id)
                            # Fallback always needs agentic enrichment
                            tx_data = self._prepare_transaction_for_agentic(
                                norm_tx, result, raw_tx, user_id, nylas_grant_id
                            )
                            if agentic_queue.add_transaction(
                                norm_tx.transaction_id,
                                tx_data,
                                result.model_dump()
                            ):
                                progress_stats["agentic_queued"] += 1
                    else:
                        # ============== Ntropy SDK v5.x Response Parsing ==============
                        # The SDK response has entities (counterparty) and categories (general/accounting)
                        # We normalize this in _enrich_single_sync and store in _normalized
                        normalized = enriched_dict.get('_normalized', {})
                        
                        # Get merchant info from normalized structure
                        merchant_name = normalized.get('merchant_name')
                        logo_url = normalized.get('logo_url')
                        website_url = normalized.get('website_url')
                        general_category = normalized.get('category')
                        labels = normalized.get('labels', [])
                        
                        # Recurrence is still at top level
                        recurrence_value = enriched_dict.get('recurrence')
                        is_recurring = recurrence_value in ('recurring', 'subscription') if recurrence_value else False
                        
                        # recurrence_group contains periodicity info if recurring
                        recurrence_group = enriched_dict.get('recurrence_group') or {}
                        
                        budget_category = self.classify_transaction(
                            labels=labels,
                            is_recurring=is_recurring,
                            entry_type=entry_type
                        )
                        
                        # Calculate confidence based on Ntropy response quality
                        # (Ntropy SDK v5.x doesn't provide explicit confidence score)
                        ntropy_confidence, penalty_reason = self._calculate_ntropy_confidence(
                            merchant_name,
                            labels,
                            recurrence_confidence=None,  # No longer used
                            is_recurring=is_recurring,
                            original_description=norm_tx.description  # Check for payment processors in original description
                        )
                        
                        # Build reasoning trace
                        reasoning_trace = []
                        if penalty_reason:
                            reasoning_trace.append(f"Layer 1: Ntropy confidence={ntropy_confidence:.2f} (penalty applied for {penalty_reason})")
                        else:
                            reasoning_trace.append(f"Layer 1: Ntropy confidence={ntropy_confidence:.2f}")
                        
                        # Determine if we should skip agentic enrichment (confidence gate)
                        skip_agentic = ntropy_confidence >= CONFIDENCE_THRESHOLD
                        enrichment_source = "ntropy" if skip_agentic else None
                        
                        if skip_agentic:
                            reasoning_trace.append(f"Layer 1: Confidence >= {CONFIDENCE_THRESHOLD} - cascade STOP")
                            high_confidence_count += 1
                        
                        # Extract recurrence details from recurrence_group
                        recurrence_frequency = recurrence_group.get('periodicity') if recurrence_group else None
                        recurrence_day = None  # SDK v5.x doesn't provide day_of_month directly
                        
                        result = NtropyOutputModel(
                            transaction_id=norm_tx.transaction_id,
                            original_description=norm_tx.description,
                            merchant_clean_name=merchant_name,
                            merchant_logo_url=logo_url,
                            merchant_website_url=website_url,
                            labels=labels,
                            is_recurring=is_recurring,
                            recurrence_frequency=recurrence_frequency,
                            recurrence_day=recurrence_day,
                            amount_cents=int(norm_tx.amount * 100),
                            entry_type=entry_type,
                            budget_category=budget_category,
                            transaction_date=norm_tx.timestamp,
                            # Layer 1 cascade fields
                            ntropy_confidence=ntropy_confidence,
                            enrichment_source=enrichment_source,
                            reasoning_trace=reasoning_trace
                        )
                        results.append(result)
                        
                        # Mark as ntropy_done
                        progress_stats["ntropy_completed"] += 1
                        if agentic_queue:
                            agentic_queue.mark_ntropy_complete(norm_tx.transaction_id)
                            
                            # Only queue for agentic if confidence < threshold
                            if not skip_agentic:
                                ntropy_result_dict = {
                                    "labels": labels,
                                    "merchant_clean_name": merchant_name,
                                    "merchant": {"name": merchant_name, "logo": logo_url, "website": website_url},
                                    "is_recurring": is_recurring,
                                    "ntropy_confidence": ntropy_confidence
                                }
                                
                                if needs_agentic_enrichment(ntropy_result_dict, subscription_catalog_match=False, ntropy_confidence=ntropy_confidence):
                                    tx_data = self._prepare_transaction_for_agentic(
                                        norm_tx, result, raw_tx, user_id, nylas_grant_id
                                    )
                                    if agentic_queue.add_transaction(
                                        norm_tx.transaction_id,
                                        tx_data,
                                        result.model_dump()
                                    ):
                                        progress_stats["agentic_queued"] += 1
                
                # Update agentic_completed from queue
                if agentic_queue:
                    queue_progress = agentic_queue.get_progress()
                    progress_stats["agentic_completed"] = queue_progress.get("agentic_completed", 0)
                
                # Calculate processing rate
                elapsed = time.time() - start_time
                if elapsed > 0:
                    rate = (progress_stats["ntropy_completed"] / elapsed) * 60
                else:
                    rate = 0
                
                # Emit progress update with extended stats
                current = len(results)
                yield {
                    "type": "progress", 
                    "current": current, 
                    "total": total, 
                    "status": "enriching",
                    "startTime": int(start_time * 1000),
                    "ntropy_completed": progress_stats["ntropy_completed"],
                    "agentic_queued": progress_stats["agentic_queued"],
                    "agentic_completed": progress_stats["agentic_completed"],
                    "transactions_per_minute": round(rate, 2),
                    "estimated_time_remaining": round((total - current) / rate * 60, 1) if rate > 0 else 0
                }
        else:
            # Fallback mode
            yield {
                "type": "progress", 
                "current": 0, 
                "total": total, 
                "status": "classifying", 
                "startTime": int(start_time * 1000),
                **progress_stats
            }
            results = self._fallback_classification(normalized)
            progress_stats["ntropy_completed"] = total
        
        # Phase 3: Wait for agentic enrichment to complete (in parallel)
        if agentic_queue and progress_stats["agentic_queued"] > 0:
            yield {
                "type": "progress", 
                "current": total, 
                "total": total, 
                "status": "agentic_enriching",
                "startTime": int(start_time * 1000),
                **progress_stats
            }
            
            # Wait for agentic queue to drain (with timeout)
            agentic_result = await agentic_queue.wait_for_completion(timeout=120)
            progress_stats["agentic_completed"] = agentic_result.get("agentic_completed", 0)
            
            # Merge agentic enrichment results back into main results
            agentic_results_map = {r["transaction_id"]: r for r in agentic_result.get("results", [])}
            for result in results:
                if result.transaction_id in agentic_results_map:
                    agentic_data = agentic_results_map[result.transaction_id]
                    
                    # Always merge cascade metadata fields regardless of confidence
                    ai_confidence = agentic_data.get("ai_confidence")
                    if ai_confidence is not None:
                        result.agentic_confidence = ai_confidence  # Store agentic confidence separately
                    
                    # Mark as agentic_done since this went through the agentic queue
                    result.enrichment_stage = "agentic_done"
                    
                    # Set enrichment source from cascade layer
                    enrichment_source = agentic_data.get("enrichment_source")
                    if enrichment_source:
                        result.enrichment_source = enrichment_source
                    
                    # Store reasoning trace for debugging
                    reasoning = agentic_data.get("reasoning_trace")
                    if reasoning:
                        result.reasoning_trace = reasoning if isinstance(reasoning, list) else [reasoning]
                    
                    # Store context data from cascade layers
                    context = agentic_data.get("context_data")
                    if context:
                        result.context_data = context
                    
                    # Update with agentic enrichment data if confidence is high
                    if ai_confidence is not None and ai_confidence >= 0.7:
                        if agentic_data.get("subscription_product_name"):
                            result.merchant_clean_name = agentic_data["subscription_product_name"]
                        if agentic_data.get("is_subscription"):
                            result.is_recurring = True
                            result.budget_category = "fixed"
        elif agentic_queue:
            await agentic_queue.stop()
        
        # Phase 4: Compute budget analysis
        yield {
            "type": "progress", 
            "current": total, 
            "total": total, 
            "status": "classifying", 
            "startTime": int(start_time * 1000),
            **progress_stats
        }
        
        budget_analysis = self._compute_budget_breakdown(results)
        detected_debts = self._extract_detected_debts(results)
        
        # Final result with extended stats
        elapsed = time.time() - start_time
        yield {
            "type": "complete",
            "result": {
                "enriched_transactions": [r.model_dump() for r in results],
                "budget_analysis": budget_analysis,
                "detected_debts": detected_debts
            },
            "stats": {
                "total_transactions": total,
                "ntropy_completed": progress_stats["ntropy_completed"],
                "agentic_queued": progress_stats["agentic_queued"],
                "agentic_completed": progress_stats["agentic_completed"],
                "elapsed_seconds": round(elapsed, 2),
                "transactions_per_minute": round((total / elapsed) * 60, 2) if elapsed > 0 else 0
            }
        }
    
    def _prepare_transaction_for_agentic(
        self,
        norm_tx: 'TrueLayerIngestModel',
        result: NtropyOutputModel,
        raw_tx: Dict[str, Any],
        user_id: str,
        nylas_grant_id: Optional[str] = None
    ) -> Dict[str, Any]:
        """Prepare transaction data for agentic enrichment queue"""
        return {
            "transaction_id": norm_tx.transaction_id,
            "description": norm_tx.description,
            "original_description": result.original_description,
            "merchant_clean_name": result.merchant_clean_name,
            "amount_cents": result.amount_cents,
            "currency": norm_tx.currency,
            "transaction_date": result.transaction_date,
            "labels": result.labels,
            "is_recurring": result.is_recurring,
            "user_id": user_id,
            "nylas_grant_id": nylas_grant_id,
            "location_lat": raw_tx.get("location_lat"),
            "location_long": raw_tx.get("location_long"),
            "enrichmentStage": "ntropy_done"
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
        truelayer_item_id: str,
        account_holder_name: Optional[str] = None,
        country: str = "GB"
    ) -> List[NtropyOutputModel]:
        """
        Main enrichment pipeline: ingest → normalize → enrich → classify
        
        Args:
            raw_transactions: List of raw TrueLayer transaction dicts
            user_id: User ID for recurrence detection
            truelayer_item_id: TrueLayer item ID for unique account holder isolation
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
        
        # Hash user ID + truelayer_item_id for unique Ntropy account holder isolation
        hashed_account_holder_id = self._hash_account_holder_id(user_id, truelayer_item_id)
        
        # Phase 2: Enrich with Ntropy (if available)
        if self.sdk and NTROPY_AVAILABLE:
            try:
                # Create account holder explicitly (required in Ntropy SDK v5.x)
                self._create_or_get_account_holder(hashed_account_holder_id, account_holder_name, country)
                
                # Prepare transaction data for concurrent processing
                # Note: account_holder_name is set on the account holder, not transactions
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
                        "account_holder_id": hashed_account_holder_id,
                        "country": country,
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
                    
                    # ============== Ntropy SDK v5.x Response Parsing ==============
                    # The SDK response has entities (counterparty) and categories (general/accounting)
                    # We normalize this in _enrich_single_sync and store in _normalized
                    normalized_data = enriched_dict.get('_normalized', {})
                    
                    # Get merchant info from normalized structure
                    merchant_name = normalized_data.get('merchant_name')
                    logo_url = normalized_data.get('logo_url')
                    website_url = normalized_data.get('website_url')
                    general_category = normalized_data.get('category')
                    labels = normalized_data.get('labels', [])
                    
                    # Recurrence is still at top level
                    recurrence_value = enriched_dict.get('recurrence')
                    is_recurring = recurrence_value in ('recurring', 'subscription') if recurrence_value else False
                    recurrence_group = enriched_dict.get('recurrence_group') or {}
                    recurrence_freq = recurrence_group.get('periodicity') if recurrence_group else None
                    recurrence_day = None  # SDK v5.x doesn't provide day_of_month
                    
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
    truelayer_item_id: str,
    analysis_months: int = 3,
    account_holder_name: Optional[str] = None,
    country: str = "GB"
) -> Dict[str, Any]:
    """
    High-level function to enrich transactions and compute budget breakdown
    
    Args:
        raw_transactions: List of raw TrueLayer transaction dicts
        user_id: User ID for recurrence detection
        truelayer_item_id: TrueLayer item ID for unique account holder isolation
        analysis_months: Number of months to analyze
        account_holder_name: Optional name for Ntropy account holder
        country: Country code for account holder (default: GB)
    
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
        truelayer_item_id=truelayer_item_id,
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
