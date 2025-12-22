# Ganalytics - Google Ads YouTube Assets Manager

Web service for managing YouTube video assets in Google Ads App Campaigns (UAC).

## Features

### Reports
- View YouTube video creative statistics (Cost, Impressions, Installs)
- Filter by accounts, campaigns, ad group type (Main/Test)
- Split data by Account and/or Campaign
- Export to CSV
- Sortable table

### Upload Test
- Create test ad groups with YouTube video assets
- Batch upload to multiple campaigns
- Customizable Headlines and Descriptions

## Setup

1. Install dependencies:
```bash
pip install -r requirements.txt
```

2. Create `google-ads.yaml` with your credentials:
```yaml
developer_token: YOUR_DEVELOPER_TOKEN
client_id: YOUR_CLIENT_ID
client_secret: YOUR_CLIENT_SECRET
refresh_token: YOUR_REFRESH_TOKEN
login_customer_id: YOUR_MCC_ID
use_proto_plus: True
```

3. Run the server:
```bash
python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

4. Open http://localhost:8000

## Requirements

- Python 3.10+
- Google Ads API access (Basic or Standard)
- MCC account with linked sub-accounts

## Tech Stack

- **Backend**: FastAPI, google-ads Python library
- **Frontend**: Vanilla JavaScript, CSS
- **Data**: Pandas for aggregation

