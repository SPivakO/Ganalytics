"""
Script to get refresh_token for Google Ads API
Reads client_id and client_secret from google-ads.yaml
"""

import yaml
from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/adwords"]

def main():
    # Load credentials from google-ads.yaml
    try:
        with open("google-ads.yaml", "r") as f:
            config = yaml.safe_load(f)
    except FileNotFoundError:
        print("ERROR: google-ads.yaml not found!")
        print("Create google-ads.yaml with client_id and client_secret")
        return
    
    client_id = config.get("client_id")
    client_secret = config.get("client_secret")
    
    if not client_id or not client_secret:
        print("ERROR: client_id or client_secret not found in google-ads.yaml")
        return
    
    client_config = {
        "installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": "https://oauth2.googleapis.com/token",
        }
    }

    flow = InstalledAppFlow.from_client_config(client_config, scopes=SCOPES)
    
    # Starts local server for OAuth
    credentials = flow.run_local_server(port=8080)
    
    print("\n" + "="*60)
    print("REFRESH TOKEN (copy to google-ads.yaml):")
    print("="*60)
    print(f"\n{credentials.refresh_token}\n")
    print("="*60)

if __name__ == "__main__":
    main()
