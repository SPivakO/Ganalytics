from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException
import pandas as pd
from datetime import datetime

# ========== SETTINGS ==========
START_DATE = "2025-11-01"
END_DATE = "2025-11-30"

# Filters
ACCOUNT_FILTER = "Spider Fighter Open World"  # Only accounts containing this
CAMPAIGN_FILTER = "Android"                    # Only campaigns containing this
ADGROUP_FILTER = "Main"                        # Only ad groups containing this
# ==============================


def get_all_customers(client, login_customer_id):
    """Get list of all customer accounts"""
    if not login_customer_id:
        return []
    
    ga_service = client.get_service("GoogleAdsService")
    query = """
        SELECT
            customer_client.id,
            customer_client.descriptive_name
        FROM customer_client
        WHERE customer_client.status = 'ENABLED'
          AND customer_client.manager = FALSE
    """
    
    try:
        response = ga_service.search(customer_id=login_customer_id, query=query)
        customers = []
        for row in response:
            name = row.customer_client.descriptive_name
            # Filter by account name
            if ACCOUNT_FILTER and ACCOUNT_FILTER not in name:
                continue
            customers.append({'id': str(row.customer_client.id), 'name': name})
        return customers
    except:
        return [{'id': login_customer_id, 'name': 'Current Account'}]


def get_youtube_assets(client, customer_id, start_date, end_date):
    """Get YouTube video assets data with metrics"""
    ga_service = client.get_service("GoogleAdsService")
    
    # Query with campaign and ad_group filters
    query = f"""
        SELECT
            asset.id,
            asset.name,
            asset.youtube_video_asset.youtube_video_id,
            asset.youtube_video_asset.youtube_video_title,
            campaign.name,
            ad_group.name,
            metrics.cost_micros,
            metrics.impressions,
            metrics.conversions
        FROM ad_group_ad_asset_view
        WHERE 
            asset.type = 'YOUTUBE_VIDEO'
            AND segments.date BETWEEN '{start_date}' AND '{end_date}'
            AND metrics.impressions > 0
            AND campaign.name LIKE '%{CAMPAIGN_FILTER}%'
            AND ad_group.name LIKE '%{ADGROUP_FILTER}%'
    """
    
    try:
        response = ga_service.search(customer_id=customer_id, query=query)
        
        results = []
        for row in response:
            # Get asset name
            asset_name = row.asset.name
            if not asset_name and hasattr(row.asset, 'youtube_video_asset'):
                yt_asset = row.asset.youtube_video_asset
                if hasattr(yt_asset, 'youtube_video_title') and yt_asset.youtube_video_title:
                    asset_name = yt_asset.youtube_video_title
            if not asset_name:
                asset_name = f"Asset_{row.asset.id}"
            
            results.append({
                'asset_name': asset_name,
                'campaign': row.campaign.name,
                'ad_group': row.ad_group.name,
                'cost': row.metrics.cost_micros / 1_000_000 if row.metrics.cost_micros else 0,
                'impressions': row.metrics.impressions or 0,
                'installs': row.metrics.conversions or 0
            })
        
        return results
    except GoogleAdsException as ex:
        print(f"   Error: {ex.failure.errors[0].message}")
        return []


def main():
    # Load client from config file
    client = GoogleAdsClient.load_from_storage("google-ads.yaml")
    login_customer_id = client.login_customer_id.replace('-', '') if client.login_customer_id else None
    
    print(f"Period: {START_DATE} - {END_DATE}")
    print(f"Filters:")
    print(f"  Account contains: '{ACCOUNT_FILTER}'")
    print(f"  Campaign contains: '{CAMPAIGN_FILTER}'")
    print(f"  Ad Group contains: '{ADGROUP_FILTER}'")
    print(f"  Impressions > 0")
    print()
    
    # Get filtered accounts
    customers = get_all_customers(client, login_customer_id)
    print(f"Matching accounts: {len(customers)}\n")
    
    all_data = []
    for c in customers:
        print(f"-> {c['name']} ({c['id']})")
        data = get_youtube_assets(client, c['id'], start_date=START_DATE, end_date=END_DATE)
        if data:
            print(f"   Records: {len(data)}")
            all_data.extend(data)
    
    if not all_data:
        print("\nNo data found")
        return
    
    # Aggregate by Asset Name and Campaign
    df = pd.DataFrame(all_data)
    result = df.groupby(['asset_name', 'campaign']).agg({
        'cost': 'sum',
        'impressions': 'sum',
        'installs': 'sum'
    }).reset_index()
    
    # Sort by cost (descending)
    result = result.sort_values('cost', ascending=False)
    
    # Round values
    result['cost'] = result['cost'].round(2)
    result['installs'] = result['installs'].round(0).astype(int)
    
    # Save to file
    filename = f"youtube_creatives_{START_DATE}_{END_DATE}.csv"
    result.to_csv(filename, index=False, encoding='utf-8-sig')
    
    print(f"\n{'='*60}")
    print(f"Saved: {filename}")
    print(f"Creatives: {len(result)}")
    print(f"Total Cost: ${result['cost'].sum():,.2f}")
    print(f"Total Impressions: {result['impressions'].sum():,.0f}")
    print(f"Total Installs: {result['installs'].sum():,.0f}")
    print(f"{'='*60}\n")
    
    # Print top 20
    print("Top 20 by Cost:")
    print("-" * 80)
    top20 = result.head(20)
    for _, row in top20.iterrows():
        name = row['asset_name'][:35] if len(row['asset_name']) > 35 else row['asset_name']
        camp = row['campaign'][:25] if len(row['campaign']) > 25 else row['campaign']
        print(f"${row['cost']:>9,.2f} | {row['impressions']:>10,.0f} | {row['installs']:>7,} | {camp:<25} | {name}")


if __name__ == "__main__":
    main()
