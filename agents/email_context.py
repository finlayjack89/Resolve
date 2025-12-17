# agents/email_context.py - Email Context Hunter with Nylas v3 SDK
# Fetches receipt emails and parses them for transaction context

import os
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, Field

NYLAS_AVAILABLE = False
nylas_client = None

try:
    from nylas import Client as NylasClient
    from nylas.models.auth import URLForAuthenticationConfig
    from nylas.models.errors import NylasApiError
    NYLAS_AVAILABLE = True
except ImportError:
    print("[EmailContext] Warning: nylas SDK not available")


class EmailReceipt(BaseModel):
    """A parsed email receipt"""
    message_id: str
    sender_email: str
    subject: str
    received_at: datetime
    body_text: Optional[str] = None
    body_html: Optional[str] = None


class ParsedReceiptData(BaseModel):
    """Extracted data from a receipt email"""
    merchant_name: Optional[str] = None
    amount_cents: Optional[int] = None
    currency: Optional[str] = "GBP"
    transaction_date: Optional[str] = None
    items: List[Dict[str, Any]] = Field(default_factory=list)
    confidence: float = 0.0
    raw_extraction: Dict[str, Any] = Field(default_factory=dict)


class NylasEmailConnector:
    """
    Handles Nylas v3 SDK OAuth flow and email fetching.
    
    In Nylas v3, the API key serves as both:
    - The main authentication credential
    - The client_secret for OAuth token exchange
    """
    
    def __init__(self):
        self.api_key = os.environ.get("NYLAS_API_KEY")
        self.client_id = os.environ.get("NYLAS_CLIENT_ID")
        self.api_uri = os.environ.get("NYLAS_API_URI", "https://api.us.nylas.com")
        
        self.client = None
        if NYLAS_AVAILABLE and self.api_key:
            try:
                self.client = NylasClient(
                    api_key=self.api_key,
                    api_uri=self.api_uri
                )
                print(f"[EmailContext] Nylas client initialized (URI: {self.api_uri})")
            except Exception as e:
                print(f"[EmailContext] Failed to initialize Nylas client: {e}")
    
    def is_available(self) -> bool:
        """Check if Nylas is properly configured"""
        return self.client is not None and self.client_id is not None
    
    def get_auth_url(self, redirect_uri: str, state: Optional[str] = None) -> Optional[str]:
        """
        Generate Nylas OAuth URL for user authentication.
        
        Args:
            redirect_uri: The callback URL after authentication
            state: Optional state parameter for CSRF protection
        
        Returns:
            OAuth authorization URL or None if not configured
        """
        if not self.is_available():
            print("[EmailContext] Nylas not configured - cannot generate auth URL")
            return None
        
        try:
            config = URLForAuthenticationConfig(
                client_id=self.client_id,
                redirect_uri=redirect_uri,
                state=state
            )
            
            auth_url = self.client.auth.url_for_oauth2(config)
            return auth_url
            
        except Exception as e:
            print(f"[EmailContext] Failed to generate auth URL: {e}")
            return None
    
    def exchange_code_for_grant(self, code: str, redirect_uri: str) -> Optional[Dict[str, Any]]:
        """
        Exchange authorization code for a Nylas grant.
        
        In Nylas v3, the API key is used as the client_secret.
        
        Args:
            code: Authorization code from OAuth callback
            redirect_uri: The same redirect URI used in get_auth_url
        
        Returns:
            Grant information including grant_id, or None on failure
        """
        if not self.is_available():
            print("[EmailContext] Nylas not configured - cannot exchange code")
            return None
        
        try:
            exchange_response = self.client.auth.exchange_code_for_token({
                "client_id": self.client_id,
                "client_secret": self.api_key,
                "code": code,
                "redirect_uri": redirect_uri
            })
            
            return {
                "grant_id": exchange_response.grant_id,
                "email": getattr(exchange_response, 'email', None),
                "provider": getattr(exchange_response, 'provider', 'unknown')
            }
            
        except Exception as e:
            print(f"[EmailContext] Failed to exchange code for grant: {e}")
            return None
    
    def fetch_receipt_emails(
        self,
        grant_id: str,
        since: Optional[datetime] = None,
        limit: int = 50
    ) -> List[EmailReceipt]:
        """
        Fetch receipt/confirmation emails from user's mailbox.
        
        Args:
            grant_id: The Nylas grant ID for this user
            since: Only fetch emails after this date (defaults to 30 days ago)
            limit: Maximum number of emails to fetch
        
        Returns:
            List of EmailReceipt objects
        """
        if not self.is_available():
            print("[EmailContext] Nylas not configured - cannot fetch emails")
            return []
        
        if since is None:
            since = datetime.now() - timedelta(days=30)
        
        receipt_senders = [
            "noreply@uber.com",
            "receipts@uber.com",
            "no-reply@deliveroo.co.uk",
            "noreply@netflix.com",
            "no-reply@spotify.com",
            "noreply@amazon.co.uk",
            "auto-confirm@amazon.co.uk",
            "noreply@tesco.com",
            "noreply@sainsburys.co.uk",
            "receipts@square.com",
            "noreply@just-eat.co.uk",
        ]
        
        receipts: List[EmailReceipt] = []
        
        try:
            since_timestamp = int(since.timestamp())
            
            for sender in receipt_senders:
                try:
                    messages, _, _ = self.client.messages.list(
                        identifier=grant_id,
                        query_params={
                            "from": sender,
                            "received_after": since_timestamp,
                            "limit": limit // len(receipt_senders) + 1
                        }
                    )
                    
                    for msg in messages:
                        receipts.append(EmailReceipt(
                            message_id=msg.id,
                            sender_email=msg.from_[0].email if msg.from_ else sender,
                            subject=msg.subject or "",
                            received_at=datetime.fromtimestamp(msg.date) if msg.date else datetime.now(),
                            body_text=getattr(msg, 'body', None),
                            body_html=None
                        ))
                        
                except Exception as e:
                    print(f"[EmailContext] Error fetching from {sender}: {e}")
                    continue
            
            return receipts[:limit]
            
        except Exception as e:
            print(f"[EmailContext] Failed to fetch receipt emails: {e}")
            return []
    
    def get_message_body(self, grant_id: str, message_id: str) -> Optional[Dict[str, str]]:
        """
        Fetch the full body of a specific email message.
        
        Args:
            grant_id: The Nylas grant ID
            message_id: The message ID to fetch
        
        Returns:
            Dict with 'text' and 'html' body content, or None on failure
        """
        if not self.is_available():
            return None
        
        try:
            message, _ = self.client.messages.find(
                identifier=grant_id,
                message_id=message_id
            )
            
            return {
                "text": getattr(message, 'body', None),
                "html": None
            }
            
        except Exception as e:
            print(f"[EmailContext] Failed to fetch message body: {e}")
            return None


