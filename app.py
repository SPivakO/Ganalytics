import os
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware
from authlib.integrations.starlette_client import OAuth
from pydantic import BaseModel
from typing import List, Optional, Any
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException
import pandas as pd
import re
import json
import csv
import io
from urllib import request as urlrequest
from urllib import parse as urlparse
from urllib.error import HTTPError, URLError

load_dotenv()

app = FastAPI(title="Google Ads YouTube Assets Report")

# Добавляем middleware для сессий (хранение в Cookie)
app.add_middleware(
    SessionMiddleware, 
    secret_key=os.getenv("OAUTH_SECRET_KEY", "replace-with-secure-key")
)

# Настройка OAuth
oauth = OAuth()
oauth.register(
    name='google',
    client_id=os.getenv("OAUTH_GOOGLE_CLIENT_ID"),
    client_secret=os.getenv("OAUTH_GOOGLE_CLIENT_SECRET"),
    server_metadata_url='https://accounts.google.com/.well-known/openid-configuration',
    client_kwargs={'scope': 'openid email profile'}
)

def get_current_user(request: Request) -> Any:
    user = request.session.get('user')
    if not user:
        raise HTTPException(status_code=401, detail="Not authenticated")
    return user

# Mount static files
app.mount("/static", StaticFiles(directory="static"), name="static")

# Global client
_client = None

def get_client():
    global _client
    if _client is None:
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
        _client = GoogleAdsClient.load_from_dict(config)
    return _client


def normalize_asset_name(name: str) -> str:
    """Remove format suffixes like 9x16, 1x1, 16x9 from asset name"""
    # Remove common format patterns
    # Matches: 9x16, 16x9, 1x1, 4x5, 9:16, 16:9, etc.
    normalized = re.sub(r'\s*[\-_]?\s*\d+[x:]\d+\s*$', '', name, flags=re.IGNORECASE)
    # Also remove if it's in the middle with separators
    normalized = re.sub(r'\s+\d+[x:]\d+\s+', ' ', normalized)
    # Remove trailing spaces and common separators
    normalized = normalized.strip(' -_')
    return normalized


class ReportRequest(BaseModel):
    account_ids: List[str]
    campaign_ids: List[str]
    adgroup_type: str  # "main" or "test"
    test_date: Optional[str] = None  # e.g. "181225"
    start_date: str
    end_date: str
    group_by_account: bool = False
    group_by_campaign: bool = True


class DashboardRequest(BaseModel):
    adgroup_type: str  # "main" or "test"
    test_date: Optional[str] = None
    start_date: str
    end_date: str
    platform: str  # "Android" or "iOS"
    adjust_app_token: str
    top_n: int = 10


def normalize_applovin_creative(name: str) -> str:
    """Remove Applovin hash prefix (MD5 hash only)"""
    if not name:
        return name
    normalized = re.sub(r'^[a-f0-9]{32}_', '', name, flags=re.IGNORECASE)
    return normalized


def _platform_substr(platform: str) -> str:
    p = (platform or "").strip().lower()
    if p == "ios":
        return "ios"
    return "android"


def _platform_keyword(platform: str) -> str:
    p = (platform or "").strip().lower()
    return "iOS" if p == "ios" else "Android"


def _safe_contains_platform(name: str, platform: str) -> bool:
    if not name:
        return False
    return _platform_substr(platform) in name.lower()


def _make_date_range(start_date: str, end_date: str) -> List[str]:
    dr = pd.date_range(start=start_date, end=end_date, freq="D")
    return [d.strftime("%Y-%m-%d") for d in dr]


def _build_stacked_100(dates: List[str], rows: List[dict], key_field: str, date_field: str, value_field: str, top_n: int):
    if not rows:
        return {"dates": dates, "series": []}
    df = pd.DataFrame(rows)
    if df.empty:
        return {"dates": dates, "series": []}

    df[value_field] = pd.to_numeric(df[value_field], errors="coerce").fillna(0.0)
    df[date_field] = df[date_field].astype(str)
    df[key_field] = df[key_field].fillna("").astype(str)
    df = df[(df[key_field] != "") & (df[value_field] > 0)]
    if df.empty:
        return {"dates": dates, "series": []}

    totals = df.groupby(key_field)[value_field].sum().sort_values(ascending=False).head(top_n)
    top_keys = list(totals.index)
    df = df[df[key_field].isin(top_keys)]

    pivot = df.pivot_table(index=date_field, columns=key_field, values=value_field, aggfunc="sum", fill_value=0.0)
    pivot = pivot.reindex(dates, fill_value=0.0)

    daily_total = pivot.sum(axis=1)
    pct = pivot.div(daily_total.replace({0: pd.NA}), axis=0).fillna(0.0) * 100.0

    series = []
    for k in top_keys:
        if k not in pct.columns:
            continue
        series.append({
            "name": k,
            "dataPct": [float(x) for x in pct[k].values],
            "dataCost": [float(x) for x in pivot[k].values],
        })
    return {"dates": dates, "series": series}


