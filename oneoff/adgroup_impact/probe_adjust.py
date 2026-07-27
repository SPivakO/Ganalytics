"""Discover what this Adjust account actually exposes, before the big pull.

Three unknowns block the report:
  1. the channel_id of Google Ads (app.py only ever hard-coded AppLovin/Mintegral),
  2. the exact metric slugs for D1 revenue / ROAS and clicks (never queried in this repo),
  3. whether an ad-group-level dimension exists (would let us go finer than campaign).

Run:  ./venv/bin/python oneoff/adgroup_impact/probe_adjust.py
Writes oneoff/adgroup_impact/probe_result.json, which pull.py reads.
"""

import argparse
import json
import time
from typing import Dict, List, Optional

import adjust_api as aj
import config

SLEEP_BETWEEN = 0.6

DIMENSION_CANDIDATES = [
    "day",
    "app",
    "os_name",
    "platform",
    "store_type",
    "channel",
    "partner",
    "partner_name",
    "network",
    "campaign",
    "campaign_network",
    "campaign_id_network",
    "adgroup",
    "adgroup_network",
    "adgroup_id_network",
    "creative_network",
    "country",
]

METRIC_CANDIDATES = [
    # spend / volume
    "cost",
    "installs",
    "clicks",
    "impressions",
    "network_impressions",
    "network_clicks",
    "network_installs",
    "network_cost",
    # revenue and ROAS, cohort based
    "revenue",
    "all_revenue",
    "revenue_d1",
    "all_revenue_d1",
    "revenue_total_d1",
    "ad_revenue_d1",
    "roas_d1",
    "roas_d0",
    "roas_d7",
    # rates
    "click_conversion_rate",
    "impression_conversion_rate",
    "ecpi_all",
    "cost_per_install",
]

# Candidate ROAS/revenue slugs in the order we would rather use them.
ROAS_PREFERENCE = ["roas_d1"]
REVENUE_D1_PREFERENCE = ["all_revenue_d1", "revenue_d1", "revenue_total_d1", "ad_revenue_d1"]


def _short_error(e: Exception, limit: int = 220) -> str:
    return str(e).replace("\\n", " ")[:limit]


def probe_dimension(token: str, app_token: str, start: str, end: str, dim: str) -> dict:
    try:
        rows, debug = aj.pivot_report(
            api_token=token,
            app_token=app_token,
            start_date=start,
            end_date=end,
            dimensions=[dim],
            metrics=["cost", "installs"],
            index="day",
            cohort_maturity="immature",
            timeout=90,
        )
    except Exception as e:  # noqa: BLE001 - probing, every failure is a data point
        return {"ok": False, "error": _short_error(e)}
    sample = sorted({str(r.get(dim, "")) for r in rows if r.get(dim) not in (None, "")})[:15]
    return {"ok": True, "rows": len(rows), "keys": debug["first_row_keys"], "sample_values": sample}


def probe_metrics(token: str, app_token: str, start: str, end: str, metrics: List[str]) -> Dict[str, dict]:
    """Bisect the candidate list so a mostly-valid set costs only a couple of calls."""
    results: Dict[str, dict] = {}

    def attempt(group: List[str]) -> None:
        if not group:
            return
        try:
            rows, debug = aj.pivot_report(
                api_token=token,
                app_token=app_token,
                start_date=start,
                end_date=end,
                dimensions=["day"],
                metrics=group,
                index="day",
                cohort_maturity="immature",
                timeout=90,
            )
        except Exception as e:  # noqa: BLE001 - probing
            if len(group) == 1:
                results[group[0]] = {"ok": False, "error": _short_error(e)}
                return
            mid = len(group) // 2
            time.sleep(SLEEP_BETWEEN)
            attempt(group[:mid])
            time.sleep(SLEEP_BETWEEN)
            attempt(group[mid:])
            return
        present = set(debug["first_row_keys"])
        for m in group:
            sample = next((r.get(m) for r in rows if r.get(m) not in (None, "")), None)
            results[m] = {
                "ok": True,
                "returned_column": m in present,
                "sample_value": sample,
                "nonzero": any(aj.to_float(r.get(m)) for r in rows),
            }
        time.sleep(SLEEP_BETWEEN)

    attempt(metrics)
    return results


