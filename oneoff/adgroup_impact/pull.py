"""Pull the raw data for the one-off ad group impact report.

Google Ads gives us campaign metadata (incl. the real store/platform) and daily ad group
stats — the latter is what dates a test ad group's first spend. Adjust gives us the daily
Google-channel performance (spend, installs, impressions, D1 revenue/ROAS) per campaign.

Everything lands as CSV under oneoff/adgroup_impact/raw/. Chunks are cached, so a re-run
after a failure only fetches what is missing.

Run:  ./venv/bin/python oneoff/adgroup_impact/pull.py --start 2024-01-01 --end 2026-06-30
"""

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pandas as pd
from google.ads.googleads.client import GoogleAdsClient
from google.ads.googleads.errors import GoogleAdsException

import adjust_api as aj
import config

CHUNK_DIR = config.RAW_DIR / "chunks"


# --------------------------------------------------------------------------- helpers


def _d(s: str) -> date:
    return date.fromisoformat(s)


def month_chunks(start: str, end: str) -> List[Tuple[str, str]]:
    out, cur, last = [], _d(start), _d(end)
    while cur <= last:
        nxt = (cur.replace(day=1) + timedelta(days=32)).replace(day=1)
        chunk_end = min(nxt - timedelta(days=1), last)
        out.append((cur.isoformat(), chunk_end.isoformat()))
        cur = chunk_end + timedelta(days=1)
    return out