def _adjust_request(url: str, api_token: str, method: str = "GET", json_body: Optional[dict] = None):
    headers_variants = [
        {"Authorization": f"Bearer {api_token}", "Accept": "*/*"},
        {"Authorization": f"Token token={api_token}", "Accept": "*/*"},
    ]
    data = None
    if json_body is not None:
        data = json.dumps(json_body).encode("utf-8")
    last_err = None
    for headers in headers_variants:
        try:
            h = dict(headers)
            if data is not None:
                h["Content-Type"] = "application/json"
            req = urlrequest.Request(url, headers=h, method=method, data=data)
            with urlrequest.urlopen(req, timeout=60) as resp:
                content_type = resp.headers.get("Content-Type", "")
                body = resp.read()
                return {"status": getattr(resp, "status", 200), "content_type": content_type, "body": body, "method": method}
        except HTTPError as e:
            try:
                body = e.read()
            except Exception:
                body = b""
            last_err = RuntimeError(f"Adjust HTTPError {e.code}: {e.reason}. Body: {body[:300]!r}")
        except URLError as e:
            last_err = RuntimeError(f"Adjust URLError: {e.reason}")
        except Exception as e:
            last_err = e
            continue
    raise last_err or RuntimeError("Adjust request failed")


def _parse_adjust_payload(content_type: str, body: bytes) -> List[dict]:
    text = body.decode("utf-8", errors="replace")
    ct = (content_type or "").lower()
    if "text/html" in ct or text.lstrip().lower().startswith("<!doctype") or text.lstrip().lower().startswith("<html"):
        raise RuntimeError(f"Adjust returned HTML, not data. Snippet: {text[:300]!r}")
    if "application/json" in ct or text.strip().startswith("{") or text.strip().startswith("["):
        data = json.loads(text)
        if isinstance(data, dict):
            for k in ("rows", "data", "result", "results"):
                if k in data and isinstance(data[k], list):
                    return data[k]
        if isinstance(data, list):
            return data
        return []
    f = io.StringIO(text)
    reader = csv.DictReader(f)
    return [row for row in reader]


def _norm_key(k: str) -> str:
    k = (k or "").strip().lower()
    k = re.sub(r"[^a-z0-9]+", "_", k)
    k = re.sub(r"_+", "_", k).strip("_")
    return k


def _looks_like_date_key(s: str) -> bool:
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", (s or "").strip()))


def _flatten_adjust_rows(rows: List[dict]) -> List[dict]:
    out: List[dict] = []
    for r in rows:
        if not isinstance(r, dict) or not r:
            continue
        found_nested = False
        for k, v in r.items():
            if _looks_like_date_key(k):
                found_nested = True
                day = k
                inner_rows = []
                if isinstance(v, dict):
                    if isinstance(v.get("rows"), list):
                        inner_rows = v["rows"]
                    elif isinstance(v.get("data"), list):
                        inner_rows = v["data"]
                    else:
                        ii = dict(v)
                        ii["day"] = day
                        out.append(ii)
                        continue
                elif isinstance(v, list):
                    inner_rows = v
                for inner in inner_rows:
                    if isinstance(inner, dict):
                        ii = dict(inner)
                        ii["day"] = day
                        out.append(ii)
        if found_nested:
            continue
        out.append(r)
    return out


def _store_type_for_platform(platform: str) -> str:
    p = (platform or "").strip().lower()
    return "app_store" if p == "ios" else "google_play"


