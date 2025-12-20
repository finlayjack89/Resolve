"""
Subscription Matcher Service for Resolve 2.0 Agentic Enrichment

This service:
1. First checks subscription_catalog DB for exact price match (merchant + amountCents)
2. If no match, uses Serper search to find pricing info
3. Uses Claude (via langchain-anthropic) to reason about the search results
4. Returns subscription match result with confidence score
5. If high confidence (>=0.9), upserts to subscription_catalog for future cache hits
"""

import os
from typing import Optional, List
from dataclasses import dataclass, field
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

from agents.tools.search import search_subscription_pricing, verify_subscription_exists


@dataclass
class SubscriptionMatchResult:
    is_subscription: bool
    product_name: str
    confidence: float
    reasoning_trace: List[str] = field(default_factory=list)
    merchant_name: Optional[str] = None
    amount_cents: Optional[int] = None
    recurrence: Optional[str] = None
    category: Optional[str] = None


class SubscriptionMatcher:
    def __init__(self, db_query_func=None, db_upsert_func=None):
        self.db_query_func = db_query_func
        self.db_upsert_func = db_upsert_func
        self.llm = None
        self._init_llm()
    
    def _init_llm(self):
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if api_key:
            self.llm = ChatAnthropic(
                model="claude-sonnet-4-20250514",
                api_key=api_key,
                max_tokens=1024,
                temperature=0.0
            )
    
    async def match_subscription(
        self,
        merchant: str,
        amount_cents: int,
        currency: str = "GBP",
        transaction_description: Optional[str] = None
    ) -> SubscriptionMatchResult:
        reasoning_trace = []
        
        reasoning_trace.append(f"Starting subscription match for merchant='{merchant}', amount={amount_cents} {currency}")
        
        db_match = await self._check_db_catalog(merchant, amount_cents, currency, reasoning_trace)
        if db_match:
            return db_match
        
        search_result = await self._search_and_analyze(
            merchant, amount_cents, currency, transaction_description, reasoning_trace
        )
        
        if search_result.is_subscription and search_result.confidence >= 0.9:
            await self._upsert_to_catalog(search_result, reasoning_trace)
        
        return search_result
    
    async def _check_db_catalog(
        self,
        merchant: str,
        amount_cents: int,
        currency: str,
        reasoning_trace: List[str]
    ) -> Optional[SubscriptionMatchResult]:
        if not self.db_query_func:
            reasoning_trace.append("No DB query function provided, skipping catalog lookup")
            return None
        
        try:
            reasoning_trace.append(f"Checking subscription_catalog for merchant='{merchant}', amount={amount_cents}")
            
            catalog_entries = await self.db_query_func(merchant)
            
            if not catalog_entries:
                reasoning_trace.append("No entries found in subscription_catalog for this merchant")
                return None
            
            for entry in catalog_entries:
                if entry.get("amount_cents") == amount_cents and entry.get("currency", "GBP") == currency:
                    reasoning_trace.append(f"EXACT MATCH found: {entry.get('product_name')} at {amount_cents} {currency}")
                    return SubscriptionMatchResult(
                        is_subscription=True,
                        product_name=entry.get("product_name", ""),
                        confidence=entry.get("confidence_score", 1.0),
                        reasoning_trace=reasoning_trace,
                        merchant_name=entry.get("merchant_name"),
                        amount_cents=amount_cents,
                        recurrence=entry.get("recurrence", "Monthly"),
                        category=entry.get("category")
                    )
            
            close_matches = [
                e for e in catalog_entries 
                if abs(e.get("amount_cents", 0) - amount_cents) <= 100
            ]
            if close_matches:
                reasoning_trace.append(f"Found {len(close_matches)} close price matches (within £1), but no exact match")
            else:
                reasoning_trace.append(f"Found {len(catalog_entries)} entries for merchant, but no price match")
            
            return None
            
        except Exception as e:
            reasoning_trace.append(f"DB lookup error: {str(e)}")
            return None
    
    async def _search_and_analyze(
        self,
        merchant: str,
        amount_cents: int,
        currency: str,
        transaction_description: Optional[str],
        reasoning_trace: List[str]
    ) -> SubscriptionMatchResult:
        amount_display = amount_cents / 100
        
        reasoning_trace.append(f"No DB match, searching web for {merchant} pricing info")
        
        search_results = search_subscription_pricing(merchant, amount_display, currency)
        
        if search_results.get("error"):
            reasoning_trace.append(f"Search error: {search_results.get('error')}")
            return SubscriptionMatchResult(
                is_subscription=False,
                product_name="",
                confidence=0.0,
                reasoning_trace=reasoning_trace
            )
        
        reasoning_trace.append(f"Got search results, analyzing with Claude")
        
        if not self.llm:
            reasoning_trace.append("No LLM available, cannot analyze search results")
            return SubscriptionMatchResult(
                is_subscription=False,
                product_name="",
                confidence=0.3,
                reasoning_trace=reasoning_trace
            )
        
        return await self._analyze_with_llm(
            merchant, amount_cents, currency, transaction_description,
            search_results, reasoning_trace
        )
    
    async def _analyze_with_llm(
        self,
        merchant: str,
        amount_cents: int,
        currency: str,
        transaction_description: Optional[str],
        search_results: dict,
        reasoning_trace: List[str]
    ) -> SubscriptionMatchResult:
        amount_display = amount_cents / 100
        
        organic_results = search_results.get("organic", [])[:5]
        knowledge_graph = search_results.get("knowledgeGraph", {})
        
        search_summary = []
        for r in organic_results:
            search_summary.append(f"- {r.get('title', '')}: {r.get('snippet', '')}")
        
        if knowledge_graph:
            search_summary.append(f"Knowledge Graph: {knowledge_graph.get('title', '')} - {knowledge_graph.get('description', '')}")
        
        system_prompt = """You are a subscription pricing analyst. Your job is to determine if a bank transaction matches a known subscription service.

Analyze the search results and determine:
1. Is this merchant likely a subscription service?
2. If so, what product/tier does this price point match?
3. How confident are you in this match? (0.0 to 1.0)

Respond in this exact JSON format:
{
    "is_subscription": true/false,
    "product_name": "Product name or tier",
    "confidence": 0.85,
    "recurrence": "Monthly/Weekly/Yearly/Quarterly",
    "category": "Entertainment/Utility/Health/Food/Transport/Finance/Other",
    "reasoning": "Brief explanation of your analysis"
}"""

        user_prompt = f"""Transaction Details:
- Merchant: {merchant}
- Amount: {currency} {amount_display:.2f}
- Description: {transaction_description or 'N/A'}

Search Results:
{chr(10).join(search_summary)}

Based on these search results, determine if this transaction is a subscription payment and identify the specific product/tier."""

        try:
            response = await self.llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt)
            ])
            
            response_text = response.content
            reasoning_trace.append(f"LLM response: {response_text[:200]}...")
            
            import json
            try:
                if "```json" in response_text:
                    json_str = response_text.split("```json")[1].split("```")[0].strip()
                elif "```" in response_text:
                    json_str = response_text.split("```")[1].split("```")[0].strip()
                else:
                    json_str = response_text.strip()
                
                result = json.loads(json_str)
                
                reasoning_trace.append(f"LLM analysis: {result.get('reasoning', 'No reasoning provided')}")
                
                return SubscriptionMatchResult(
                    is_subscription=result.get("is_subscription", False),
                    product_name=result.get("product_name", ""),
                    confidence=float(result.get("confidence", 0.0)),
                    reasoning_trace=reasoning_trace,
                    merchant_name=merchant,
                    amount_cents=amount_cents,
                    recurrence=result.get("recurrence", "Monthly"),
                    category=result.get("category")
                )
                
            except json.JSONDecodeError as e:
                reasoning_trace.append(f"Failed to parse LLM response as JSON: {e}")
                return SubscriptionMatchResult(
                    is_subscription=False,
                    product_name="",
                    confidence=0.2,
                    reasoning_trace=reasoning_trace
                )
                
        except Exception as e:
            reasoning_trace.append(f"LLM analysis error: {str(e)}")
            return SubscriptionMatchResult(
                is_subscription=False,
                product_name="",
                confidence=0.0,
                reasoning_trace=reasoning_trace
            )
    
    async def _upsert_to_catalog(
        self,
        result: SubscriptionMatchResult,
        reasoning_trace: List[str]
    ):
        if not self.db_upsert_func:
            reasoning_trace.append("No DB upsert function provided, skipping catalog update")
            return
        
        if not result.merchant_name or not result.product_name:
            reasoning_trace.append("Missing merchant or product name, skipping catalog upsert")
            return
        
        try:
            await self.db_upsert_func({
                "merchant_name": result.merchant_name,
                "product_name": result.product_name,
                "amount_cents": result.amount_cents,
                "currency": "GBP",
                "recurrence": result.recurrence or "Monthly",
                "category": result.category,
                "confidence_score": result.confidence
            })
            reasoning_trace.append(f"Successfully upserted to subscription_catalog: {result.merchant_name} - {result.product_name}")
        except Exception as e:
            reasoning_trace.append(f"Failed to upsert to catalog: {str(e)}")


async def match_subscription(
    merchant: str,
    amount_cents: int,
    currency: str = "GBP",
    transaction_description: Optional[str] = None,
    db_query_func=None,
    db_upsert_func=None
) -> dict:
    matcher = SubscriptionMatcher(
        db_query_func=db_query_func,
        db_upsert_func=db_upsert_func
    )
    result = await matcher.match_subscription(
        merchant=merchant,
        amount_cents=amount_cents,
        currency=currency,
        transaction_description=transaction_description
    )
    return {
        "is_subscription": result.is_subscription,
        "product_name": result.product_name,
        "confidence": result.confidence,
        "reasoning_trace": result.reasoning_trace,
        "merchant_name": result.merchant_name,
        "amount_cents": result.amount_cents,
        "recurrence": result.recurrence,
        "category": result.category
    }
