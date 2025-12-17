# agents/context_hunter.py - Context Hunter: Links transactions to email receipts
# Uses fuzzy matching to connect bank transactions with receipt emails

import os
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Optional, List, Dict, Any, Tuple
from pydantic import BaseModel, Field

import psycopg2
from psycopg2.extras import RealDictCursor


class ReceiptMatch(BaseModel):
    """A match between an email receipt and a transaction"""
    receipt_id: str
    transaction_id: str
    confidence: float
    match_details: Dict[str, Any] = Field(default_factory=dict)


class TransactionData(BaseModel):
    """Transaction data for matching"""
    id: str
    merchant_clean_name: Optional[str] = None
    amount_cents: int
    transaction_date: str
    original_description: Optional[str] = None


class ReceiptData(BaseModel):
    """Receipt data for matching"""
    id: str
    merchant_name: Optional[str] = None
    amount_cents: Optional[int] = None
    received_at: Optional[datetime] = None
    subject: Optional[str] = None
    sender_email: Optional[str] = None


def normalize_merchant_name(name: Optional[str]) -> str:
    """
    Normalize merchant name for comparison.
    Removes common suffixes, lowercases, and strips whitespace.
    """
    if not name:
        return ""
    
    name = name.lower().strip()
    
    suffixes_to_remove = [
        " ltd", " limited", " inc", " llc", " plc",
        ".com", ".co.uk", " uk", " gb", " online",
        " - receipt", " receipt", " order", " purchase"
    ]
    
    for suffix in suffixes_to_remove:
        if name.endswith(suffix):
            name = name[:-len(suffix)]
    
    prefixes_to_remove = ["www.", "receipt from ", "order from ", "payment to "]
    for prefix in prefixes_to_remove:
        if name.startswith(prefix):
            name = name[len(prefix):]
    
    return name.strip()


def calculate_merchant_similarity(
    transaction_merchant: Optional[str],
    receipt_merchant: Optional[str],
    receipt_sender: Optional[str] = None,
    receipt_subject: Optional[str] = None
) -> Tuple[float, str]:
    """
    Calculate similarity between transaction merchant and receipt merchant.
    Also considers sender email domain and subject line.
    
    Returns: (similarity_score, match_source)
    """
    if not transaction_merchant:
        return 0.0, "no_transaction_merchant"
    
    trans_normalized = normalize_merchant_name(transaction_merchant)
    
    best_score = 0.0
    best_source = "no_match"
    
    if receipt_merchant:
        receipt_normalized = normalize_merchant_name(receipt_merchant)
        score = SequenceMatcher(None, trans_normalized, receipt_normalized).ratio()
        if score > best_score:
            best_score = score
            best_source = "merchant_name"
    
    if receipt_sender:
        sender_parts = receipt_sender.lower().split("@")
        if len(sender_parts) == 2:
            domain = sender_parts[1].split(".")[0]
            domain_normalized = normalize_merchant_name(domain)
            score = SequenceMatcher(None, trans_normalized, domain_normalized).ratio()
            if score > best_score:
                best_score = score
                best_source = "sender_email"
            
            sender_name = sender_parts[0].replace("noreply", "").replace("no-reply", "")
            sender_name = sender_name.replace("receipts", "").replace("orders", "")
            sender_name = normalize_merchant_name(sender_name)
            if sender_name:
                score = SequenceMatcher(None, trans_normalized, sender_name).ratio()
                if score > best_score:
                    best_score = score
                    best_source = "sender_name"
    
    if receipt_subject:
        subject_normalized = normalize_merchant_name(receipt_subject)
        if trans_normalized in subject_normalized:
            score = 0.9
            if score > best_score:
                best_score = score
                best_source = "subject_contains"
    
    return best_score, best_source