def _fetch_adjust_creative_daily_cost(api_token: str, app_token: str, channel_id: str, start_date: str, end_date: str, platform: str):
    base = "https://automate.adjust.com/reports-service/pivot_report"
    date_period = f"{start_date}:{end_date}"
    store_type = _store_type_for_platform(platform)
    params = {
        "app_token__in": f"\"{app_token}\"",
        "channel_id__in": f"\"{channel_id}\"",
        "index": "day",
        "dimensions": "creative_network,campaign",
        "metrics": "cost",
        "date_period": date_period,
        "ad_spend_mode": "network",
        "attribution_source": "first",
        "reattributed": "all",
        "sandbox": "false",
        "cohort_maturity": "immature",
        "store_type__in": f"\"{store_type}\"",
        "format_dates": "true",
        "full_data": "true",
        "readable_names": "true",
    }
    url = base + "?" + urlparse.urlencode(params, safe=",:\"")
    try:
        resp = _adjust_request(url, api_token=api_token, method="GET")
        raw_body = resp.get("body", b"") or b""
        rows = _parse_adjust_payload(resp.get("content_type", ""), raw_body)
    except Exception as e:
        msg = str(e)
        if "loc\":[\"index\"]" in msg or "loc\":[\"date_period\"]" in msg or "validation_error" in msg:
            payload_variants = [
                {
                    "app_token__in": f"\"{app_token}\"",
                    "channel_id__in": f"\"{channel_id}\"",
                    "index": "day",
                    "dimensions": "creative_network,campaign",
                    "metrics": "cost",
                    "date_period": date_period,
                    "format_dates": False,
                    "full_data": True,
                    "readable_names": True,
                },
                {
                    "index": "day",
                    "dimensions": ["creative_network", "campaign"],
                    "metrics": ["cost"],
                    "date_period": date_period,
                    "filters": {
                        "app_token__in": [app_token],
                        "channel_id__in": [channel_id],
                    },
                    "readable_names": True,
                    "full_data": True,
                },
            ]
            last = None
            for payload in payload_variants:
                try:
                    resp = _adjust_request(base, api_token=api_token, method="POST", json_body=payload)
                    raw_body = resp.get("body", b"") or b""
                    rows = _parse_adjust_payload(resp.get("content_type", ""), raw_body)
                    break
                except Exception as e2:
                    last = e2
                    rows = None
            if rows is None:
                raise last or e
        else:
            raise

    debug = {
        "content_type": resp.get("content_type", ""),
        "method": resp.get("method", "GET"),
        "body_len": len(raw_body) if 'raw_body' in locals() and raw_body is not None else None,
        "snippet": (raw_body[:200].decode("utf-8", errors="replace") if 'raw_body' in locals() and raw_body is not None else ""),
        "first_row_keys": [],
    }

    rows = _flatten_adjust_rows(rows)

    norm = []
    for r in rows:
        if isinstance(r, dict):
            rr = {_norm_key(k): v for k, v in r.items()}
        else:
            continue
        if not debug["first_row_keys"] and rr:
            debug["first_row_keys"] = list(rr.keys())[:40]

        day = rr.get("day") or rr.get("date")
        creative = rr.get("creative_network") or rr.get("creative") or rr.get("creative_name")
        campaign = rr.get("campaign") or rr.get("campaign_name")
        cost = rr.get("cost") or rr.get("spend") or rr.get("ad_spend")
        if not day or not creative:
            continue
        try:
            cost_val = float(cost) if cost is not None and cost != "" else 0.0
        except:
            cost_val = 0.0
        norm.append({"day": str(day)[:10], "creative_network": str(creative), "campaign": str(campaign or ""), "cost": cost_val})
    return norm, debug


@app.get("/")
async def root(request: Request):
    user = request.session.get('user')
    if not user:
        return RedirectResponse(url='/api/auth/login')
    return FileResponse("static/index.html")


@app.get("/api/auth/login")
async def login(request: Request):
    # Try to get fixed Redirect URI from environment variables
    redirect_uri = os.getenv("OAUTH_REDIRECT_URI")
    if not redirect_uri:
        # Fallback to automatic detection
        redirect_uri = str(request.url_for('auth_callback'))
    
    # Force HTTPS if we are on the production domain
    if "starplay.work" in redirect_uri and redirect_uri.startswith("http://"):
        redirect_uri = redirect_uri.replace("http://", "https://", 1)
        
    return await oauth.google.authorize_redirect(request, redirect_uri)


@app.get("/api/auth/callback/google")
async def auth_callback(request: Request):
    token = await oauth.google.authorize_access_token(request)
    user = token.get('userinfo')
    if user:
        request.session['user'] = dict(user)
    return RedirectResponse(url='/')


@app.get("/api/auth/logout")
async def logout(request: Request):
    request.session.pop('user', None)
    return RedirectResponse(url='/')


@app.get("/api/accounts")
async def get_accounts(user: dict[str, Any] = Depends(get_current_user)):
    """Get all available accounts"""
    client = get_client()
    login_customer_id = client.login_customer_id.replace('-', '') if client.login_customer_id else None
    
    if not login_customer_id:
        raise HTTPException(status_code=500, detail="No login_customer_id configured")
    
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
        accounts = []
        for row in response:
            accounts.append({
                'id': str(row.customer_client.id),
                'name': row.customer_client.descriptive_name
            })
        return {"accounts": sorted(accounts, key=lambda x: x['name'])}
    except GoogleAdsException as ex:
        raise HTTPException(status_code=500, detail=str(ex.failure.errors[0].message))


