"""
Parallel Agentic Enrichment Queue

Handles parallel processing of transactions that need AI-powered enrichment
after initial Ntropy enrichment. Runs concurrently with Ntropy processing.

Key features:
- Semaphore-limited concurrency (max 5 concurrent transactions)
- Real-time progress tracking
- Streaming confidence checks
- Idempotency via enrichmentStage tracking
"""

import asyncio
import time
from typing import Dict, Any, List, Optional, Callable, AsyncGenerator
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum


class EnrichmentStage(str, Enum):
    """Stage of transaction enrichment"""
    PENDING = "pending"
    NTROPY_PROCESSING = "ntropy_processing"
    NTROPY_DONE = "ntropy_done"
    AGENTIC_QUEUED = "agentic_queued"
    AGENTIC_PROCESSING = "agentic_processing"
    AGENTIC_DONE = "agentic_done"
    COMPLETE = "complete"
    FAILED = "failed"


@dataclass
class EnrichmentProgress:
    """Progress tracking for enrichment pipeline"""
    total_transactions: int = 0
    ntropy_completed: int = 0
    agentic_queued: int = 0
    agentic_completed: int = 0
    start_time: float = field(default_factory=time.time)
    
    @property
    def transactions_per_minute(self) -> float:
        """Calculate processing rate"""
        elapsed = time.time() - self.start_time
        if elapsed <= 0:
            return 0.0
        total_completed = self.ntropy_completed + self.agentic_completed
        return (total_completed / elapsed) * 60
    
    @property
    def estimated_time_remaining_seconds(self) -> float:
        """Estimate remaining time based on current rate"""
        rate = self.transactions_per_minute
        if rate <= 0:
            return 0.0
        remaining = (
            (self.total_transactions - self.ntropy_completed) +
            (self.agentic_queued - self.agentic_completed)
        )
        return (remaining / rate) * 60
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "total_transactions": self.total_transactions,
            "ntropy_completed": self.ntropy_completed,
            "agentic_queued": self.agentic_queued,
            "agentic_completed": self.agentic_completed,
            "transactions_per_minute": round(self.transactions_per_minute, 2),
            "estimated_time_remaining_seconds": round(self.estimated_time_remaining_seconds, 1),
            "elapsed_seconds": round(time.time() - self.start_time, 1)
        }


AMBIGUOUS_LABELS = [
    'retail', 'services', 'general', 'other', 'miscellaneous',
    'purchase', 'payment', 'transfer', 'unknown', 'uncategorized'
]

# Confidence threshold for 4-layer cascade
# Lowered to 0.80 to respect Ntropy as primary enrichment layer
# Claude should only enhance transactions where Ntropy is uncertain
CONFIDENCE_THRESHOLD = 0.80


def needs_agentic_enrichment(
    ntropy_result: Dict[str, Any],
    subscription_catalog_match: bool = False,
    ntropy_confidence: Optional[float] = None
) -> bool:
    """
    Determine if a transaction needs additional AI-powered enrichment.
    
    4-Layer Confidence-Gated Cascade:
    - If ntropy_confidence >= 0.90: STOP (skip agentic enrichment)
    - If ntropy_confidence < 0.90: Continue to Layer 2/3 (agentic enrichment)
    
    Legacy conditions (still apply when confidence check passes):
    1. No subscription catalog match found
    2. Labels are ambiguous (e.g., 'retail', 'services' without clear category)
    3. Merchant name is still unclear
    """
    # Primary gate: ntropy_confidence threshold
    if ntropy_confidence is not None:
        if ntropy_confidence >= CONFIDENCE_THRESHOLD:
            print(f"[AgenticQueue] Skipping agentic - Ntropy confidence {ntropy_confidence:.2f} >= {CONFIDENCE_THRESHOLD}")
            return False
    
    if subscription_catalog_match:
        return False
    
    labels = ntropy_result.get("labels", [])
    labels_lower = [l.lower() for l in labels]
    
    has_only_ambiguous_labels = all(
        any(amb in label for amb in AMBIGUOUS_LABELS)
        for label in labels_lower
    ) if labels_lower else True
    
    merchant_name = ntropy_result.get("merchant_clean_name") or ntropy_result.get("merchant", {}).get("name", "")
    merchant_unclear = not merchant_name or len(merchant_name) < 3 or merchant_name.upper() == merchant_name
    
    is_recurring = ntropy_result.get("is_recurring", False)
    if is_recurring and (has_only_ambiguous_labels or merchant_unclear):
        return True
    
    if has_only_ambiguous_labels and merchant_unclear:
        return True
    
    # Also check for low confidence even if labels/merchant are clear
    if ntropy_confidence is not None and ntropy_confidence < 0.5:
        print(f"[AgenticQueue] Low confidence {ntropy_confidence:.2f} - needs agentic enrichment")
        return True
    
    return False