def calculate_amount_similarity(
    transaction_amount_cents: int,
    receipt_amount_cents: Optional[int]
) -> Tuple[float, str]:
    """
    Calculate similarity between transaction and receipt amounts.
    
    Returns: (similarity_score, match_type)
    """
    if receipt_amount_cents is None:
        return 0.5, "receipt_amount_unknown"
    
    if transaction_amount_cents == receipt_amount_cents:
        return 1.0, "exact_match"
    
    if transaction_amount_cents == 0:
        return 0.0, "zero_transaction"
    
    diff_percent = abs(transaction_amount_cents - receipt_amount_cents) / transaction_amount_cents
    
    if diff_percent <= 0.01:
        return 0.95, "within_1_percent"
    elif diff_percent <= 0.02:
        return 0.85, "within_2_percent"
    elif diff_percent <= 0.05:
        return 0.70, "within_5_percent"
    elif diff_percent <= 0.10:
        return 0.50, "within_10_percent"
    else:
        return 0.0, "amount_mismatch"


def calculate_date_similarity(
    transaction_date_str: str,
    receipt_received_at: Optional[datetime]
) -> Tuple[float, int]:
    """
    Calculate similarity based on date proximity.
    Receipt should typically arrive on or after transaction date.
    
    Returns: (similarity_score, days_difference)
    """
    if not receipt_received_at:
        return 0.5, 0
    
    try:
        transaction_date = datetime.strptime(transaction_date_str, "%Y-%m-%d")
    except ValueError:
        try:
            transaction_date = datetime.fromisoformat(transaction_date_str.replace("Z", "+00:00"))
            transaction_date = transaction_date.replace(tzinfo=None)
        except ValueError:
            return 0.5, 0
    
    if receipt_received_at.tzinfo:
        receipt_received_at = receipt_received_at.replace(tzinfo=None)
    
    days_diff = (receipt_received_at.date() - transaction_date.date()).days
    
    if days_diff == 0:
        return 1.0, days_diff
    elif days_diff == 1:
        return 0.95, days_diff
    elif 2 <= days_diff <= 3:
        return 0.85, days_diff
    elif 4 <= days_diff <= 7:
        return 0.70, days_diff
    elif -1 <= days_diff < 0:
        return 0.80, days_diff
    elif days_diff > 7:
        return 0.30, days_diff
    else:
        return 0.20, days_diff


def match_transaction_to_receipt(
    transaction: TransactionData,
    receipts: List[ReceiptData],
    min_confidence_threshold: float = 0.6
) -> Optional[ReceiptMatch]:
    """
    Find the best matching receipt for a transaction.
    
    Uses weighted scoring:
    - Merchant name similarity: 40%
    - Amount match: 35%
    - Date proximity: 25%
    
    Args:
        transaction: Transaction data to match
        receipts: List of receipts to search
        min_confidence_threshold: Minimum confidence to accept a match
    
    Returns:
        ReceiptMatch if a good match is found, None otherwise
    """
    best_match: Optional[ReceiptMatch] = None
    best_confidence = 0.0
    
    for receipt in receipts:
        merchant_score, merchant_source = calculate_merchant_similarity(
            transaction.merchant_clean_name or transaction.original_description,
            receipt.merchant_name,
            receipt.sender_email,
            receipt.subject
        )
        
        amount_score, amount_type = calculate_amount_similarity(
            transaction.amount_cents,
            receipt.amount_cents
        )
        
        date_score, days_diff = calculate_date_similarity(
            transaction.transaction_date,
            receipt.received_at
        )
        
        confidence = (
            merchant_score * 0.40 +
            amount_score * 0.35 +
            date_score * 0.25
        )
        
        if confidence > best_confidence:
            best_confidence = confidence
            best_match = ReceiptMatch(
                receipt_id=receipt.id,
                transaction_id=transaction.id,
                confidence=round(confidence, 3),
                match_details={
                    "merchant_score": round(merchant_score, 3),
                    "merchant_source": merchant_source,
                    "amount_score": round(amount_score, 3),
                    "amount_type": amount_type,
                    "date_score": round(date_score, 3),
                    "days_difference": days_diff,
                    "transaction_merchant": transaction.merchant_clean_name,
                    "receipt_merchant": receipt.merchant_name
                }
            )
    
    if best_match and best_match.confidence >= min_confidence_threshold:
        return best_match
    
    return None