@app.get("/api/campaigns")
async def get_campaigns(account_ids: str, start_date: str, end_date: str, user: dict[str, Any] = Depends(get_current_user)):
    """Get campaigns for selected accounts that have spend in the date range"""
    client = get_client()
    ga_service = client.get_service("GoogleAdsService")
    
    account_list = account_ids.split(',')
    all_campaigns = []
    
    # Query campaigns with spend in the date range
    query = f"""
        SELECT
            campaign.id,
            campaign.name,
            metrics.cost_micros
        FROM campaign
        WHERE campaign.status != 'REMOVED'
          AND segments.date BETWEEN '{start_date}' AND '{end_date}'
          AND metrics.cost_micros > 0
    """
    
    for account_id in account_list:
        try:
            response = ga_service.search(customer_id=account_id.strip(), query=query)
            seen_campaigns = set()
            for row in response:
                campaign_key = f"{account_id}_{row.campaign.id}"
                if campaign_key not in seen_campaigns:
                    seen_campaigns.add(campaign_key)
                    all_campaigns.append({
                        'id': campaign_key,
                        'campaign_id': str(row.campaign.id),
                        'account_id': account_id,
                        'name': row.campaign.name
                    })
        except:
            continue
    
    # Remove duplicates by name and sort
    unique_campaigns = {}
    for c in all_campaigns:
        if c['name'] not in unique_campaigns:
            unique_campaigns[c['name']] = c
    
    return {"campaigns": sorted(list(unique_campaigns.values()), key=lambda x: x['name'])}


@app.post("/api/report")
async def generate_report(request: ReportRequest, user: dict[str, Any] = Depends(get_current_user)):
    """Generate report with filters"""
    client = get_client()
    ga_service = client.get_service("GoogleAdsService")
    
    # Fetch account names first
    accounts_resp = await get_accounts(user)
    state_accounts = accounts_resp.get('accounts', [])
    
    # Build adgroup filter
    if request.adgroup_type == "main":
        adgroup_filter = "Main"
    else:
        adgroup_filter = request.test_date or ""
    
    # Build campaign names filter from campaign_ids
    campaign_names = []
    for cid in request.campaign_ids:
        parts = cid.split('_', 1)
        if len(parts) > 1:
            # Extract campaign name from the ID (we stored account_campaignId)
            pass
    
    all_results = []
    
    for account_id in request.account_ids:
        # Get campaign names for this account from selected campaign_ids
        account_campaigns = [c.split('_', 1)[1] if '_' in c else c 
                           for c in request.campaign_ids 
                           if c.startswith(account_id)]
        
        if not account_campaigns and request.campaign_ids:
            # Check if any campaign_ids match this account
            continue
        
        query = f"""
            SELECT
                asset.id,
                asset.name,
                asset.youtube_video_asset.youtube_video_id,
                asset.youtube_video_asset.youtube_video_title,
                campaign.id,
                campaign.name,
                ad_group.name,
                metrics.cost_micros,
                metrics.impressions,
                metrics.conversions
            FROM ad_group_ad_asset_view
            WHERE 
                asset.type = 'YOUTUBE_VIDEO'
                AND segments.date BETWEEN '{request.start_date}' AND '{request.end_date}'
                AND metrics.impressions > 0
                AND ad_group.name LIKE '%{adgroup_filter}%'
        """
        
        try:
            response = ga_service.search(customer_id=account_id, query=query)
            
            for row in response:
                # Filter by campaign if specified
                if request.campaign_ids:
                    campaign_key = f"{account_id}_{row.campaign.id}"
                    if campaign_key not in request.campaign_ids:
                        continue
                
                # Get asset name
                asset_name = row.asset.name
                if not asset_name and hasattr(row.asset, 'youtube_video_asset'):
                    yt_asset = row.asset.youtube_video_asset
                    if hasattr(yt_asset, 'youtube_video_title') and yt_asset.youtube_video_title:
                        asset_name = yt_asset.youtube_video_title
                if not asset_name:
                    asset_name = f"Asset_{row.asset.id}"
                
                # Normalize asset name (remove format suffixes)
                normalized_name = normalize_asset_name(asset_name)
                
                # Get account name from state.accounts
                account_name = account_id
                for acc in state_accounts:
                    if acc['id'] == account_id:
                        account_name = acc['name']
                        break
                
                all_results.append({
                    'asset_name': normalized_name,
                    'asset_name_original': asset_name,
                    'account': account_name,
                    'account_id': account_id,
                    'campaign': row.campaign.name,
                    'ad_group': row.ad_group.name,
                    'cost': row.metrics.cost_micros / 1_000_000 if row.metrics.cost_micros else 0,
                    'impressions': row.metrics.impressions or 0,
                    'installs': row.metrics.conversions or 0
                })
        except GoogleAdsException as ex:
            continue
    
    if not all_results:
        return {
            "data": [],
            "totals": {"cost": 0, "impressions": 0, "installs": 0},
            "count": 0
        }
    
    # Aggregate by Asset Name (and optionally Account/Campaign)
    aggregated = {}
    for item in all_results:
        # Create a key based on grouping
        key_parts = [item['asset_name']]
        if request.group_by_account:
            key_parts.append(item['account'])
        if request.group_by_campaign:
            key_parts.append(item['campaign'])
        
        key = tuple(key_parts)
        
        if key not in aggregated:
            aggregated[key] = {
                'asset_name': item['asset_name'],
                'account': item['account'] if request.group_by_account else '',
                'campaign': item['campaign'] if request.group_by_campaign else '',
                'cost': 0.0,
                'impressions': 0,
                'installs': 0
            }
        
        aggregated[key]['cost'] += item['cost']
        aggregated[key]['impressions'] += item['impressions']
        aggregated[key]['installs'] += item['installs']
    
    # Convert to list
    result_list = list(aggregated.values())
    
    # Sort by cost descending
    result_list.sort(key=lambda x: x['cost'], reverse=True)
    
    # Round and cast values
    for item in result_list:
        item['cost'] = round(item['cost'], 2)
        item['installs'] = int(round(item['installs'], 0))
        item['impressions'] = int(item['impressions'])
    
    # Calculate totals
    totals = {
        "cost": round(sum(item['cost'] for item in result_list), 2),
        "impressions": int(sum(item['impressions'] for item in result_list)),
        "installs": int(sum(item['installs'] for item in result_list))
    }
    
    return {
        "data": result_list,
        "totals": totals,
        "count": len(result_list)
    }


