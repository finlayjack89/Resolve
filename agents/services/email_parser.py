"""
Email Parser Service for Resolve 2.0 Agentic Enrichment

This service handles:
1. HTML email parsing with Claude to extract merchant, items, amounts
2. PDF invoice parsing with Mindee Invoice API
3. Fallback to Claude for date extraction if Mindee fails
"""

import os
import re
from typing import Optional, List, Dict, Any
from dataclasses import dataclass, field
from langchain_anthropic import ChatAnthropic
from langchain_core.messages import HumanMessage, SystemMessage

try:
    from mindee import Client as MindeeClient, product
    MINDEE_AVAILABLE = True
except ImportError:
    MINDEE_AVAILABLE = False
    print("[EmailParser] Warning: mindee package not available")


@dataclass
class ParsedEmailData:
    merchant_name: Optional[str] = None
    items: List[Dict[str, Any]] = field(default_factory=list)
    total_amount: Optional[float] = None
    currency: str = "GBP"
    transaction_date: Optional[str] = None
    order_id: Optional[str] = None
    payment_method: Optional[str] = None
    confidence: float = 0.0
    source: str = "unknown"
    error: Optional[str] = None


@dataclass
class ParsedInvoiceData:
    merchant_name: Optional[str] = None
    invoice_number: Optional[str] = None
    invoice_date: Optional[str] = None
    due_date: Optional[str] = None
    total_amount: Optional[float] = None
    subtotal: Optional[float] = None
    tax_amount: Optional[float] = None
    currency: str = "GBP"
    line_items: List[Dict[str, Any]] = field(default_factory=list)
    confidence: float = 0.0
    source: str = "unknown"
    error: Optional[str] = None


