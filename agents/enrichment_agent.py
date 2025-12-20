"""
Enrichment Agent for Resolve 2.0 Agentic Enrichment

A LangGraph workflow that:
1. Takes a transaction_id as input
2. Runs Phase 1 (subscription matching) 
3. Runs Phase 2 (email receipt search if nylas grant exists)
4. Runs Phase 3 (event correlation - placeholder)
5. Merges findings into context_data and reasoning_trace
6. Returns final enrichment result with ai_confidence score
"""

import os
import uuid
from typing import Dict, Any, List, Optional, TypedDict, Annotated
from dataclasses import dataclass, field
from datetime import datetime
import operator

from langgraph.graph import StateGraph, END


@dataclass
class TransactionData:
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


@dataclass
class EnrichmentResult:
    transaction_id: str
    is_subscription: bool = False
    subscription_product_name: Optional[str] = None
    subscription_category: Optional[str] = None
    email_receipt_found: bool = False
    email_receipt_data: Optional[Dict[str, Any]] = None
    events_nearby: List[Dict[str, Any]] = field(default_factory=list)
    context_data: Dict[str, Any] = field(default_factory=dict)
    reasoning_trace: List[str] = field(default_factory=list)
    ai_confidence: float = 0.0
    needs_review: bool = False
    error: Optional[str] = None


class EnrichmentState(TypedDict):
    transaction: Dict[str, Any]
    subscription_result: Optional[Dict[str, Any]]
    email_result: Optional[Dict[str, Any]]
    event_result: Optional[Dict[str, Any]]
    reasoning_trace: Annotated[List[str], operator.add]
    context_data: Dict[str, Any]
    ai_confidence: float
    error: Optional[str]
    db_query_func: Optional[Any]
    db_upsert_func: Optional[Any]


async def subscription_matching_node(state: EnrichmentState) -> EnrichmentState:
    from agents.services.subscription_matcher import match_subscription
    
    transaction = state["transaction"]
    reasoning_trace = ["[Phase 1] Starting subscription matching"]
    
    try:
        merchant = transaction.get("merchant_name") or transaction.get("description", "")
        amount_cents = transaction.get("amount_cents", 0)
        currency = transaction.get("currency", "GBP")
        description = transaction.get("description")
        
        if not merchant or amount_cents <= 0:
            reasoning_trace.append("[Phase 1] Skipping - no merchant or invalid amount")
            return {
                **state,
                "subscription_result": None,
                "reasoning_trace": reasoning_trace
            }
        
        result = await match_subscription(
            merchant=merchant,
            amount_cents=amount_cents,
            currency=currency,
            transaction_description=description,
            db_query_func=state.get("db_query_func"),
            db_upsert_func=state.get("db_upsert_func")
        )
        
        reasoning_trace.extend(result.get("reasoning_trace", []))
        reasoning_trace.append(f"[Phase 1] Complete - is_subscription={result.get('is_subscription')}, confidence={result.get('confidence')}")
        
        return {
            **state,
            "subscription_result": result,
            "reasoning_trace": reasoning_trace
        }
        
    except Exception as e:
        reasoning_trace.append(f"[Phase 1] Error: {str(e)}")
        return {
            **state,
            "subscription_result": None,
            "reasoning_trace": reasoning_trace,
            "error": str(e)
        }


async def email_receipt_node(state: EnrichmentState) -> EnrichmentState:
    from agents.services.nylas_service import find_receipt, get_nylas_service
    from agents.services.email_parser import parse_html_email
    
    transaction = state["transaction"]
    reasoning_trace = ["[Phase 2] Starting email receipt search"]
    
    nylas_grant_id = transaction.get("nylas_grant_id")
    
    if not nylas_grant_id:
        reasoning_trace.append("[Phase 2] Skipping - no Nylas grant available")
        return {
            **state,
            "email_result": None,
            "reasoning_trace": reasoning_trace
        }
    
    try:
        service = get_nylas_service()
        if not service.is_available():
            reasoning_trace.append("[Phase 2] Skipping - Nylas service not available")
            return {
                **state,
                "email_result": None,
                "reasoning_trace": reasoning_trace
            }
        
        merchant = transaction.get("merchant_name") or transaction.get("description", "")
        tx_date = transaction.get("transaction_date")
        
        if not tx_date:
            reasoning_trace.append("[Phase 2] Skipping - no transaction date")
            return {
                **state,
                "email_result": None,
                "reasoning_trace": reasoning_trace
            }
        
        receipt_result = find_receipt(
            grant_id=nylas_grant_id,
            merchant=merchant,
            date=tx_date
        )
        
        if receipt_result.get("found"):
            reasoning_trace.append(f"[Phase 2] Found email receipt: {receipt_result.get('subject')}")
            
            email_data = {
                "found": True,
                "message_id": receipt_result.get("message_id"),
                "subject": receipt_result.get("subject"),
                "sender": receipt_result.get("sender"),
                "date": receipt_result.get("date"),
                "snippet": receipt_result.get("snippet"),
                "has_attachments": receipt_result.get("has_attachments", False)
            }
            
            reasoning_trace.append("[Phase 2] Complete - email receipt found")
            
            return {
                **state,
                "email_result": email_data,
                "reasoning_trace": reasoning_trace
            }
        else:
            reasoning_trace.append("[Phase 2] No matching email receipt found")
            return {
                **state,
                "email_result": {"found": False},
                "reasoning_trace": reasoning_trace
            }
            
    except Exception as e:
        reasoning_trace.append(f"[Phase 2] Error: {str(e)}")
        return {
            **state,
            "email_result": None,
            "reasoning_trace": reasoning_trace
        }