@app.post("/api/dashboard")
async def dashboard(req: Request, body: DashboardRequest, user: dict[str, Any] = Depends(get_current_user)):
    """
    Dashboard: 3 charts (Google/AppLovin/Mintegral) - top N creatives by spend over period,
    shown as % of daily spend (100% stacked).
    Adjust token is read from ADJUST_API_TOKEN env variable.
    """
    adjust_token = os.environ.get("ADJUST_API_TOKEN", "").strip()
    if not adjust_token:
        raise HTTPException(status_code=500, detail="ADJUST_API_TOKEN not configured on server")
    if not body.adjust_app_token:
        raise HTTPException(status_code=400, detail="Missing adjust_app_token")

    dates = _make_date_range(body.start_date, body.end_date)
    platform = body.platform or "Android"
    platform_sub = _platform_substr(platform)
    platform_kw = _platform_keyword(platform)

    # -------- Google (daily cost by asset_name) --------
    client = get_client()
    ga_service = client.get_service("GoogleAdsService")
    accounts_resp = await get_accounts(user)
    state_accounts = accounts_resp.get('accounts', [])
    google_accounts = [a for a in state_accounts if "Spider Fighter Open World" in (a.get("name") or "")]

    if body.adgroup_type == "main":
        adgroup_filter = "Main"
    else:
        adgroup_filter = body.test_date or ""

    google_rows = []
    for acc in google_accounts:
        account_id = acc["id"]
        query = f"""
            SELECT
                segments.date,
                asset.id,
                asset.name,
                asset.youtube_video_asset.youtube_video_title,
                campaign.id,
                campaign.name,
                ad_group.name,
                metrics.cost_micros
            FROM ad_group_ad_asset_view
            WHERE
                asset.type = 'YOUTUBE_VIDEO'
                AND segments.date BETWEEN '{body.start_date}' AND '{body.end_date}'
                AND metrics.cost_micros > 0
                AND ad_group.name LIKE '%{adgroup_filter}%'
                AND campaign.name LIKE '%{platform_kw}%'
        """
        try:
            response = ga_service.search(customer_id=account_id, query=query)
            for row in response:
                asset_name = row.asset.name
                if not asset_name and hasattr(row.asset, 'youtube_video_asset'):
                    yt_asset = row.asset.youtube_video_asset
                    if hasattr(yt_asset, 'youtube_video_title') and yt_asset.youtube_video_title:
                        asset_name = yt_asset.youtube_video_title
                if not asset_name:
                    asset_name = f"Asset_{row.asset.id}"
                normalized_name = normalize_asset_name(asset_name)

                google_rows.append({
                    "day": str(row.segments.date),
                    "creative": normalized_name,
                    "cost": (row.metrics.cost_micros / 1_000_000) if row.metrics.cost_micros else 0.0
                })
        except GoogleAdsException:
            continue

    google_chart = _build_stacked_100(
        dates=dates,
        rows=google_rows,
        key_field="creative",
        date_field="day",
        value_field="cost",
        top_n=body.top_n
    )

    # -------- Adjust (AppLovin + Mintegral) --------
    def build_adjust_channel(channel_id: str):
        raw, debug = _fetch_adjust_creative_daily_cost(
            api_token=adjust_token,
            app_token=body.adjust_app_token,
            channel_id=channel_id,
            start_date=body.start_date,
            end_date=body.end_date,
            platform=platform
        )
        filtered = [r for r in raw if _safe_contains_platform(r.get("campaign", ""), platform_sub)]
        rows = [{"day": r["day"], "creative_network": normalize_applovin_creative(r["creative_network"]), "cost": r["cost"]} for r in filtered]
        chart = _build_stacked_100(
            dates=dates,
            rows=rows,
            key_field="creative_network",
            date_field="day",
            value_field="cost",
            top_n=body.top_n
        )
        meta = {
            "raw_rows": len(raw),
            "filtered_rows": len(filtered),
            "platform_sub": platform_sub,
            "channel_id": channel_id,
            "debug": debug,
        }
        return chart, meta

    try:
        applovin_chart, applovin_meta = build_adjust_channel("partner_7")
        applovin_error = None
    except Exception as e:
        applovin_chart, applovin_meta = {"dates": dates, "series": []}, {"raw_rows": 0, "filtered_rows": 0, "channel_id": "partner_7", "platform_sub": platform_sub}
        applovin_error = str(e)
        print(f"[dashboard] Adjust AppLovin error: {applovin_error}")

    try:
        mintegral_chart, mintegral_meta = build_adjust_channel("partner_369")
        mintegral_error = None
    except Exception as e:
        mintegral_chart, mintegral_meta = {"dates": dates, "series": []}, {"raw_rows": 0, "filtered_rows": 0, "channel_id": "partner_369", "platform_sub": platform_sub}
        mintegral_error = str(e)
        print(f"[dashboard] Adjust Mintegral error: {mintegral_error}")

    return {
        "google": google_chart,
        "applovin": applovin_chart,
        "mintegral": mintegral_chart,
        "meta": {
            "applovin": applovin_meta,
            "mintegral": mintegral_meta,
            "applovin_error": applovin_error,
            "mintegral_error": mintegral_error,
        }
    }