def quarter_chunks(start: str, end: str) -> List[Tuple[str, str]]:
    out, cur, last = [], _d(start), _d(end)
    while cur <= last:
        q_end_month = ((cur.month - 1) // 3 + 1) * 3
        nxt = date(cur.year + (q_end_month // 12), (q_end_month % 12) + 1, 1)
        chunk_end = min(nxt - timedelta(days=1), last)
        out.append((cur.isoformat(), chunk_end.isoformat()))
        cur = chunk_end + timedelta(days=1)
    return out


def _enum_name(value: Any) -> str:
    return getattr(value, "name", str(value))


def _write_chunk(path, rows: List[dict], columns: List[str]) -> None:
    df = pd.DataFrame(rows, columns=columns) if rows else pd.DataFrame(columns=columns)
    df.to_csv(path, index=False)


# ----------------------------------------------------------------------- google ads


def get_client() -> GoogleAdsClient:
    return GoogleAdsClient.load_from_dict(config.google_ads_config())


def get_accounts(client: GoogleAdsClient) -> List[dict]:
    """Leaf accounts under the MCC — same query as app.py:get_accounts()."""
    service = client.get_service("GoogleAdsService")
    mcc = client.login_customer_id.replace("-", "")
    query = """
        SELECT customer_client.id, customer_client.descriptive_name
        FROM customer_client
        WHERE customer_client.status = 'ENABLED' AND customer_client.manager = FALSE
    """
    accounts = []
    for row in service.search(customer_id=mcc, query=query):
        accounts.append(
            {"account_id": str(row.customer_client.id), "account_name": row.customer_client.descriptive_name or ""}
        )
    return sorted(accounts, key=lambda a: a["account_name"])


CAMPAIGN_COLUMNS = [
    "account_id",
    "account_name",
    "campaign_id",
    "campaign_name",
    "campaign_status",
    "channel_type",
    "start_date",
    "app_id",
    "app_store",
]


def pull_campaigns(client: GoogleAdsClient, accounts: List[dict]) -> pd.DataFrame:
    """Campaign metadata including app_campaign_setting, which gives the true platform.

    No status filter: campaigns removed years ago still own historical ad group stats.
    """
    query = """
        SELECT campaign.id, campaign.name, campaign.status,
               campaign.advertising_channel_type, campaign.start_date,
               campaign.app_campaign_setting.app_id,
               campaign.app_campaign_setting.app_store
        FROM campaign
    """
    rows: List[dict] = []

    def fetch(account: dict) -> List[dict]:
        service = client.get_service("GoogleAdsService")
        out = []
        for batch in service.search_stream(customer_id=account["account_id"], query=query):
            for r in batch.results:
                setting = r.campaign.app_campaign_setting
                out.append(
                    {
                        "account_id": account["account_id"],
                        "account_name": account["account_name"],
                        "campaign_id": str(r.campaign.id),
                        "campaign_name": r.campaign.name,
                        "campaign_status": _enum_name(r.campaign.status),
                        "channel_type": _enum_name(r.campaign.advertising_channel_type),
                        "start_date": r.campaign.start_date or "",
                        "app_id": setting.app_id or "",
                        "app_store": _enum_name(setting.app_store) if setting.app_id else "",
                    }
                )
        return out

    with ThreadPoolExecutor(max_workers=5) as pool:
        futures = {pool.submit(fetch, a): a for a in accounts}
        for fut in as_completed(futures):
            account = futures[fut]
            try:
                got = fut.result()
            except GoogleAdsException as e:
                print(f"  !! campaigns failed for {account['account_name']} ({account['account_id']}): "
                      f"{e.error.code().name if e.error else e}")
                continue
            print(f"  {account['account_name']}: {len(got)} campaigns")
            rows.extend(got)

    df = pd.DataFrame(rows, columns=CAMPAIGN_COLUMNS)
    df.to_csv(config.RAW_DIR / "google_campaigns.csv", index=False)
    return df


ADGROUP_COLUMNS = [
    "day",
    "account_id",
    "campaign_id",
    "campaign_name",
    "adgroup_id",
    "adgroup_name",
    "adgroup_status",
    "cost",
    "impressions",
    "clicks",
    "conversions",
]


def pull_adgroup_daily(
    client: GoogleAdsClient, accounts: List[dict], start: str, end: str, max_workers: int = 4
) -> pd.DataFrame:
    """Daily ad group stats, quarter by quarter, cached per (account, quarter)."""
    tasks = [(a, cs, ce) for a in accounts for cs, ce in quarter_chunks(start, end)]

    def fetch(account: dict, chunk_start: str, chunk_end: str) -> Optional[Any]:
        path = CHUNK_DIR / f"gads_{account['account_id']}_{chunk_start}.csv"
        if path.exists():
            return path
        query = f"""
            SELECT segments.date, campaign.id, campaign.name,
                   ad_group.id, ad_group.name, ad_group.status,
                   metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.conversions
            FROM ad_group
            WHERE segments.date BETWEEN '{chunk_start}' AND '{chunk_end}'
        """
        rows: List[dict] = []
        service = client.get_service("GoogleAdsService")
        for attempt in range(3):
            try:
                rows = []
                for batch in service.search_stream(customer_id=account["account_id"], query=query):
                    for r in batch.results:
                        rows.append(
                            {
                                "day": str(r.segments.date),
                                "account_id": account["account_id"],
                                "campaign_id": str(r.campaign.id),
                                "campaign_name": r.campaign.name,
                                "adgroup_id": str(r.ad_group.id),
                                "adgroup_name": r.ad_group.name,
                                "adgroup_status": _enum_name(r.ad_group.status),
                                "cost": (r.metrics.cost_micros or 0) / 1_000_000,
                                "impressions": r.metrics.impressions or 0,
                                "clicks": r.metrics.clicks or 0,
                                "conversions": r.metrics.conversions or 0.0,
                            }
                        )
                break
            except GoogleAdsException as e:
                detail = e.error.code().name if e.error else str(e)
                if attempt == 2:
                    print(f"  !! {account['account_name']} {chunk_start}: giving up after 3 attempts ({detail})")
                    return None
                wait = 2 ** (attempt + 1)
                print(f"  .. {account['account_name']} {chunk_start}: {detail}, retry in {wait}s")
                time.sleep(wait)
        _write_chunk(path, rows, ADGROUP_COLUMNS)
        print(f"  {account['account_name']} {chunk_start}: {len(rows)} rows")
        return path

    paths = []
    with ThreadPoolExecutor(max_workers=max_workers) as pool:
        futures = [pool.submit(fetch, a, cs, ce) for a, cs, ce in tasks]
        for fut in as_completed(futures):
            path = fut.result()
            if path is not None:
                paths.append(path)

    frames = [pd.read_csv(p, dtype={"account_id": str, "campaign_id": str, "adgroup_id": str}) for p in paths]
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=ADGROUP_COLUMNS)
    df.to_csv(config.RAW_DIR / "google_adgroup_daily.csv", index=False)
    return df


# --------------------------------------------------------------------------- adjust


def load_probe() -> dict:
    if not config.PROBE_RESULT.exists():
        raise SystemExit(
            f"{config.PROBE_RESULT} not found — run probe_adjust.py first so we know the "
            "Google channel id and which metric slugs this account supports."
        )
    return json.loads(config.PROBE_RESULT.read_text())


def adjust_plan(probe: dict, args: argparse.Namespace) -> dict:
    """Turn probe findings (plus CLI overrides) into a concrete Adjust request shape."""
    rec = probe.get("recommended", {})
    channel_id = args.channel_id or rec.get("channel_id")
    if not channel_id:
        raise SystemExit(
            "No Google channel_id: probe_adjust.py did not identify one. "
            "Re-run the probe or pass --channel-id explicitly."
        )

    campaign_dim = rec.get("campaign_dimension") or "campaign"
    dimensions = [campaign_dim]
    for extra in (rec.get("campaign_id_dimension"), rec.get("adgroup_dimension") if args.adgroup_dimension else None):
        if extra and extra not in dimensions:
            dimensions.append(extra)

    metrics = ["cost", "installs"]
    for slug in (rec.get("impressions_metric"), rec.get("clicks_metric"), rec.get("roas_metric"), rec.get("revenue_d1_metric")):
        if slug and slug not in metrics:
            metrics.append(slug)

    if not rec.get("roas_metric") and not rec.get("revenue_d1_metric"):
        raise SystemExit(
            "Adjust exposes neither a roas_d1 nor a D1 revenue metric for this account — "
            "ROAS D1 cannot be computed. Check probe_result.json before continuing."
        )

    return {
        "channel_id": channel_id,
        "channel_name": rec.get("channel_name"),
        "dimensions": dimensions,
        "metrics": metrics,
        "campaign_dimension": campaign_dim,
        "campaign_id_dimension": rec.get("campaign_id_dimension"),
        "adgroup_dimension": rec.get("adgroup_dimension") if args.adgroup_dimension else None,
        "roas_metric": rec.get("roas_metric"),
        "revenue_d1_metric": rec.get("revenue_d1_metric"),
        "impressions_metric": rec.get("impressions_metric") or "network_impressions",
        "clicks_metric": rec.get("clicks_metric"),
    }


def pull_adjust(
    token: str, app_tokens: List[str], start: str, end: str, plan: dict, cohort_maturity: str
) -> pd.DataFrame:
    """Daily Google-channel performance per campaign, one month per request, cached."""
    columns = ["day", "app_token", "app_name"] + plan["dimensions"] + plan["metrics"]
    paths = []

    for app_token in app_tokens:
        app_name = config.APPS.get(app_token, app_token)
        for chunk_start, chunk_end in month_chunks(start, end):
            path = CHUNK_DIR / f"adjust_{app_token}_{chunk_start}.csv"
            if path.exists():
                paths.append(path)
                continue
            try:
                rows, debug = aj.pivot_report(
                    api_token=token,
                    app_token=app_token,
                    start_date=chunk_start,
                    end_date=chunk_end,
                    dimensions=plan["dimensions"],
                    metrics=plan["metrics"],
                    channel_id=plan["channel_id"],
                    store_type=config.STORE_TYPE,
                    index="day",
                    cohort_maturity=cohort_maturity,
                    timeout=300,
                )
            except Exception as e:  # noqa: BLE001 - one bad month should not kill the run
                print(f"  !! adjust {app_name} {chunk_start}: {str(e)[:200]}")
                continue

            out = []
            for r in rows:
                day = str(r.get("day") or r.get("date") or "")[:10]
                if not day:
                    continue
                item = {"day": day, "app_token": app_token, "app_name": app_name}
                for dim in plan["dimensions"]:
                    item[dim] = r.get(dim, "")
                for metric in plan["metrics"]:
                    item[metric] = r.get(metric, 0)
                out.append(item)
            _write_chunk(path, out, columns)
            paths.append(path)
            print(f"  adjust {app_name} {chunk_start}: {len(out)} rows ({debug['row_count']} raw)")
            time.sleep(0.4)

    frames = [pd.read_csv(p) for p in paths]
    df = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(columns=columns)
    df.to_csv(config.RAW_DIR / "adjust_daily.csv", index=False)
    (config.RAW_DIR / "adjust_plan.json").write_text(json.dumps(plan, indent=2, ensure_ascii=False))
    return df


# ----------------------------------------------------------------------------- main


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--start", default=config.DEFAULT_START)
    p.add_argument("--end", default=config.DEFAULT_END)
    p.add_argument("--apps", default=",".join(config.APPS), help="comma-separated Adjust app tokens")
    p.add_argument("--channel-id", default=None, help="override the Google channel id from probe_result.json")
    p.add_argument("--cohort-maturity", default="mature", choices=["mature", "immature"])
    p.add_argument("--adgroup-dimension", action="store_true", help="also request the Adjust ad group dimension")
    p.add_argument("--skip-google", action="store_true")
    p.add_argument("--skip-adjust", action="store_true")
    args = p.parse_args()

    config.ensure_dirs()
    CHUNK_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Period: {args.start} .. {args.end}\n")

    if not args.skip_google:
        client = get_client()
        print("== google ads accounts ==")
        accounts = get_accounts(client)
        (config.RAW_DIR / "google_accounts.json").write_text(json.dumps(accounts, indent=2, ensure_ascii=False))
        for a in accounts:
            print(f"  {a['account_id']}  {a['account_name']}")

        print("\n== google ads campaigns ==")
        campaigns = pull_campaigns(client, accounts)
        print(f"  total {len(campaigns)} campaigns")

        print("\n== google ads ad group daily stats ==")
        adgroups = pull_adgroup_daily(client, accounts, args.start, args.end)
        print(f"  total {len(adgroups):,} ad-group-days")

    if not args.skip_adjust:
        probe = load_probe()
        plan = adjust_plan(probe, args)
        print(f"\n== adjust ({plan['channel_name']} / {plan['channel_id']}) ==")
        print(f"  dimensions: {plan['dimensions']}")
        print(f"  metrics:    {plan['metrics']}")
        adjust_df = pull_adjust(
            config.adjust_token(),
            [t.strip() for t in args.apps.split(",") if t.strip()],
            args.start,
            args.end,
            plan,
            args.cohort_maturity,
        )
        print(f"  total {len(adjust_df):,} adjust rows")

    print(f"\nRaw data in {config.RAW_DIR}")


if __name__ == "__main__":
    main()