async def event_correlation_node(state: EnrichmentState) -> EnrichmentState:
    from agents.tools.events import find_events_near_transaction
    
    transaction = state["transaction"]
    reasoning_trace = ["[Phase 3] Starting event correlation"]
    
    lat = transaction.get("location_lat")
    long = transaction.get("location_long")
    tx_date = transaction.get("transaction_date")
    
    if lat is None or long is None:
        reasoning_trace.append("[Phase 3] Skipping - no location data")
        return {
            **state,
            "event_result": None,
            "reasoning_trace": reasoning_trace
        }
    
    if not tx_date:
        reasoning_trace.append("[Phase 3] Skipping - no transaction date")
        return {
            **state,
            "event_result": None,
            "reasoning_trace": reasoning_trace
        }
    
    try:
        result = find_events_near_transaction(
            lat=lat,
            long=long,
            date=tx_date
        )
        
        reasoning_trace.append(f"[Phase 3] {result.get('reasoning', 'No result')}")
        
        return {
            **state,
            "event_result": result,
            "reasoning_trace": reasoning_trace
        }
        
    except Exception as e:
        reasoning_trace.append(f"[Phase 3] Error: {str(e)}")
        return {
            **state,
            "event_result": None,
            "reasoning_trace": reasoning_trace
        }


async def merge_results_node(state: EnrichmentState) -> EnrichmentState:
    reasoning_trace = ["[Merge] Combining enrichment results"]
    
    subscription_result = state.get("subscription_result")
    email_result = state.get("email_result")
    event_result = state.get("event_result")
    
    context_data = {}
    confidence_scores = []
    
    if subscription_result:
        is_subscription = subscription_result.get("is_subscription", False)
        sub_confidence = subscription_result.get("confidence", 0.0)
        
        context_data["subscription"] = {
            "is_subscription": is_subscription,
            "product_name": subscription_result.get("product_name"),
            "category": subscription_result.get("category"),
            "recurrence": subscription_result.get("recurrence"),
            "confidence": sub_confidence
        }
        
        if is_subscription:
            confidence_scores.append(sub_confidence)
        
        reasoning_trace.append(f"[Merge] Subscription: is_subscription={is_subscription}, confidence={sub_confidence}")
    
    if email_result and email_result.get("found"):
        context_data["email_receipt"] = {
            "found": True,
            "subject": email_result.get("subject"),
            "sender": email_result.get("sender"),
            "date": email_result.get("date"),
            "has_attachments": email_result.get("has_attachments")
        }
        confidence_scores.append(0.85)
        reasoning_trace.append("[Merge] Email receipt found - adding to context")
    
    if event_result and event_result.get("events"):
        context_data["events"] = event_result.get("events", [])
        event_confidence = event_result.get("confidence", 0.0)
        if event_confidence > 0:
            confidence_scores.append(event_confidence)
        reasoning_trace.append(f"[Merge] Events: {len(event_result.get('events', []))} nearby events")
    
    if confidence_scores:
        ai_confidence = sum(confidence_scores) / len(confidence_scores)
    else:
        ai_confidence = 0.0
    
    needs_review = ai_confidence < 0.8
    if needs_review:
        context_data["needs_review"] = True
        context_data["review_reason"] = "Low AI confidence score"
        reasoning_trace.append(f"[Merge] Flagged for review - confidence {ai_confidence:.2f} < 0.8 threshold")
    
    reasoning_trace.append(f"[Merge] Final confidence: {ai_confidence:.2f}")
    
    return {
        **state,
        "context_data": context_data,
        "ai_confidence": ai_confidence,
        "reasoning_trace": reasoning_trace
    }


def create_enrichment_graph() -> StateGraph:
    workflow = StateGraph(EnrichmentState)
    
    workflow.add_node("subscription_matching", subscription_matching_node)
    workflow.add_node("email_receipt", email_receipt_node)
    workflow.add_node("event_correlation", event_correlation_node)
    workflow.add_node("merge_results", merge_results_node)
    
    workflow.set_entry_point("subscription_matching")
    workflow.add_edge("subscription_matching", "email_receipt")
    workflow.add_edge("email_receipt", "event_correlation")
    workflow.add_edge("event_correlation", "merge_results")
    workflow.add_edge("merge_results", END)
    
    return workflow.compile()


_enrichment_graph = None

def get_enrichment_graph():
    global _enrichment_graph
    if _enrichment_graph is None:
        _enrichment_graph = create_enrichment_graph()
    return _enrichment_graph


