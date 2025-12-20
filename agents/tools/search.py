import os
import requests
import json
from typing import Optional


def search_subscription_pricing(merchant: str, amount: float, currency: str = "GBP") -> dict:
    """
    Query Serper.dev to find subscription pricing info for a merchant.
    
    Args:
        merchant: The merchant/company name to search for
        amount: The subscription amount to verify
        currency: Currency code (default: GBP)
        
    Returns:
        dict: Search results from Serper API containing organic results,
              knowledge graph, and other relevant information
    """
    url = "https://google.serper.dev/search"
    query = f"{merchant} subscription price {currency} {amount}"
    
    payload = json.dumps({"q": query, "gl": "gb"})
    headers = {
        'X-API-KEY': os.getenv("SERPER_API_KEY", ""),
        'Content-Type': 'application/json'
    }
    
    try:
        response = requests.post(url, headers=headers, data=payload, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        return {"error": str(e), "success": False}


def search_merchant_info(merchant: str) -> dict:
    """
    Search for general information about a merchant/company.
    
    Args:
        merchant: The merchant/company name to search for
        
    Returns:
        dict: Search results containing company information
    """
    url = "https://google.serper.dev/search"
    query = f"{merchant} company UK pricing plans"
    
    payload = json.dumps({"q": query, "gl": "gb"})
    headers = {
        'X-API-KEY': os.getenv("SERPER_API_KEY", ""),
        'Content-Type': 'application/json'
    }
    
    try:
        response = requests.post(url, headers=headers, data=payload, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        return {"error": str(e), "success": False}


def verify_subscription_exists(merchant: str, product_name: Optional[str] = None) -> dict:
    """
    Verify if a subscription product exists for a given merchant.
    
    Args:
        merchant: The merchant/company name
        product_name: Optional specific product/tier name
        
    Returns:
        dict: Search results to help verify subscription existence
    """
    url = "https://google.serper.dev/search"
    
    if product_name:
        query = f"{merchant} {product_name} subscription UK"
    else:
        query = f"{merchant} subscription plans UK 2025"
    
    payload = json.dumps({"q": query, "gl": "gb"})
    headers = {
        'X-API-KEY': os.getenv("SERPER_API_KEY", ""),
        'Content-Type': 'application/json'
    }
    
    try:
        response = requests.post(url, headers=headers, data=payload, timeout=10)
        response.raise_for_status()
        return response.json()
    except requests.RequestException as e:
        return {"error": str(e), "success": False}
