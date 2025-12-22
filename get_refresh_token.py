"""
Script to get refresh_token for Google Ads API
"""

from google_auth_oauthlib.flow import InstalledAppFlow

CLIENT_ID = "YOUR_CLIENT_ID"
CLIENT_SECRET = "YOUR_CLIENT_SECRET"

SCOPES = ["https://www.googleapis.com/auth/adwords"]

def main():
    client_config = {
        "installed": {
            "client_id": CLIENT_ID,
            "client_secret": CLIENT_SECRET,
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