async def enrich_transaction(
    transaction_id: str,
    merchant_name: Optional[str] = None,
    amount_cents: int = 0,
    currency: str = "GBP",
    transaction_date: Optional[str] = None,
    description: Optional[str] = None,
    user_id: Optional[str] = None,
    nylas_grant_id: Optional[str] = None,
    location_lat: Optional[float] = None,
    location_long: Optional[float] = None,
    db_query_func=None,
    db_upsert_func=None
) -> EnrichmentResult:
    graph = get_enrichment_graph()
    
    initial_state: EnrichmentState = {
        "transaction": {
            "transaction_id": transaction_id,
            "merchant_name": merchant_name,
            "amount_cents": amount_cents,
            "currency": currency,
            "transaction_date": transaction_date,
            "description": description,
            "user_id": user_id,
            "nylas_grant_id": nylas_grant_id,
            "location_lat": location_lat,
            "location_long": location_long
        },
        "subscription_result": None,
        "email_result": None,
        "event_result": None,
        "reasoning_trace": [],
        "context_data": {},
        "ai_confidence": 0.0,
        "error": None,
        "db_query_func": db_query_func,
        "db_upsert_func": db_upsert_func
    }
    
    try:
        final_state = await graph.ainvoke(initial_state)
        
        subscription_result = final_state.get("subscription_result") or {}
        email_result = final_state.get("email_result") or {}
        event_result = final_state.get("event_result") or {}
        
        return EnrichmentResult(
            transaction_id=transaction_id,
            is_subscription=subscription_result.get("is_subscription", False),
            subscription_product_name=subscription_result.get("product_name"),
            subscription_category=subscription_result.get("category"),
            email_receipt_found=email_result.get("found", False),
            email_receipt_data=email_result if email_result.get("found") else None,
            events_nearby=event_result.get("events", []) if event_result else [],
            context_data=final_state.get("context_data", {}),
            reasoning_trace=final_state.get("reasoning_trace", []),
            ai_confidence=final_state.get("ai_confidence", 0.0),
            needs_review=final_state.get("ai_confidence", 0.0) < 0.8,
            error=final_state.get("error")
        )
        
    except Exception as e:
        return EnrichmentResult(
            transaction_id=transaction_id,
            reasoning_trace=[f"Fatal error in enrichment pipeline: {str(e)}"],
            ai_confidence=0.0,
            needs_review=True,
            error=str(e)
        )


_enrichment_jobs: Dict[str, Dict[str, Any]] = {}

def create_enrichment_job(transaction_ids: List[str]) -> str:
    job_id = str(uuid.uuid4())
    _enrichment_jobs[job_id] = {
        "status": "pending",
        "transaction_ids": transaction_ids,
        "completed": 0,
        "total": len(transaction_ids),
        "results": [],
        "created_at": datetime.utcnow().isoformat(),
        "started_at": None,
        "completed_at": None
    }
    return job_id


def get_enrichment_job(job_id: str) -> Optional[Dict[str, Any]]:
    return _enrichment_jobs.get(job_id)


def update_enrichment_job(job_id: str, updates: Dict[str, Any]):
    if job_id in _enrichment_jobs:
        _enrichment_jobs[job_id].update(updates)


async def run_enrichment_pipeline(
    job_id: str,
    transactions: List[Dict[str, Any]],
    db_query_func=None,
    db_upsert_func=None
):
    update_enrichment_job(job_id, {
        "status": "running",
        "started_at": datetime.utcnow().isoformat()
    })
    
    results = []
    
    for i, tx in enumerate(transactions):
        try:
            result = await enrich_transaction(
                transaction_id=tx.get("transaction_id", str(i)),
                merchant_name=tx.get("merchant_name") or tx.get("merchant_clean_name"),
                amount_cents=tx.get("amount_cents", 0),
                currency=tx.get("currency", "GBP"),
                transaction_date=tx.get("transaction_date"),
                description=tx.get("description") or tx.get("original_description"),
                user_id=tx.get("user_id"),
                nylas_grant_id=tx.get("nylas_grant_id"),
                location_lat=tx.get("location_lat"),
                location_long=tx.get("location_long"),
                db_query_func=db_query_func,
                db_upsert_func=db_upsert_func
            )
            
            results.append({
                "transaction_id": result.transaction_id,
                "is_subscription": result.is_subscription,
                "subscription_product_name": result.subscription_product_name,
                "subscription_category": result.subscription_category,
                "email_receipt_found": result.email_receipt_found,
                "events_nearby": result.events_nearby,
                "context_data": result.context_data,
                "reasoning_trace": result.reasoning_trace,
                "ai_confidence": result.ai_confidence,
                "needs_review": result.needs_review,
                "error": result.error
            })
            
        except Exception as e:
            results.append({
                "transaction_id": tx.get("transaction_id", str(i)),
                "error": str(e),
                "ai_confidence": 0.0,
                "needs_review": True
            })
        
        update_enrichment_job(job_id, {
            "completed": i + 1,
            "results": results
        })
    
    update_enrichment_job(job_id, {
        "status": "completed",
        "completed_at": datetime.utcnow().isoformat()
    })