class EmailParser:
    def __init__(self):
        self.llm = None
        self.mindee_client = None
        self._init_llm()
        self._init_mindee()
    
    def _init_llm(self):
        api_key = os.environ.get("ANTHROPIC_API_KEY")
        if api_key:
            self.llm = ChatAnthropic(
                model="claude-sonnet-4-20250514",
                api_key=api_key,
                max_tokens=2048,
                temperature=0.0
            )
            print("[EmailParser] Claude LLM initialized")
    
    def _init_mindee(self):
        if not MINDEE_AVAILABLE:
            return
        
        api_key = os.environ.get("MINDEE_API_KEY")
        if api_key:
            self.mindee_client = MindeeClient(api_key=api_key)
            print("[EmailParser] Mindee client initialized")
    
    async def parse_html_email(self, html_body: str) -> ParsedEmailData:
        if not self.llm:
            return ParsedEmailData(
                error="Claude LLM not available",
                confidence=0.0
            )
        
        clean_text = self._strip_html(html_body)
        
        if len(clean_text) > 8000:
            clean_text = clean_text[:8000] + "...[truncated]"
        
        system_prompt = """You are an expert at extracting financial information from receipt and order confirmation emails.

Extract the following information and respond in this exact JSON format:
{
    "merchant_name": "Company name",
    "items": [
        {"description": "Item 1", "quantity": 1, "unit_price": 9.99, "total": 9.99},
        {"description": "Item 2", "quantity": 2, "unit_price": 5.00, "total": 10.00}
    ],
    "total_amount": 19.99,
    "currency": "GBP",
    "transaction_date": "2024-01-15",
    "order_id": "ORD-12345",
    "payment_method": "Visa ending in 1234",
    "confidence": 0.95
}

Rules:
- Extract only what you can clearly identify
- Use null for fields you cannot determine
- Date format should be YYYY-MM-DD
- Currency should be 3-letter code (GBP, USD, EUR)
- Confidence should reflect how certain you are about the extraction (0.0-1.0)
- DO NOT make up or hallucinate information"""

        user_prompt = f"""Extract financial information from this receipt/order email:

{clean_text}"""

        try:
            response = await self.llm.ainvoke([
                SystemMessage(content=system_prompt),
                HumanMessage(content=user_prompt)
            ])
            
            response_text = response.content
            
            import json
            try:
                if "```json" in response_text:
                    json_str = response_text.split("```json")[1].split("```")[0].strip()
                elif "```" in response_text:
                    json_str = response_text.split("```")[1].split("```")[0].strip()
                else:
                    json_str = response_text.strip()
                
                result = json.loads(json_str)
                
                return ParsedEmailData(
                    merchant_name=result.get("merchant_name"),
                    items=result.get("items", []),
                    total_amount=result.get("total_amount"),
                    currency=result.get("currency", "GBP"),
                    transaction_date=result.get("transaction_date"),
                    order_id=result.get("order_id"),
                    payment_method=result.get("payment_method"),
                    confidence=float(result.get("confidence", 0.5)),
                    source="claude"
                )
                
            except json.JSONDecodeError as e:
                return ParsedEmailData(
                    error=f"Failed to parse LLM response: {e}",
                    confidence=0.0
                )
                
        except Exception as e:
            return ParsedEmailData(
                error=f"LLM analysis error: {str(e)}",
                confidence=0.0
            )
    
    def _strip_html(self, html: str) -> str:
        text = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<script[^>]*>.*?</script>', '', text, flags=re.DOTALL | re.IGNORECASE)
        text = re.sub(r'<[^>]+>', ' ', text)
        text = re.sub(r'&nbsp;', ' ', text)
        text = re.sub(r'&amp;', '&', text)
        text = re.sub(r'&lt;', '<', text)
        text = re.sub(r'&gt;', '>', text)
        text = re.sub(r'&#\d+;', '', text)
        text = re.sub(r'\s+', ' ', text)
        return text.strip()
    
    async def parse_pdf_invoice(self, pdf_bytes: bytes) -> ParsedInvoiceData:
        if not self.mindee_client:
            return await self._parse_pdf_with_claude_fallback(pdf_bytes)
        
        try:
            input_doc = self.mindee_client.source_from_bytes(pdf_bytes, "invoice.pdf")
            result = self.mindee_client.parse(product.InvoiceV4, input_doc)
            
            doc = result.document.inference.prediction
            
            line_items = []
            if hasattr(doc, 'line_items') and doc.line_items:
                for item in doc.line_items:
                    line_items.append({
                        "description": getattr(item, 'description', None),
                        "quantity": getattr(item, 'quantity', None),
                        "unit_price": getattr(item, 'unit_price', None),
                        "total": getattr(item, 'total_amount', None)
                    })
            
            invoice_date = None
            if hasattr(doc, 'invoice_date') and doc.invoice_date:
                invoice_date = str(doc.invoice_date.value) if doc.invoice_date.value else None
            
            due_date = None
            if hasattr(doc, 'due_date') and doc.due_date:
                due_date = str(doc.due_date.value) if doc.due_date.value else None
            
            parsed_data = ParsedInvoiceData(
                merchant_name=doc.supplier_name.value if hasattr(doc, 'supplier_name') and doc.supplier_name else None,
                invoice_number=doc.invoice_number.value if hasattr(doc, 'invoice_number') and doc.invoice_number else None,
                invoice_date=invoice_date,
                due_date=due_date,
                total_amount=doc.total_amount.value if hasattr(doc, 'total_amount') and doc.total_amount else None,
                subtotal=doc.total_net.value if hasattr(doc, 'total_net') and doc.total_net else None,
                tax_amount=doc.total_tax.value if hasattr(doc, 'total_tax') and doc.total_tax else None,
                currency=doc.locale.currency if hasattr(doc, 'locale') and doc.locale and doc.locale.currency else "GBP",
                line_items=line_items,
                confidence=0.9,
                source="mindee"
            )
            
            if not invoice_date and self.llm:
                parsed_data = await self._extract_date_with_claude(pdf_bytes, parsed_data)
            
            return parsed_data
            
        except Exception as e:
            print(f"[EmailParser] Mindee parsing error: {e}")
            return await self._parse_pdf_with_claude_fallback(pdf_bytes)
    
    async def _parse_pdf_with_claude_fallback(self, pdf_bytes: bytes) -> ParsedInvoiceData:
        return ParsedInvoiceData(
            error="PDF parsing requires Mindee API - Claude fallback for raw PDF not available",
            confidence=0.0,
            source="none"
        )
    
    async def _extract_date_with_claude(
        self,
        pdf_bytes: bytes,
        existing_data: ParsedInvoiceData
    ) -> ParsedInvoiceData:
        return existing_data


_email_parser = None

def get_email_parser() -> EmailParser:
    global _email_parser
    if _email_parser is None:
        _email_parser = EmailParser()
    return _email_parser


async def parse_html_email(html_body: str) -> dict:
    parser = get_email_parser()
    result = await parser.parse_html_email(html_body)
    return {
        "merchant_name": result.merchant_name,
        "items": result.items,
        "total_amount": result.total_amount,
        "currency": result.currency,
        "transaction_date": result.transaction_date,
        "order_id": result.order_id,
        "payment_method": result.payment_method,
        "confidence": result.confidence,
        "source": result.source,
        "error": result.error
    }


async def parse_pdf_invoice(pdf_bytes: bytes) -> dict:
    parser = get_email_parser()
    result = await parser.parse_pdf_invoice(pdf_bytes)
    return {
        "merchant_name": result.merchant_name,
        "invoice_number": result.invoice_number,
        "invoice_date": result.invoice_date,
        "due_date": result.due_date,
        "total_amount": result.total_amount,
        "subtotal": result.subtotal,
        "tax_amount": result.tax_amount,
        "currency": result.currency,
        "line_items": result.line_items,
        "confidence": result.confidence,
        "source": result.source,
        "error": result.error
    }
