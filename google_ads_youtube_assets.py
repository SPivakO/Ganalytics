import os
import csv
from dotenv import load_dotenv
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

load_dotenv()

# Settings
START_DATE = "2024-01-01"
END_DATE = "2024-03-31"
ACCOUNT_FILTER = ""  # Filter accounts by name
CAMPAIGN_FILTER = ""  # Filter campaigns by name
ADGROUP_FILTER = ""   # Filter ad groups by name

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
    """Get YouTube video assets and their performance metrics"""
    ga_service = client.get_service("GoogleAdsService")
    
    query = f"""
        SELECT
            asset.id,
            asset.name,
            asset.youtube_video_asset.youtube_video_id,
            campaign.name,
            ad_group.name,
            metrics.cost_micros,
            metrics.impressions,
            metrics.conversions
        FROM ad_group_ad_asset_view
        WHERE segments.date BETWEEN '{start_date}' AND '{end_date}'
          AND asset.type = 'YOUTUBE_VIDEO'
          AND metrics.impressions > 0
    """
    
    if CAMPAIGN_FILTER:
        query += f" AND campaign.name LIKE '%{CAMPAIGN_FILTER}%'"
    if ADGROUP_FILTER:
        query += f" AND ad_group.name LIKE '%{ADGROUP_FILTER}%'"

    try:
        response = ga_service.search(customer_id=customer_id, query=query)
        results = []
        for row in response:
            results.append({
                'asset_id': row.asset.id,
                'asset_name': row.asset.name or row.asset.youtube_video_asset.youtube_video_id,
                'campaign': row.campaign.name,
                'cost': row.metrics.cost_micros / 1000000.0,
                'impressions': row.metrics.impressions,
                'installs': row.metrics.conversions
            })
        return results
    except GoogleAdsException as ex:
        print(f"   Error: {ex.failure.errors[0].message}")
        return []


def main():
    # Load configuration exclusively from environment variables
    config = {
        "developer_token": os.getenv("ADS_DEVELOPER_TOKEN"),
        "refresh_token": os.getenv("ADS_REFRESH_TOKEN"),
        "client_id": os.getenv("ADS_CLIENT_ID"),
        "client_secret": os.getenv("ADS_CLIENT_SECRET"),
        "login_customer_id": os.getenv("ADS_LOGIN_CUSTOMER_ID"),
        "use_proto_plus": os.getenv("ADS_USE_PROTO_PLUS", "True") == "True"
    }
    # Filter out None values
    config = {k: v for k, v in config.items() if v is not None}
    client = GoogleAdsClient.load_from_dict(config)
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
    
    # Aggregate by Asset Name and Campaign using dictionary
    aggregated = {}
    for item in all_data:
        key = (item['asset_name'], item['campaign'])
        if key not in aggregated:
            aggregated[key] = {
                'asset_name': item['asset_name'],
                'campaign': item['campaign'],
                'cost': 0.0,
                'impressions': 0,
                'installs': 0.0
            }
        aggregated[key]['cost'] += item['cost']
        aggregated[key]['impressions'] += item['impressions']
        aggregated[key]['installs'] += item['installs']
    
    # Convert to list and sort by cost descending
    result_list = list(aggregated.values())
    result_list.sort(key=lambda x: x['cost'], reverse=True)
    
    # Round values and format for output
    for item in result_list:
        item['cost'] = round(item['cost'], 2)
        item['installs'] = int(round(item['installs'], 0))
    
    # Save to file using csv module
    filename = f"youtube_creatives_{START_DATE}_{END_DATE}.csv"
    with open(filename, mode='w', newline='', encoding='utf-8-sig') as f:
        writer = csv.DictWriter(f, fieldnames=['asset_name', 'campaign', 'cost', 'impressions', 'installs'])
        writer.writeheader()
        writer.writerows(result_list)
    
    print(f"\n{'='*60}")
    print(f"Saved: {filename}")
    print(f"Creatives: {len(result_list)}")
    print(f"Total Cost: ${sum(i['cost'] for i in result_list):,.2f}")
    print(f"Total Impressions: {sum(i['impressions'] for i in result_list):,.0f}")
    print(f"Total Installs: {sum(i['installs'] for i in result_list):,.0f}")
    print(f"{'='*60}\n")
    
    # Print top 20
    print("Top 20 by Cost:")
    print("-" * 80)
    top20 = result_list[:20]
    for row in top20:
        name = row['asset_name'][:35] if len(row['asset_name']) > 35 else row['asset_name']
        camp = row['campaign'][:25] if len(row['campaign']) > 25 else row['campaign']
        print(f"${row['cost']:>9,.2f} | {row['impressions']:>10,.0f} | {row['installs']:>7,} | {camp:<25} | {name}")


if __name__ == "__main__":
    main()