class AgenticEnrichmentQueue:
    """
    Manages parallel agentic enrichment with concurrency control.
    
    Uses asyncio.Semaphore(5) to limit concurrent processing.
    Tracks progress and provides streaming updates.
    """
    
    def __init__(
        self,
        max_concurrent: int = 5,
        enrichment_func: Optional[Callable] = None,
        db_query_func: Optional[Callable] = None,
        db_upsert_func: Optional[Callable] = None
    ):
        """
        Initialize the enrichment queue.
        
        Args:
            max_concurrent: Maximum concurrent enrichment operations (default: 5)
            enrichment_func: Async function to enrich a single transaction
            db_query_func: Function to query database for subscription catalog
            db_upsert_func: Function to upsert enrichment results
        """
        self._semaphore = asyncio.Semaphore(max_concurrent)
        self._queue: asyncio.Queue = asyncio.Queue()
        self._progress = EnrichmentProgress()
        self._results: Dict[str, Dict[str, Any]] = {}
        self._transaction_stages: Dict[str, EnrichmentStage] = {}
        self._enrichment_func = enrichment_func
        self._db_query_func = db_query_func
        self._db_upsert_func = db_upsert_func
        self._running = False
        self._worker_task: Optional[asyncio.Task] = None
        self._lock = asyncio.Lock()
    
    def set_total_transactions(self, total: int):
        """Set the total number of transactions for progress tracking"""
        self._progress.total_transactions = total
    
    def add_transaction(
        self,
        transaction_id: str,
        transaction_data: Dict[str, Any],
        ntropy_result: Optional[Dict[str, Any]] = None
    ) -> bool:
        """
        Add a transaction to the agentic enrichment queue.
        
        Checks idempotency: only queues if enrichmentStage is 'ntropy_done'.
        Updates enrichmentStage to 'agentic_queued'.
        
        Args:
            transaction_id: Unique transaction identifier
            transaction_data: Full transaction data
            ntropy_result: Optional Ntropy enrichment result
            
        Returns:
            True if added to queue, False if skipped (idempotency check)
        """
        # Ensure transaction_id is a string for safe operations
        if not isinstance(transaction_id, str):
            transaction_id = str(transaction_id) if transaction_id else ""
        
        current_stage = self._transaction_stages.get(transaction_id)
        
        # Safe string slicing for logging
        tx_id_short = transaction_id[:16] if len(transaction_id) >= 16 else transaction_id
        
        if current_stage and current_stage not in (
            EnrichmentStage.NTROPY_DONE,
            EnrichmentStage.PENDING
        ):
            print(f"[AgenticQueue] Skipping {tx_id_short}... - already at stage {current_stage}")
            return False
        
        self._transaction_stages[transaction_id] = EnrichmentStage.AGENTIC_QUEUED
        self._progress.agentic_queued += 1
        
        item = {
            "transaction_id": transaction_id,
            "transaction_data": transaction_data,
            "ntropy_result": ntropy_result,
            "queued_at": datetime.utcnow().isoformat()
        }
        
        self._queue.put_nowait(item)
        print(f"[AgenticQueue] Queued transaction {tx_id_short}... (queue size: {self._queue.qsize()})")
        
        return True
    
    def get_progress(self) -> Dict[str, Any]:
        """Get current enrichment progress"""
        return {
            **self._progress.to_dict(),
            "queue_size": self._queue.qsize(),
            "is_running": self._running
        }
    
    def get_transaction_stage(self, transaction_id: str) -> Optional[EnrichmentStage]:
        """Get the enrichment stage for a specific transaction"""
        return self._transaction_stages.get(transaction_id)
    
    def mark_ntropy_complete(self, transaction_id: str):
        """Mark a transaction as completed Ntropy enrichment"""
        self._transaction_stages[transaction_id] = EnrichmentStage.NTROPY_DONE
        self._progress.ntropy_completed += 1
    
    async def _process_single_transaction(
        self,
        item: Dict[str, Any]
    ) -> Dict[str, Any]:
        """
        Process a single transaction with the agentic enrichment pipeline.
        Uses semaphore for concurrency control.
        """
        transaction_id = item["transaction_id"]
        
        async with self._semaphore:
            self._transaction_stages[transaction_id] = EnrichmentStage.AGENTIC_PROCESSING
            
            try:
                if self._enrichment_func:
                    tx_data = item["transaction_data"]
                    ntropy_result = item.get("ntropy_result", {})
                    
                    result = await self._enrichment_func(
                        transaction_id=transaction_id,
                        merchant_name=ntropy_result.get("merchant_clean_name") or tx_data.get("description"),
                        amount_cents=tx_data.get("amount_cents", 0),
                        currency=tx_data.get("currency", "GBP"),
                        transaction_date=tx_data.get("transaction_date"),
                        description=tx_data.get("description") or tx_data.get("original_description"),
                        user_id=tx_data.get("user_id"),
                        nylas_grant_id=tx_data.get("nylas_grant_id"),
                        db_query_func=self._db_query_func,
                        db_upsert_func=self._db_upsert_func
                    )
                    
                    result_dict = {
                        "transaction_id": result.transaction_id,
                        "is_subscription": result.is_subscription,
                        "subscription_product_name": result.subscription_product_name,
                        "subscription_category": result.subscription_category,
                        "ai_confidence": result.ai_confidence,
                        "enrichment_source": result.enrichment_source,
                        "needs_review": result.needs_review,
                        "context_data": result.context_data,
                        "reasoning_trace": result.reasoning_trace,
                        "error": result.error
                    }
                else:
                    result_dict = {
                        "transaction_id": transaction_id,
                        "is_subscription": False,
                        "ai_confidence": 0.0,
                        "needs_review": True,
                        "error": "No enrichment function configured"
                    }
                
                self._transaction_stages[transaction_id] = EnrichmentStage.AGENTIC_DONE
                self._progress.agentic_completed += 1
                
                async with self._lock:
                    self._results[transaction_id] = result_dict
                
                # Safe string slicing for logging
                tx_id_short = str(transaction_id)[:16] if transaction_id else "unknown"
                
                # Persist enrichment results to database
                if self._db_upsert_func:
                    try:
                        await self._db_upsert_func(
                            transaction_id=transaction_id,
                            enrichment_stage=EnrichmentStage.AGENTIC_DONE.value,
                            agentic_confidence=result_dict.get('ai_confidence'),
                            enrichment_source=result_dict.get('enrichment_source'),
                            is_subscription=result_dict.get('is_subscription', False),
                            context_data=result_dict.get('context_data'),
                            reasoning_trace=result_dict.get('reasoning_trace'),
                        )
                        print(f"[AgenticQueue] Persisted {tx_id_short}... to database")
                    except Exception as db_err:
                        print(f"[AgenticQueue] Failed to persist {tx_id_short}...: {db_err}")
                
                print(f"[AgenticQueue] Completed {tx_id_short}... (confidence: {result_dict.get('ai_confidence', 0):.2f})")
                
                return result_dict
                
            except Exception as e:
                tx_id_short = str(transaction_id)[:16] if transaction_id else "unknown"
                print(f"[AgenticQueue] Error processing {tx_id_short}...: {e}")
                self._transaction_stages[transaction_id] = EnrichmentStage.FAILED
                
                error_result = {
                    "transaction_id": transaction_id,
                    "error": str(e),
                    "ai_confidence": 0.0,
                    "needs_review": True
                }
                
                async with self._lock:
                    self._results[transaction_id] = error_result
                
                return error_result
    
    async def _worker(self):
        """Background worker that processes queued transactions"""
        while self._running:
            try:
                item = await asyncio.wait_for(
                    self._queue.get(),
                    timeout=0.5
                )
                
                await self._process_single_transaction(item)
                self._queue.task_done()
                
            except asyncio.TimeoutError:
                continue
            except asyncio.CancelledError:
                break
            except Exception as e:
                print(f"[AgenticQueue] Worker error: {e}")
    
    async def start(self):
        """Start the background worker"""
        if self._running:
            return
        
        self._running = True
        self._progress.start_time = time.time()
        
        num_workers = 5
        self._worker_tasks = [
            asyncio.create_task(self._worker())
            for _ in range(num_workers)
        ]
        
        print(f"[AgenticQueue] Started {num_workers} workers")
    
    async def stop(self):
        """Stop the background workers and wait for completion"""
        self._running = False
        
        if hasattr(self, '_worker_tasks'):
            for task in self._worker_tasks:
                task.cancel()
            
            await asyncio.gather(*self._worker_tasks, return_exceptions=True)
        
        print("[AgenticQueue] Workers stopped")
    
    async def process_queue(self) -> AsyncGenerator[Dict[str, Any], None]:
        """
        Process all queued transactions with streaming progress updates.
        
        Yields progress events as transactions complete.
        """
        await self.start()
        
        try:
            while True:
                progress = self.get_progress()
                yield {
                    "type": "progress",
                    **progress
                }
                
                if (self._queue.empty() and 
                    self._progress.agentic_completed >= self._progress.agentic_queued and
                    self._progress.agentic_queued > 0):
                    break
                
                if self._queue.empty() and self._progress.agentic_queued == 0:
                    await asyncio.sleep(0.1)
                    if self._queue.empty():
                        break
                
                await asyncio.sleep(0.2)
            
            yield {
                "type": "complete",
                "results": list(self._results.values()),
                **self.get_progress()
            }
            
        finally:
            await self.stop()
    
    async def wait_for_completion(self, timeout: float = 300) -> Dict[str, Any]:
        """
        Wait for all queued transactions to complete.
        
        Args:
            timeout: Maximum time to wait in seconds
            
        Returns:
            Final progress and results
        """
        await self.start()
        
        try:
            start = time.time()
            
            while time.time() - start < timeout:
                if (self._queue.empty() and
                    self._progress.agentic_completed >= self._progress.agentic_queued and
                    self._progress.agentic_queued > 0):
                    break
                
                await asyncio.sleep(0.1)
            
            return {
                "success": True,
                "results": list(self._results.values()),
                **self.get_progress()
            }
            
        finally:
            await self.stop()
    
    def get_results(self) -> Dict[str, Dict[str, Any]]:
        """Get all enrichment results by transaction ID"""
        return self._results.copy()


_global_queue: Optional[AgenticEnrichmentQueue] = None


def get_agentic_queue(
    enrichment_func: Optional[Callable] = None,
    db_query_func: Optional[Callable] = None,
    db_upsert_func: Optional[Callable] = None
) -> AgenticEnrichmentQueue:
    """Get or create the global agentic enrichment queue"""
    global _global_queue
    
    if _global_queue is None:
        try:
            from agents.enrichment_agent import enrich_transaction
            enrichment_func = enrichment_func or enrich_transaction
        except ImportError:
            pass
        
        _global_queue = AgenticEnrichmentQueue(
            max_concurrent=5,
            enrichment_func=enrichment_func,
            db_query_func=db_query_func,
            db_upsert_func=db_upsert_func
        )
    
    return _global_queue


def reset_agentic_queue():
    """Reset the global queue (for testing or new sessions)"""
    global _global_queue
    _global_queue = None
