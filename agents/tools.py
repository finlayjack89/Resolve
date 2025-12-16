# agents/tools.py - Subscription Detective Tools
# Uses Serper API for web research to discover subscription pricing

import os
import json
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

SERPER_AVAILABLE = False
GoogleSearch = None

try:
    from serpapi import GoogleSearch as _GoogleSearch
    GoogleSearch = _GoogleSearch
    SERPER_AVAILABLE = True
except ImportError:
    print("[SubscriptionTools] Warning: serpapi not available")


class SubscriptionPlan(BaseModel):
    """A discovered subscription plan from web research"""
    product_name: str = Field(description="Name of the subscription product")
    cost: float = Field(description="Monthly cost in GBP")
    currency: str = Field(default="GBP")
    recurrence_period: str = Field(default="Monthly")
    source_url: Optional[str] = Field(default=None, description="URL where this was found")
    confidence: float = Field(default=0.5, description="Confidence score 0-1")


class SubscriptionSearchResult(BaseModel):
    """Result of a subscription search operation"""
    merchant_name: str
    plans_found: List[SubscriptionPlan] = Field(default_factory=list)
    search_query: str
    raw_snippets: List[str] = Field(default_factory=list)
    error: Optional[str] = None


def search_subscription_costs(
    merchant_name: str,
    currency: str = "GBP",
    country: str = "UK"
) -> SubscriptionSearchResult:
    """
    Search for subscription tiers for a given merchant using Serper API.
    
    This is the core research tool for the Subscription Detective agent.
    It queries Google to find pricing information for subscription services.
    
    Args:
        merchant_name: The merchant to research (e.g., "Uber", "Netflix")
        currency: The currency to search for (default: GBP)
        country: The country context (default: UK)
    
    Returns:
        SubscriptionSearchResult with discovered plans or error
    """
    api_key = os.environ.get("SERPER_API_KEY")
    
    if not api_key:
        return SubscriptionSearchResult(
            merchant_name=merchant_name,
            search_query="",
            error="SERPER_API_KEY not configured"
        )
    
    if not SERPER_AVAILABLE or GoogleSearch is None:
        return SubscriptionSearchResult(
            merchant_name=merchant_name,
            search_query="",
            error="serpapi library not available"
        )
    
    search_query = f"{merchant_name} subscription plans pricing {currency} {country}"
    
    try:
        search = GoogleSearch({  # type: ignore
            "q": search_query,
            "location": "United Kingdom",
            "hl": "en",
            "gl": "uk",
            "api_key": api_key,
            "num": 5
        })
        
        results = search.get_dict()
        
        plans_found: List[SubscriptionPlan] = []
        raw_snippets: List[str] = []
        
        organic_results = results.get("organic_results", [])
        
        for result in organic_results:
            snippet = result.get("snippet", "")
            link = result.get("link", "")
            raw_snippets.append(snippet)
            
            extracted_plans = _extract_plans_from_snippet(
                merchant_name=merchant_name,
                snippet=snippet,
                source_url=link,
                currency=currency
            )
            plans_found.extend(extracted_plans)
        
        answer_box = results.get("answer_box", {})
        if answer_box:
            answer_snippet = answer_box.get("snippet", "") or answer_box.get("answer", "")
            if answer_snippet:
                raw_snippets.insert(0, answer_snippet)
                extracted_plans = _extract_plans_from_snippet(
                    merchant_name=merchant_name,
                    snippet=answer_snippet,
                    source_url=None,
                    currency=currency
                )
                for plan in extracted_plans:
                    plan.confidence = min(plan.confidence + 0.2, 1.0)
                plans_found.extend(extracted_plans)
        
        return SubscriptionSearchResult(
            merchant_name=merchant_name,
            plans_found=plans_found,
            search_query=search_query,
            raw_snippets=raw_snippets
        )
        
    except Exception as e:
        return SubscriptionSearchResult(
            merchant_name=merchant_name,
            search_query=search_query,
            error=f"Search failed: {str(e)}"
        )