def list_channels(token: str, app_token: str, start: str, end: str, dim: str) -> List[dict]:
    rows, _ = aj.pivot_report(
        api_token=token,
        app_token=app_token,
        start_date=start,
        end_date=end,
        dimensions=[dim],
        metrics=["cost", "installs"],
        index="day",
        cohort_maturity="immature",
        timeout=120,
    )
    agg: Dict[str, dict] = {}
    for r in rows:
        name = str(r.get(dim) or "")
        if not name:
            continue
        item = agg.setdefault(name, {"name": name, "cost": 0.0, "installs": 0, "channel_id": None})
        item["cost"] += aj.to_float(r.get("cost"))
        item["installs"] += aj.to_int(r.get("installs"))
        for key in ("channel_id", "partner_id", "network_id", f"{dim}_id"):
            if r.get(key) and not item["channel_id"]:
                item["channel_id"] = str(r[key])
    return sorted(agg.values(), key=lambda x: -x["cost"])


def guess_google_channel(channels: List[dict]) -> Optional[dict]:
    for ch in channels:
        name = ch["name"].lower()
        if "google" in name or "adwords" in name or "aci" in name:
            return ch
    return None


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--app-token", default=next(iter(config.APPS)), help="Adjust app token to probe with")
    p.add_argument("--start", default="2026-06-01")
    p.add_argument("--end", default="2026-06-07")
    args = p.parse_args()

    token = config.adjust_token()
    app_token = args.app_token
    print(f"Probing Adjust with app {config.APPS.get(app_token, app_token)} over {args.start}..{args.end}\n")

    print("== dimensions ==")
    dimensions: Dict[str, dict] = {}
    for dim in DIMENSION_CANDIDATES:
        res = probe_dimension(token, app_token, args.start, args.end, dim)
        dimensions[dim] = res
        mark = "ok  " if res["ok"] else "FAIL"
        detail = f"{res['rows']} rows, sample={res['sample_values'][:4]}" if res["ok"] else res["error"]
        print(f"  {mark} {dim:22s} {detail}")
        time.sleep(SLEEP_BETWEEN)

    print("\n== metrics ==")
    metrics = probe_metrics(token, app_token, args.start, args.end, METRIC_CANDIDATES)
    for m in METRIC_CANDIDATES:
        res = metrics.get(m, {"ok": False, "error": "not probed"})
        if res["ok"]:
            print(f"  ok   {m:26s} sample={res['sample_value']!r} nonzero={res['nonzero']}")
        else:
            print(f"  FAIL {m:26s} {res['error']}")

    channel_dim = next((d for d in ("channel", "partner", "network", "partner_name") if dimensions.get(d, {}).get("ok")), None)
    channels: List[dict] = []
    google = None
    if channel_dim:
        print(f"\n== channels (via '{channel_dim}') ==")
        channels = list_channels(token, app_token, args.start, args.end, channel_dim)
        for ch in channels[:30]:
            print(f"  {ch['name']:40s} cost={ch['cost']:>12,.2f} installs={ch['installs']:>9,d} id={ch['channel_id']}")
        google = guess_google_channel(channels)
        print(f"\n  -> Google channel guess: {google}")
    else:
        print("\n!! no channel-like dimension worked; pull.py will need an explicit --channel-id")

    ok_metrics = {m for m, r in metrics.items() if r.get("ok")}
    result = {
        "probed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "app_token": app_token,
        "window": [args.start, args.end],
        "dimensions": dimensions,
        "metrics": metrics,
        "channel_dimension": channel_dim,
        "channels": channels,
        "google_channel": google,
        "recommended": {
            "channel_id": (google or {}).get("channel_id"),
            "channel_name": (google or {}).get("name"),
            "roas_metric": next((m for m in ROAS_PREFERENCE if m in ok_metrics), None),
            "revenue_d1_metric": next((m for m in REVENUE_D1_PREFERENCE if m in ok_metrics), None),
            "campaign_dimension": next(
                (d for d in ("campaign", "campaign_network") if dimensions.get(d, {}).get("ok")), None
            ),
            "campaign_id_dimension": next(
                (d for d in ("campaign_id_network",) if dimensions.get(d, {}).get("ok")), None
            ),
            "adgroup_dimension": next(
                (d for d in ("adgroup", "adgroup_network") if dimensions.get(d, {}).get("ok")), None
            ),
            "impressions_metric": next(
                (m for m in ("network_impressions", "impressions") if m in ok_metrics), None
            ),
            "clicks_metric": next((m for m in ("clicks", "network_clicks") if m in ok_metrics), None),
        },
    }
    config.PROBE_RESULT.write_text(json.dumps(result, indent=2, ensure_ascii=False))
    print(f"\nRecommended config: {json.dumps(result['recommended'], indent=2, ensure_ascii=False)}")
    print(f"Written to {config.PROBE_RESULT}")


if __name__ == "__main__":
    main()