# ==================== UPLOAD SECTION ====================

class UploadRequest(BaseModel):
    campaign_ids: List[str]  # Format: "accountId_campaignId"
    adgroup_name: str  # e.g. "211225"
    youtube_urls: List[str]  # YouTube video URLs
    headlines: List[str]  # Headlines from UI
    descriptions: List[str]  # Descriptions from UI

def parse_youtube_url(url: str) -> Optional[str]:
    """Extract video ID from various YouTube URL formats"""
    url = url.strip()
    
    # Already just an ID
    if re.match(r'^[a-zA-Z0-9_-]{11}$', url):
        return url
    
    # youtu.be/VIDEO_ID
    match = re.search(r'youtu\.be/([a-zA-Z0-9_-]{11})', url)
    if match:
        return match.group(1)
    
    # youtube.com/watch?v=VIDEO_ID
    match = re.search(r'[?&]v=([a-zA-Z0-9_-]{11})', url)
    if match:
        return match.group(1)
    
    # youtube.com/embed/VIDEO_ID
    match = re.search(r'/embed/([a-zA-Z0-9_-]{11})', url)
    if match:
        return match.group(1)
    
    # youtube.com/v/VIDEO_ID
    match = re.search(r'/v/([a-zA-Z0-9_-]{11})', url)
    if match:
        return match.group(1)
    
    # youtube.com/shorts/VIDEO_ID
    match = re.search(r'/shorts/([a-zA-Z0-9_-]{11})', url)
    if match:
        return match.group(1)
    
    return None