def _extract_plans_from_snippet(
    merchant_name: str,
    snippet: str,
    source_url: Optional[str],
    currency: str = "GBP"
) -> List[SubscriptionPlan]:
    """
    Extract subscription plan information from a search snippet.
    Uses pattern matching to find prices and plan names.
    """
    import re
    
    plans: List[SubscriptionPlan] = []
    
    currency_symbols = {"GBP": "£", "USD": "$", "EUR": "€"}
    symbol = currency_symbols.get(currency, "£")
    
    price_pattern = rf'{re.escape(symbol)}(\d+(?:\.\d{{2}})?)'
    prices = re.findall(price_pattern, snippet)
    
    common_plan_names = [
        "Basic", "Standard", "Premium", "Pro", "Plus", "One", 
        "Lite", "Family", "Individual", "Student", "Duo"
    ]
    
    found_plan_names = []
    snippet_lower = snippet.lower()
    for plan_name in common_plan_names:
        if plan_name.lower() in snippet_lower:
            found_plan_names.append(plan_name)
    
    if prices:
        for i, price in enumerate(prices[:3]):
            try:
                cost = float(price)
                if cost > 0 and cost < 500:
                    plan_name = f"{merchant_name}"
                    if i < len(found_plan_names):
                        plan_name = f"{merchant_name} {found_plan_names[i]}"
                    elif len(prices) > 1:
                        plan_name = f"{merchant_name} Plan {i+1}"
                    
                    plans.append(SubscriptionPlan(
                        product_name=plan_name,
                        cost=cost,
                        currency=currency,
                        recurrence_period="Monthly",
                        source_url=source_url,
                        confidence=0.6 if len(found_plan_names) > 0 else 0.4
                    ))
            except ValueError:
                continue
    
    return plans


def get_db_connection():
    """Get a database connection using DATABASE_URL environment variable."""
    import psycopg2
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        return None
    try:
        return psycopg2.connect(database_url)
    except Exception as e:
        print(f"[SubscriptionTools] DB connection error: {e}")
        return None


def check_subscription_catalog(
    merchant_name: str,
    amount_cents: int,
    db_connection: Any = None
) -> Optional[Dict[str, Any]]:
    """
    Check the subscription_catalog table for a matching subscription.
    
    Args:
        merchant_name: The merchant name to check
        amount_cents: The transaction amount in cents
        db_connection: Database connection (if None, uses DATABASE_URL)
    
    Returns:
        Matching subscription record or None
    """
    conn = db_connection or get_db_connection()
    if conn is None:
        return None
    
    try:
        amount_gbp = amount_cents / 100.0
        tolerance = 0.50
        
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id, merchant_name, product_name, cost_pattern, currency, 
                       recurrence_period, is_verified, category
                FROM subscription_catalog
                WHERE LOWER(merchant_name) LIKE LOWER(%s)
                  AND ABS(cost_pattern - %s) <= %s
                ORDER BY is_verified DESC, ABS(cost_pattern - %s) ASC
                LIMIT 1
            """, (f"%{merchant_name}%", amount_gbp, tolerance, amount_gbp))
            
            row = cur.fetchone()
            if row:
                return {
                    "id": str(row[0]),
                    "merchant_name": row[1],
                    "product_name": row[2],
                    "cost_pattern": float(row[3]) if row[3] else None,
                    "currency": row[4],
                    "recurrence_period": row[5],
                    "is_verified": row[6],
                    "category": row[7],
                }
        return None
    except Exception as e:
        print(f"[SubscriptionTools] Catalog check error: {e}")
        return None
    finally:
        if db_connection is None and conn:
            conn.close()


def update_subscription_catalog(
    plan: SubscriptionPlan,
    is_verified: bool = False,
    db_connection: Any = None
) -> bool:
    """
    Insert or update a subscription plan in the catalog.
    
    Args:
        plan: The subscription plan to save
        is_verified: Whether this plan has been human-verified
        db_connection: Database connection
    
    Returns:
        True if successful, False otherwise
    """
    conn = db_connection or get_db_connection()
    if conn is None:
        return False
    
    try:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT id FROM subscription_catalog
                WHERE LOWER(merchant_name) = LOWER(%s) 
                  AND LOWER(product_name) = LOWER(%s)
            """, (plan.product_name.split()[0], plan.product_name))
            
            existing = cur.fetchone()
            
            if existing:
                cur.execute("""
                    UPDATE subscription_catalog
                    SET cost_pattern = %s, currency = %s, recurrence_period = %s,
                        updated_at = NOW()
                    WHERE id = %s
                """, (plan.cost, plan.currency, plan.recurrence_period, existing[0]))
            else:
                merchant_name = plan.product_name.split()[0] if " " in plan.product_name else plan.product_name
                cur.execute("""
                    INSERT INTO subscription_catalog 
                    (merchant_name, product_name, cost_pattern, currency, recurrence_period, is_verified)
                    VALUES (%s, %s, %s, %s, %s, %s)
                """, (merchant_name, plan.product_name, plan.cost, plan.currency, 
                      plan.recurrence_period, is_verified))
            
            conn.commit()
            return True
    except Exception as e:
        print(f"[SubscriptionTools] Catalog update error: {e}")
        if conn:
            conn.rollback()
        return False
    finally:
        if db_connection is None and conn:
            conn.close()