def get_db_connection():
    """Get database connection from environment"""
    database_url = os.environ.get("DATABASE_URL")
    if not database_url:
        raise Exception("DATABASE_URL not configured")
    return psycopg2.connect(database_url, cursor_factory=RealDictCursor)


async def find_matches_for_user(
    connection_id: str,
    user_id: str,
    days_back: int = 60,
    min_confidence: float = 0.6
) -> List[ReceiptMatch]:
    """
    Find all matches between unmatched receipts and transactions for a user.
    
    Args:
        connection_id: Email connection ID
        user_id: User ID
        days_back: How many days of transactions to consider
        min_confidence: Minimum confidence threshold for matches
    
    Returns:
        List of ReceiptMatch objects
    """
    print(f"[ContextHunter] Finding matches for user {user_id}, connection {connection_id}")
    
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        
        cursor.execute("""
            SELECT id, nylas_message_id, sender_email, subject, received_at,
                   merchant_name, amount_cents, currency, parsed_data
            FROM email_receipts
            WHERE connection_id = %s
            AND matched_transaction_id IS NULL
            ORDER BY received_at DESC
        """, (connection_id,))
        
        receipt_rows = cursor.fetchall()
        print(f"[ContextHunter] Found {len(receipt_rows)} unmatched receipts")
        
        if not receipt_rows:
            return []
        
        receipts: List[ReceiptData] = []
        for row in receipt_rows:
            receipts.append(ReceiptData(
                id=row["id"],
                merchant_name=row["merchant_name"],
                amount_cents=row["amount_cents"],
                received_at=row["received_at"],
                subject=row["subject"],
                sender_email=row["sender_email"]
            ))
        
        start_date = datetime.now() - timedelta(days=days_back)
        
        cursor.execute("""
            SELECT id, truelayer_transaction_id, original_description,
                   merchant_clean_name, amount_cents, transaction_date, currency
            FROM enriched_transactions
            WHERE user_id = %s
            AND transaction_date >= %s
            AND entry_type = 'outgoing'
            ORDER BY transaction_date DESC
        """, (user_id, start_date.strftime("%Y-%m-%d")))
        
        transaction_rows = cursor.fetchall()
        print(f"[ContextHunter] Found {len(transaction_rows)} transactions in date range")
        
        if not transaction_rows:
            return []
        
        transactions: List[TransactionData] = []
        for row in transaction_rows:
            transactions.append(TransactionData(
                id=row["id"],
                merchant_clean_name=row["merchant_clean_name"],
                amount_cents=abs(row["amount_cents"]),
                transaction_date=str(row["transaction_date"]),
                original_description=row["original_description"]
            ))
        
        matches: List[ReceiptMatch] = []
        matched_receipt_ids: set = set()
        
        for transaction in transactions:
            available_receipts = [
                r for r in receipts if r.id not in matched_receipt_ids
            ]
            
            if not available_receipts:
                continue
            
            match = match_transaction_to_receipt(
                transaction,
                available_receipts,
                min_confidence
            )
            
            if match:
                matches.append(match)
                matched_receipt_ids.add(match.receipt_id)
        
        print(f"[ContextHunter] Found {len(matches)} matches with confidence >= {min_confidence}")
        
        return matches
        
    finally:
        conn.close()


async def apply_matches(matches: List[ReceiptMatch]) -> int:
    """
    Apply receipt-to-transaction matches to the database.
    Updates emailReceipts.matchedTransactionId for each match.
    
    Args:
        matches: List of matches to apply
    
    Returns:
        Number of matches applied
    """
    if not matches:
        return 0
    
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        
        applied = 0
        for match in matches:
            cursor.execute("""
                UPDATE email_receipts
                SET matched_transaction_id = %s
                WHERE id = %s
                AND matched_transaction_id IS NULL
            """, (match.transaction_id, match.receipt_id))
            
            if cursor.rowcount > 0:
                applied += 1
        
        conn.commit()
        print(f"[ContextHunter] Applied {applied} matches to database")
        return applied
        
    finally:
        conn.close()