@app.get("/api/all_campaigns")
async def get_all_campaigns(account_ids: str, user: dict[str, Any] = Depends(get_current_user)):
    """Get ALL campaigns for selected accounts (for upload section)"""
    client = get_client()
    ga_service = client.get_service("GoogleAdsService")
    
    account_list = account_ids.split(',')
    all_campaigns = []
    
    query = """
        SELECT
            campaign.id,
            campaign.name,
            campaign.status
        FROM campaign
        WHERE campaign.status = 'ENABLED'
    """
    
    for account_id in account_list:
        try:
            response = ga_service.search(customer_id=account_id.strip(), query=query)
            for row in response:
                campaign_key = f"{account_id}_{row.campaign.id}"
                all_campaigns.append({
                    'id': campaign_key,
                    'campaign_id': str(row.campaign.id),
                    'account_id': account_id,
                    'name': row.campaign.name
                })
        except:
            continue
    
    return {"campaigns": sorted(all_campaigns, key=lambda x: x['name'])}



@app.post("/api/upload")
async def create_test_adgroup(request: UploadRequest, user: dict[str, Any] = Depends(get_current_user)):
    """Create test ad groups with YouTube videos in selected campaigns"""
    client = get_client()
    
    # Parse YouTube URLs
    video_ids = []
    for url in request.youtube_urls:
        vid = parse_youtube_url(url)
        if vid:
            video_ids.append(vid)
    
    if not video_ids:
        raise HTTPException(status_code=400, detail="No valid YouTube video IDs found")
    
    # Use headlines/descriptions from request, truncate to max lengths
    headlines = [h.strip()[:30] for h in request.headlines if h.strip()][:5]
    descriptions = [d.strip()[:90] for d in request.descriptions if d.strip()][:5]
    
    if not headlines:
        raise HTTPException(status_code=400, detail="At least one headline is required")
    if not descriptions:
        raise HTTPException(status_code=400, detail="At least one description is required")
    
    results = []
    
    # Group campaigns by account
    campaigns_by_account = {}
    for cid in request.campaign_ids:
        parts = cid.split('_', 1)
        if len(parts) == 2:
            account_id, campaign_id = parts
            if account_id not in campaigns_by_account:
                campaigns_by_account[account_id] = []
            campaigns_by_account[account_id].append(campaign_id)
    
    for account_id, campaign_ids in campaigns_by_account.items():
        for campaign_id in campaign_ids:
            try:
                result = create_adgroup_with_videos(
                    client=client,
                    customer_id=account_id,
                    campaign_id=campaign_id,
                    adgroup_name=request.adgroup_name,
                    video_ids=video_ids,
                    headlines=headlines,
                    descriptions=descriptions
                )
                results.append(result)
            except Exception as e:
                results.append({
                    "account_id": account_id,
                    "campaign_id": campaign_id,
                    "success": False,
                    "error": str(e)
                })
    
    return {"results": results}