nylas_connector = NylasEmailConnector()


def get_nylas_connector() -> NylasEmailConnector:
    """Get the singleton Nylas connector instance"""
    return nylas_connector


ANTHROPIC_AVAILABLE = False
anthropic_client = None

try:
    from anthropic import Anthropic
    ANTHROPIC_AVAILABLE = True
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if api_key:
        anthropic_client = Anthropic(api_key=api_key)
except ImportError:
    print("[EmailContext] Warning: anthropic SDK not available")


async def parse_receipt_content(
    email_subject: str,
    email_body: str,
    sender_email: str
) -> ParsedReceiptData:
    """
    Use Claude to extract structured data from a receipt email.
    
    Args:
        email_subject: The email subject line
        email_body: The email body text (plain text preferred)
        sender_email: The sender's email address
    
    Returns:
        ParsedReceiptData with extracted information
    """
    if not ANTHROPIC_AVAILABLE or anthropic_client is None:
        print("[EmailContext] Anthropic not configured - cannot parse receipt")
        return ParsedReceiptData(confidence=0.0)
    
    prompt = f"""You are a receipt parsing assistant. Extract structured information from this email receipt.

Email Subject: {email_subject}
Sender: {sender_email}
Email Body:
{email_body[:5000]}

Extract the following information and respond in JSON format:
{{
    "merchant_name": "The merchant/company name",
    "amount_cents": 1234,  // Total amount in pence/cents (e.g., £12.34 = 1234)
    "currency": "GBP",  // Currency code
    "transaction_date": "YYYY-MM-DD",  // Date of purchase if found
    "items": [  // List of items/services purchased
        {{"name": "Item name", "price_cents": 500, "quantity": 1}}
    ],
    "confidence": 0.85  // Your confidence in the extraction (0-1)
}}

If you cannot find a specific field, use null. Always try to extract the merchant name and total amount.
Respond with ONLY the JSON object, no additional text."""

    try:
        response = anthropic_client.messages.create(
            model="claude-sonnet-4-20250514",
            max_tokens=1000,
            messages=[
                {"role": "user", "content": prompt}
            ]
        )
        
        response_text = response.content[0].text.strip()
        
        import json
        if response_text.startswith("```"):
            lines = response_text.split("\n")
            response_text = "\n".join(lines[1:-1])
        
        data = json.loads(response_text)
        
        return ParsedReceiptData(
            merchant_name=data.get("merchant_name"),
            amount_cents=data.get("amount_cents"),
            currency=data.get("currency", "GBP"),
            transaction_date=data.get("transaction_date"),
            items=data.get("items", []),
            confidence=data.get("confidence", 0.5),
            raw_extraction=data
        )
        
    except json.JSONDecodeError as e:
        print(f"[EmailContext] Failed to parse Claude response as JSON: {e}")
        return ParsedReceiptData(confidence=0.0)
    except Exception as e:
        print(f"[EmailContext] Failed to parse receipt with Claude: {e}")
        return ParsedReceiptData(confidence=0.0)
