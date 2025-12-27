"""
Nylas Email Service for Resolve 2.0 Agentic Enrichment

This service handles:
1. Email search for receipts and invoices
2. OAuth flow management
3. Grant management
"""

import os
from datetime import datetime, timedelta
from typing import Optional, List, Dict, Any
from dataclasses import dataclass

try:
    from nylas import Client
    NYLAS_AVAILABLE = True
except ImportError:
    NYLAS_AVAILABLE = False
    print("[NylasService] Warning: nylas package not available")


@dataclass
class EmailSearchResult:
    found: bool
    message_id: Optional[str] = None
    subject: Optional[str] = None
    sender: Optional[str] = None
    date: Optional[str] = None
    snippet: Optional[str] = None
    has_attachments: bool = False
    attachment_types: List[str] = None
    error: Optional[str] = None
    
    def __post_init__(self):
        if self.attachment_types is None:
            self.attachment_types = []


class NylasService:
    def __init__(self):
        self.client = None
        self._init_client()
    
    def _init_client(self):
        if not NYLAS_AVAILABLE:
            print("[NylasService] Nylas SDK not available - import failed")
            return
        
        api_key = os.environ.get("NYLAS_API_KEY")
        client_id = os.environ.get("NYLAS_CLIENT_ID")
        api_uri = os.environ.get("NYLAS_API_URI", "https://api.us.nylas.com")
        
        print(f"[NylasService] Init check - API_KEY set: {bool(api_key)}, CLIENT_ID set: {bool(client_id)}, API_URI: {api_uri}")
        
        if api_key:
            try:
                self.client = Client(
                    api_key=api_key,
                    api_uri=api_uri
                )
                print("[NylasService] Nylas client initialized successfully")
            except Exception as e:
                print(f"[NylasService] Error initializing Nylas client: {e}")
                self.client = None
        else:
            print("[NylasService] Warning: NYLAS_API_KEY not set - client not initialized")
    
    def is_available(self) -> bool:
        available = self.client is not None
        print(f"[NylasService] is_available() called - returning {available}")
        return available
    
    def get_auth_url(self, redirect_uri: str, user_id: str) -> Optional[str]:
        if not self.client:
            return None
        
        try:
            auth_url = self.client.auth.url_for_oauth2({
                "client_id": os.environ.get("NYLAS_CLIENT_ID", ""),
                "redirect_uri": redirect_uri,
                "state": user_id,
                "provider": "google"
            })
            return auth_url
        except Exception as e:
            print(f"[NylasService] Error generating auth URL: {e}")
            return None
    
    def exchange_code_for_token(self, code: str, redirect_uri: str) -> Optional[Dict[str, Any]]:
        if not self.client:
            return None
        
        try:
            response = self.client.auth.exchange_code_for_token({
                "client_id": os.environ.get("NYLAS_CLIENT_ID", ""),
                "code": code,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code"
            })
            return {
                "grant_id": response.grant_id,
                "email": response.email,
                "provider": getattr(response, "provider", "unknown")
            }
        except Exception as e:
            print(f"[NylasService] Error exchanging code: {e}")
            return None
    
    def find_receipt(
        self,
        grant_id: str,
        merchant: str,
        date: str,
        date_window_days: int = 1
    ) -> EmailSearchResult:
        if not self.client:
            return EmailSearchResult(
                found=False,
                error="Nylas client not initialized"
            )
        
        try:
            tx_date = datetime.strptime(date, "%Y-%m-%d")
            start_date = tx_date - timedelta(days=date_window_days)
            end_date = tx_date + timedelta(days=date_window_days)
            
            search_query = f"from:{merchant} (subject:receipt OR subject:invoice OR subject:order OR subject:confirmation)"
            
            messages = self.client.messages.list(
                grant_id,
                query_params={
                    "search_query_native": search_query,
                    "received_after": int(start_date.timestamp()),
                    "received_before": int(end_date.timestamp()),
                    "limit": 5
                }
            )
            
            if hasattr(messages, 'data') and messages.data:
                msg = messages.data[0]
                
                attachment_types = []
                has_attachments = False
                if hasattr(msg, 'attachments') and msg.attachments:
                    has_attachments = True
                    for att in msg.attachments:
                        content_type = getattr(att, 'content_type', '')
                        if content_type:
                            attachment_types.append(content_type)
                
                return EmailSearchResult(
                    found=True,
                    message_id=msg.id,
                    subject=getattr(msg, 'subject', None),
                    sender=getattr(msg.from_[0], 'email', None) if hasattr(msg, 'from_') and msg.from_ else None,
                    date=datetime.fromtimestamp(msg.date).isoformat() if hasattr(msg, 'date') else None,
                    snippet=getattr(msg, 'snippet', None),
                    has_attachments=has_attachments,
                    attachment_types=attachment_types
                )
            
            return EmailSearchResult(found=False)
            
        except Exception as e:
            print(f"[NylasService] Error searching for receipt: {e}")
            return EmailSearchResult(
                found=False,
                error=str(e)
            )
    
    def get_message_body(self, grant_id: str, message_id: str) -> Optional[str]:
        if not self.client:
            return None
        
        try:
            message = self.client.messages.find(grant_id, message_id)
            if hasattr(message, 'body'):
                return message.body
            return None
        except Exception as e:
            print(f"[NylasService] Error getting message body: {e}")
            return None
    
    def get_attachment(self, grant_id: str, message_id: str, attachment_id: str) -> Optional[bytes]:
        if not self.client:
            return None
        
        try:
            attachment = self.client.messages.attachments.download(
                grant_id,
                message_id,
                attachment_id
            )
            return attachment
        except Exception as e:
            print(f"[NylasService] Error downloading attachment: {e}")
            return None
    
    def list_grants(self) -> List[Dict[str, Any]]:
        """List all grants associated with this Nylas application"""
        if not self.client:
            print("[NylasService] Cannot list grants - client not initialized")
            return []
        
        try:
            # Nylas v3 API - list all grants
            response = self.client.grants.list()
            grants = []
            
            if hasattr(response, 'data'):
                for grant in response.data:
                    grants.append({
                        "grant_id": grant.id,
                        "email": getattr(grant, 'email', None),
                        "provider": getattr(grant, 'provider', 'unknown'),
                        "status": getattr(grant, 'grant_status', 'unknown'),
                    })
            
            print(f"[NylasService] Found {len(grants)} grants in Nylas")
            return grants
        except Exception as e:
            print(f"[NylasService] Error listing grants: {e}")
            return []


_nylas_service = None

def get_nylas_service() -> NylasService:
    global _nylas_service
    if _nylas_service is None:
        _nylas_service = NylasService()
    return _nylas_service


def find_receipt(grant_id: str, merchant: str, date: str) -> dict:
    service = get_nylas_service()
    result = service.find_receipt(grant_id, merchant, date)
    return {
        "found": result.found,
        "message_id": result.message_id,
        "subject": result.subject,
        "sender": result.sender,
        "date": result.date,
        "snippet": result.snippet,
        "has_attachments": result.has_attachments,
        "attachment_types": result.attachment_types,
        "error": result.error
    }