def create_adgroup_with_videos(client, customer_id, campaign_id, adgroup_name, video_ids, headlines, descriptions):
    """Create ad group with YouTube video assets for App Campaign"""
    
    logs = []
    logs.append(f"Starting creation for account {customer_id}, campaign {campaign_id}")
    
    # Services
    ad_group_service = client.get_service("AdGroupService")
    asset_service = client.get_service("AssetService")
    ad_group_ad_service = client.get_service("AdGroupAdService")
    
    # 1. Create Ad Group (PAUSED)
    ad_group_operation = client.get_type("AdGroupOperation")
    ad_group = ad_group_operation.create
    ad_group.name = adgroup_name
    ad_group.campaign = f"customers/{customer_id}/campaigns/{campaign_id}"
    ad_group.status = client.enums.AdGroupStatusEnum.PAUSED
    
    logs.append(f"Creating ad group '{adgroup_name}'...")
    
    ad_group_resource = None
    try:
        ad_group_response = ad_group_service.mutate_ad_groups(
            customer_id=customer_id,
            operations=[ad_group_operation]
        )
        ad_group_resource = ad_group_response.results[0].resource_name
        logs.append(f"Ad group created: {ad_group_resource}")
    except GoogleAdsException as ex:
        error_details = []
        for error in ex.failure.errors:
            error_details.append(f"{error.error_code}: {error.message}")
        error_msg = "; ".join(error_details)
        logs.append(f"Failed to create ad group: {error_msg}")
        return {
            "account_id": customer_id,
            "campaign_id": campaign_id,
            "success": False,
            "error": f"Failed to create ad group: {error_msg}",
            "logs": logs
        }
    
    # 2. Create YouTube Video Assets
    logs.append(f"Creating {len(video_ids)} video assets...")
    created_video_assets = []
    
    for video_id in video_ids:
        asset_operation = client.get_type("AssetOperation")
        asset = asset_operation.create
        asset.youtube_video_asset.youtube_video_id = video_id
        # Don't set asset.name - Google Ads will auto-fetch title from YouTube
        
        try:
            asset_response = asset_service.mutate_assets(
                customer_id=customer_id,
                operations=[asset_operation]
            )
            created_video_assets.append(asset_response.results[0].resource_name)
            logs.append(f"Created video asset: {video_id}")
        except GoogleAdsException as ex:
            # Asset might already exist, try to find it
            logs.append(f"Video {video_id}: {ex.failure.errors[0].message}")
            # Try to get existing asset
            try:
                ga_service = client.get_service("GoogleAdsService")
                query = f"""
                    SELECT asset.resource_name 
                    FROM asset 
                    WHERE asset.youtube_video_asset.youtube_video_id = '{video_id}'
                """
                response = ga_service.search(customer_id=customer_id, query=query)
                for row in response:
                    created_video_assets.append(row.asset.resource_name)
                    logs.append(f"Found existing asset for {video_id}")
                    break
            except:
                logs.append(f"Could not find existing asset for {video_id}")
    
    logs.append(f"Total video assets: {len(created_video_assets)}")
    
    # 3. Create Text Assets (Headlines and Descriptions)
    logs.append(f"Creating text assets...")
    headline_assets = []
    description_assets = []
    
    for headline in headlines:
        asset_operation = client.get_type("AssetOperation")
        asset = asset_operation.create
        asset.text_asset.text = headline
        asset.name = f"Headline_{headline[:20]}"
        
        try:
            asset_response = asset_service.mutate_assets(
                customer_id=customer_id,
                operations=[asset_operation]
            )
            headline_assets.append(asset_response.results[0].resource_name)
        except GoogleAdsException as ex:
            logs.append(f"Headline '{headline[:20]}...': {ex.failure.errors[0].message}")
    
    for description in descriptions:
        asset_operation = client.get_type("AssetOperation")
        asset = asset_operation.create
        asset.text_asset.text = description
        asset.name = f"Desc_{description[:20]}"
        
        try:
            asset_response = asset_service.mutate_assets(
                customer_id=customer_id,
                operations=[asset_operation]
            )
            description_assets.append(asset_response.results[0].resource_name)
        except GoogleAdsException as ex:
            logs.append(f"Description '{description[:20]}...': {ex.failure.errors[0].message}")
    
    logs.append(f"Created {len(headline_assets)} headlines, {len(description_assets)} descriptions")
    
    # 4. Create App Ad with text and videos
    logs.append("Creating App Ad...")
    
    ad_group_ad_operation = client.get_type("AdGroupAdOperation")
    ad_group_ad = ad_group_ad_operation.create
    ad_group_ad.ad_group = ad_group_resource
    # For App ads, ad cannot be created in PAUSED state. Use ENABLED.
    ad_group_ad.status = client.enums.AdGroupAdStatusEnum.ENABLED
    
    # Set up App Ad
    ad = ad_group_ad.ad
    app_ad = ad.app_ad
    
    # Add headlines (direct text, not asset references)
    for headline_text in headlines[:5]:
        headline_info = client.get_type("AdTextAsset")
        headline_info.text = headline_text
        app_ad.headlines.append(headline_info)
    
    # Add descriptions (direct text)
    for desc_text in descriptions[:5]:
        desc_info = client.get_type("AdTextAsset")
        desc_info.text = desc_text
        app_ad.descriptions.append(desc_info)
    
    # Add videos (using video IDs directly)
    for vid in video_ids:
        video_info = client.get_type("AdVideoAsset")
        video_info.asset = f"customers/{customer_id}/assets/{vid}"  # Try with video_id
        app_ad.youtube_videos.append(video_info)
    
    # Alternative: Add videos using created asset resources
    if created_video_assets:
        app_ad.youtube_videos.clear()  # Clear previous attempt
        for v_asset in created_video_assets:
            video_info = client.get_type("AdVideoAsset")
            video_info.asset = v_asset
            app_ad.youtube_videos.append(video_info)
    
    try:
        ad_response = ad_group_ad_service.mutate_ad_group_ads(
            customer_id=customer_id,
            operations=[ad_group_ad_operation]
        )
        logs.append(f"Created App Ad: {ad_response.results[0].resource_name}")
    except GoogleAdsException as ex:
        error_details = []
        for error in ex.failure.errors:
            error_details.append(f"{error.message}")
            if hasattr(error, 'details') and error.details:
                error_details.append(f"  Details: {error.details}")
        error_msg = "; ".join(error_details)
        logs.append(f"App Ad error: {error_msg}")
    
    logs.append("Completed!")
    
    return {
        "account_id": customer_id,
        "campaign_id": campaign_id,
        "adgroup_name": adgroup_name,
        "adgroup_resource": ad_group_resource,
        "videos_count": len(video_ids),
        "assets_created": len(created_video_assets),
        "success": True,
        "logs": logs
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

