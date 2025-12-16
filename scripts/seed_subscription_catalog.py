#!/usr/bin/env python3
"""
Seed script to populate subscription_catalog table from UK Subscriptions Excel file.
"""
import os
import pandas as pd
import psycopg2
from psycopg2.extras import execute_values

def main():
    excel_path = "attached_assets/UK_Subscriptions_Master_2025_1765913519179.xlsx"
    
    df = pd.read_excel(excel_path, header=1)
    print(f"Loaded {len(df)} rows from Excel")
    print(f"Columns: {df.columns.tolist()}")
    
    df.columns = [str(c).strip().lower().replace(' ', '_') for c in df.columns]
    print(f"Normalized columns: {df.columns.tolist()}")
    
    column_map = {
        'merchant_name': ['merchant_name', 'merchant', 'name'],
        'product_name': ['product_name', 'product', 'subscription_name', 'plan'],
        'amount': ['amount', 'price', 'cost', 'monthly_price', 'price_gbp'],
        'currency': ['currency', 'ccy'],
        'recurrence': ['recurrence', 'recurrence_period', 'frequency', 'billing_frequency'],
        'type': ['type', 'subscription_type', 'category_type'],
        'category': ['category', 'sector', 'industry']
    }
    
    def find_column(cols, candidates):
        for c in candidates:
            if c in cols:
                return c
        return None
    
    merchant_col = find_column(df.columns, column_map['merchant_name'])
    product_col = find_column(df.columns, column_map['product_name'])
    amount_col = find_column(df.columns, column_map['amount'])
    currency_col = find_column(df.columns, column_map['currency'])
    recurrence_col = find_column(df.columns, column_map['recurrence'])
    type_col = find_column(df.columns, column_map['type'])
    category_col = find_column(df.columns, column_map['category'])
    
    print(f"\nColumn mapping:")
    print(f"  merchant: {merchant_col}")
    print(f"  product: {product_col}")
    print(f"  amount: {amount_col}")
    print(f"  currency: {currency_col}")
    print(f"  recurrence: {recurrence_col}")
    print(f"  type: {type_col}")
    print(f"  category: {category_col}")
    
    database_url = os.environ.get('DATABASE_URL')
    if not database_url:
        raise ValueError("DATABASE_URL environment variable not set")
    
    conn = psycopg2.connect(database_url)
    cur = conn.cursor()
    
    cur.execute("DELETE FROM subscription_catalog")
    print(f"\nCleared existing subscription_catalog data")
    
    records = []
    for _, row in df.iterrows():
        merchant = str(row[merchant_col]).strip() if merchant_col and pd.notna(row[merchant_col]) else None
        product = str(row[product_col]).strip() if product_col and pd.notna(row[product_col]) else None
        
        if not merchant or merchant == 'nan':
            continue
        if not product or product == 'nan':
            product = "Standard"
        
        amount_raw = row[amount_col] if amount_col and pd.notna(row[amount_col]) else None
        amount_cents = None
        if amount_raw is not None:
            try:
                amount_float = float(str(amount_raw).replace('£', '').replace(',', '').strip())
                amount_cents = int(amount_float * 100)
            except:
                pass
        
        currency = str(row[currency_col]).strip() if currency_col and pd.notna(row[currency_col]) else 'GBP'
        recurrence = str(row[recurrence_col]).strip() if recurrence_col and pd.notna(row[recurrence_col]) else 'Monthly'
        sub_type = str(row[type_col]).strip() if type_col and pd.notna(row[type_col]) else 'Subscription'
        category = str(row[category_col]).strip() if category_col and pd.notna(row[category_col]) else 'Other'
        
        if currency == 'nan':
            currency = 'GBP'
        if recurrence == 'nan':
            recurrence = 'Monthly'
        if sub_type == 'nan':
            sub_type = 'Subscription'
        if category == 'nan':
            category = 'Other'
        
        records.append((merchant, product, amount_cents, currency, recurrence, sub_type, category, True))
    
    print(f"\nPrepared {len(records)} records for insertion")
    
    insert_sql = """
        INSERT INTO subscription_catalog 
        (merchant_name, product_name, amount_cents, currency, recurrence_period, subscription_type, category, is_verified)
        VALUES %s
        ON CONFLICT (merchant_name, product_name, amount_cents) DO UPDATE SET
            currency = EXCLUDED.currency,
            recurrence_period = EXCLUDED.recurrence_period,
            subscription_type = EXCLUDED.subscription_type,
            category = EXCLUDED.category,
            is_verified = EXCLUDED.is_verified,
            updated_at = NOW()
    """
    
    execute_values(cur, insert_sql, records)
    conn.commit()
    
    cur.execute("SELECT COUNT(*) FROM subscription_catalog")
    count = cur.fetchone()[0]
    print(f"\nSuccessfully seeded {count} subscriptions to catalog")
    
    cur.execute("SELECT merchant_name, product_name, amount_cents, category FROM subscription_catalog LIMIT 10")
    print("\nSample records:")
    for row in cur.fetchall():
        print(f"  {row[0]} - {row[1]}: £{row[2]/100 if row[2] else 'N/A'} ({row[3]})")
    
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()
