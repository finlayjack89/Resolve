# agents/graph.py - Subscription Detective LangGraph Workflow
# Implements the state machine: CheckDB -> SearchWeb -> UpdateDB

import os
from typing import TypedDict, Optional, List, Dict, Any, Annotated
from pydantic import BaseModel, Field

from langgraph.graph import StateGraph, END
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from agents.tools import (
    search_subscription_costs,
    SubscriptionPlan,
    SubscriptionSearchResult,
    check_subscription_catalog,
    update_subscription_catalog
)


class TransactionInput(BaseModel):
    """Input transaction to classify"""
    transaction_id: str
    merchant_name: str
    amount_cents: int
    currency: str = "GBP"
    description: Optional[str] = None


class SubscriptionClassification(BaseModel):
    """Result of subscription classification"""
    transaction_id: str
    is_subscription: bool
    subscription_id: Optional[str] = None
    product_name: Optional[str] = None
    confidence: float = 0.0
    reasoning_trace: List[Dict[str, str]] = Field(default_factory=list)
    matched_plan: Optional[SubscriptionPlan] = None


class AgentState(TypedDict):
    """State passed between nodes in the graph"""
    transaction: TransactionInput
    catalog_match: Optional[Dict[str, Any]]
    search_result: Optional[SubscriptionSearchResult]
    classification: Optional[SubscriptionClassification]
    reasoning_trace: List[Dict[str, str]]
    db_connection: Optional[Any]


def check_catalog_node(state: AgentState) -> AgentState:
    """
    Node 1: Check the subscription_catalog for an exact match.
    
    This is the first step - deterministic lookup in our database
    before triggering any expensive web research.
    """
    transaction = state["transaction"]
    db_conn = state.get("db_connection")
    
    trace_step = {
        "step": "Subscription Check",
        "detail": f"Checking catalog for {transaction.merchant_name} at {transaction.amount_cents/100:.2f} {transaction.currency}"
    }
    
    catalog_match = check_subscription_catalog(
        merchant_name=transaction.merchant_name,
        amount_cents=transaction.amount_cents,
        db_connection=db_conn
    )
    
    if catalog_match:
        trace_step["detail"] += f" - FOUND: {catalog_match.get('product_name', 'Unknown')}"
    else:
        trace_step["detail"] += " - No match found, will search web"
    
    state["catalog_match"] = catalog_match
    state["reasoning_trace"].append(trace_step)
    
    return state


def web_research_node(state: AgentState) -> AgentState:
    """
    Node 2: Search the web for subscription pricing information.
    
    This node is triggered only if no catalog match was found.
    Uses Serper API to search for subscription plans.
    """
    transaction = state["transaction"]
    
    trace_step = {
        "step": "Web Research",
        "detail": f"Searching for {transaction.merchant_name} subscription plans"
    }
    
    search_result = search_subscription_costs(
        merchant_name=transaction.merchant_name,
        currency=transaction.currency,
        country="UK"
    )
    
    if search_result.error:
        trace_step["detail"] += f" - Error: {search_result.error}"
    elif search_result.plans_found:
        plan_names = [p.product_name for p in search_result.plans_found[:3]]
        trace_step["detail"] += f" - Found {len(search_result.plans_found)} plans: {', '.join(plan_names)}"
    else:
        trace_step["detail"] += " - No plans found"
    
    state["search_result"] = search_result
    state["reasoning_trace"].append(trace_step)
    
    return state


def update_catalog_node(state: AgentState) -> AgentState:
    """
    Node 3: Update the subscription catalog with discovered plans.
    
    If web research found matching plans, add them to the catalog
    for future lookups.
    """
    search_result = state.get("search_result")
    transaction = state["transaction"]
    
    if not search_result or not search_result.plans_found:
        return state
    
    trace_step = {
        "step": "Catalog Update",
        "detail": "Saving discovered plans to catalog"
    }
    
    amount_gbp = transaction.amount_cents / 100
    matched_plan = None
    best_match_diff = float('inf')
    
    for plan in search_result.plans_found:
        diff = abs(plan.cost - amount_gbp)
        if diff < best_match_diff and diff < 0.50:
            best_match_diff = diff
            matched_plan = plan
    
    if matched_plan:
        trace_step["detail"] += f" - Best match: {matched_plan.product_name} ({matched_plan.cost:.2f})"
        
        success = update_subscription_catalog(
            plan=matched_plan,
            is_verified=False,
            db_connection=None
        )
        if success:
            trace_step["detail"] += " (saved)"
        else:
            trace_step["detail"] += " (DB save skipped - no connection)"
    else:
        trace_step["detail"] += " - No exact price match found"
    
    state["reasoning_trace"].append(trace_step)
    
    return state


