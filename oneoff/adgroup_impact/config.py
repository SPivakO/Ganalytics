"""Shared configuration for the one-off ad group impact report."""

import os
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent
REPO_ROOT = BASE_DIR.parent.parent
RAW_DIR = BASE_DIR / "raw"
OUT_DIR = BASE_DIR / "out"
PROBE_RESULT = BASE_DIR / "probe_result.json"

load_dotenv(REPO_ROOT / ".env")

# Adjust app tokens, mirroring the picker in static/index.html:441-446.
APPS = {
    "yypucqxkbu9s": "Spider OW",
    "fh5kbuwv8f7k": "Cars Royale",
    "cwzj9drvxa0w": "Gangs Fighter",
}

DEFAULT_START = "2024-01-01"
DEFAULT_END = "2026-06-30"

# Android only for this report.
PLATFORM = "Android"
STORE_TYPE = "google_play"

# Filter at network level, not channel. The "Google Ads" channel also carries
# "Google Ads (Ad Spend)" (all the cost, no installs) and "Google Ads ACE", so a
# channel-level pull mixes feeds that belong to different rows.
NETWORK = "Google Ads ACI"

# Revenue is AppLovin MAX only. Without this filter Adjust counts every connected ad
# revenue source and roas_d1 comes back roughly 1.85x the figure the Adjust UI reports.
# The value must go through unquoted — "Applovin MAX SDK" in quotes is rejected, and
# note the lowercase l, which is how Adjust spells it.
AD_REVENUE_SOURCE = "Applovin MAX SDK"


def adjust_token() -> str:
    token = os.environ.get("ADJUST_API_TOKEN", "").strip()
    if not token:
        raise SystemExit("ADJUST_API_TOKEN is not set (put it in the repo-root .env)")
    return token


def google_ads_config() -> dict:
    """Same env-var contract as app.py:get_client()."""
    config = {
        "developer_token": os.getenv("ADS_DEVELOPER_TOKEN"),
        "refresh_token": os.getenv("ADS_REFRESH_TOKEN"),
        "client_id": os.getenv("ADS_CLIENT_ID"),
        "client_secret": os.getenv("ADS_CLIENT_SECRET"),
        "login_customer_id": os.getenv("ADS_LOGIN_CUSTOMER_ID"),
        "use_proto_plus": os.getenv("ADS_USE_PROTO_PLUS", "True") == "True",
    }
    missing = [k for k, v in config.items() if v is None and k != "use_proto_plus"]
    if missing:
        raise SystemExit(f"Missing Google Ads env vars: {', '.join('ADS_' + m.upper() for m in missing)}")
    return {k: v for k, v in config.items() if v is not None}


def ensure_dirs() -> None:
    RAW_DIR.mkdir(parents=True, exist_ok=True)
    OUT_DIR.mkdir(parents=True, exist_ok=True)