def classify_node(state: AgentState) -> AgentState:
    """
    Final node: Produce the classification result.
    
    Combines all gathered evidence to determine if this
    transaction is a subscription.
    """
    transaction = state["transaction"]
    catalog_match = state.get("catalog_match")
    search_result = state.get("search_result")
    
    is_subscription = False
    subscription_id = None
    product_name = None
    confidence = 0.0
    matched_plan = None
    
    if catalog_match:
        is_subscription = True
        subscription_id = catalog_match.get("id")
        product_name = catalog_match.get("product_name")
        confidence = 0.95
    elif search_result and search_result.plans_found:
        amount_gbp = transaction.amount_cents / 100
        
        for plan in search_result.plans_found:
            diff = abs(plan.cost - amount_gbp)
            if diff < 0.50:
                is_subscription = True
                product_name = plan.product_name
                confidence = plan.confidence
                matched_plan = plan
                break
    
    trace_step = {
        "step": "Classification",
        "detail": f"{'Subscription' if is_subscription else 'One-off'} (confidence: {confidence:.0%})"
    }
    if product_name:
        trace_step["detail"] += f" - {product_name}"
    
    state["reasoning_trace"].append(trace_step)
    
    classification = SubscriptionClassification(
        transaction_id=transaction.transaction_id,
        is_subscription=is_subscription,
        subscription_id=subscription_id,
        product_name=product_name,
        confidence=confidence,
        reasoning_trace=state["reasoning_trace"],
        matched_plan=matched_plan
    )
    
    state["classification"] = classification
    
    return state


def should_search_web(state: AgentState) -> str:
    """
    Conditional edge: decide whether to search the web.
    
    If we found a catalog match, skip web research.
    """
    if state.get("catalog_match"):
        return "skip_search"
    return "search"


def build_subscription_detective_graph():
    """
    Build the LangGraph workflow for subscription detection.
    
    Graph structure:
    check_catalog -> (if no match) -> web_research -> update_catalog -> classify
                  -> (if match) -> classify
    """
    workflow = StateGraph(AgentState)
    
    workflow.add_node("check_catalog", check_catalog_node)
    workflow.add_node("web_research", web_research_node)
    workflow.add_node("update_catalog", update_catalog_node)
    workflow.add_node("classify", classify_node)
    
    workflow.set_entry_point("check_catalog")
    
    workflow.add_conditional_edges(
        "check_catalog",
        should_search_web,
        {
            "search": "web_research",
            "skip_search": "classify"
        }
    )
    
    workflow.add_edge("web_research", "update_catalog")
    workflow.add_edge("update_catalog", "classify")
    workflow.add_edge("classify", END)
    
    return workflow.compile()


subscription_detective = build_subscription_detective_graph()


async def classify_subscription(
    transaction: TransactionInput,
    db_connection: Any = None
) -> SubscriptionClassification:
    """
    Main entry point for subscription classification.
    
    This function runs the LangGraph workflow to determine
    if a transaction is a subscription.
    
    Args:
        transaction: The transaction to classify
        db_connection: Optional database connection for catalog lookup/update
    
    Returns:
        SubscriptionClassification with the result
    """
    bank_data_trace = {
        "step": "Bank Data",
        "detail": f"Merchant: {transaction.merchant_name}, Amount: {transaction.amount_cents/100:.2f} {transaction.currency}"
    }
    if transaction.description:
        bank_data_trace["detail"] += f", Desc: {transaction.description}"
    
    initial_state: AgentState = {
        "transaction": transaction,
        "catalog_match": None,
        "search_result": None,
        "classification": None,
        "reasoning_trace": [bank_data_trace],
        "db_connection": db_connection
    }
    
    final_state = await subscription_detective.ainvoke(initial_state)
    
    return final_state["classification"]
