"""Join the raw pulls into the report tables and the dashboard payload.

What happens here:
  * classify campaigns as Android/iOS from app_campaign_setting.app_store (name is the fallback),
  * find test ad groups and date them from the DDMMYY name convention, cross-checked against
    the first day the ad group actually spent,
  * attach Adjust's Google-channel daily performance to the Google Ads campaign,
  * derive ROAS D1 and ICR, and pre-compute the ±7d before/after impact of each test launch.

Run:  ./venv/bin/python oneoff/adgroup_impact/build.py
"""

import argparse
import json
import re
from datetime import date, datetime, timedelta
from typing import Any, Dict, List, Optional, Tuple

import numpy as np
import pandas as pd

import config

IMPACT_WINDOWS = [3, 7, 14]
DEFAULT_WINDOW = 7
MISMATCH_TOLERANCE_DAYS = 2
# Beyond this gap the name records when the test was set up, not when it went live,
# so the first day of spend is the better launch date.
NAME_DATE_TRUST_DAYS = 7

# "211225" or "21.12.25" / "21-12-25" / "21_12_25", not glued to other digits.
DATE_PATTERNS = [
    re.compile(r"(?<!\d)(\d{2})[.\-_/](\d{2})[.\-_/](\d{2})(?!\d)"),
    re.compile(r"(?<!\d)(\d{2})(\d{2})(\d{2})(?!\d)"),
]


# --------------------------------------------------------------------------- helpers


TRAILING_ID = re.compile(r"[\s\-_]*[\(\[]\s*\d+\s*[\)\]]\s*$")


def norm_name(s: Any) -> str:
    return re.sub(r"\s+", " ", str(s or "").strip().lower())


def strip_trailing_id(s: Any) -> str:
    """Adjust often labels a campaign "Some Name (123456789)"; Google Ads does not."""
    return norm_name(TRAILING_ID.sub("", str(s or "")))


def parse_ddmmyy(name: str) -> Optional[str]:
    """Extract the launch date encoded in a test ad group name (DDMMYY)."""
    for pattern in DATE_PATTERNS:
        for dd, mm, yy in pattern.findall(name or ""):
            try:
                d = date(2000 + int(yy), int(mm), int(dd))
            except ValueError:
                continue
            if date(2020, 1, 1) <= d <= date(2030, 12, 31):
                return d.isoformat()
    return None


def is_test_adgroup(name: str) -> bool:
    """A test ad group is dated in its own name and is not an evergreen "Main" group.

    "Not Main" alone is too broad: real accounts also carry undated evergreen groups
    ("Ad group 1", "gameplay", "android_top") that are not tests at all.
    """
    return "main" not in (name or "").lower() and parse_ddmmyy(name) is not None


def classify_platform(app_store: str, campaign_name: str) -> str:
    store = (app_store or "").upper()
    if "GOOGLE" in store:
        return "Android"
    if "APPLE" in store or "IOS" in store:
        return "iOS"
    lowered = (campaign_name or "").lower()
    if "ios" in lowered:
        return "iOS"
    if "android" in lowered:
        return "Android"
    return "unknown"


def safe_div(num: pd.Series, den: pd.Series) -> pd.Series:
    return (num / den.replace(0, np.nan)).replace([np.inf, -np.inf], np.nan)


def r(value: Any, digits: int = 4) -> Optional[float]:
    """Round for the JSON payload; NaN becomes null."""
    if value is None:
        return None
    try:
        f = float(value)
    except (TypeError, ValueError):
        return None
    return None if not np.isfinite(f) else round(f, digits)


# ----------------------------------------------------------------------- ad groups


def build_adgroups(daily: pd.DataFrame, campaigns: pd.DataFrame) -> pd.DataFrame:
    """One row per ad group: its dated name, its first spend, and its lifetime totals."""
    spend_days = daily[daily["cost"] > 0]
    first_spend = spend_days.groupby("adgroup_id")["day"].min().rename("first_spend_date")
    last_spend = spend_days.groupby("adgroup_id")["day"].max().rename("last_spend_date")

    agg = daily.groupby("adgroup_id").agg(
        account_id=("account_id", "first"),
        campaign_id=("campaign_id", "first"),
        campaign_name=("campaign_name", "first"),
        adgroup_name=("adgroup_name", "last"),
        adgroup_status=("adgroup_status", "last"),
        total_cost=("cost", "sum"),
        total_impressions=("impressions", "sum"),
        total_clicks=("clicks", "sum"),
        total_conversions=("conversions", "sum"),
        active_days=("day", "nunique"),
    )
    ag = agg.join([first_spend, last_spend]).reset_index()

    ag["is_test"] = ag["adgroup_name"].map(is_test_adgroup)
    ag["date_from_name"] = ag["adgroup_name"].map(parse_ddmmyy)

    name_dt = pd.to_datetime(ag["date_from_name"], errors="coerce")
    spend_dt = pd.to_datetime(ag["first_spend_date"], errors="coerce")
    ag["date_mismatch_days"] = (spend_dt - name_dt).dt.days

    ag["date_source"] = np.select(
        [name_dt.notna() & spend_dt.notna(), name_dt.notna(), spend_dt.notna()],
        ["both", "name", "spend"],
        default="none",
    )
    # The name says when the test was set up; the first day of spend says when it started
    # affecting the channel. They agree for most ad groups — where they diverge badly,
    # the launch that matters for this report is the spend one.
    trust_name = name_dt.notna() & (
        ag["date_mismatch_days"].isna() | (ag["date_mismatch_days"].abs() <= NAME_DATE_TRUST_DAYS)
    )
    ag["launch_date"] = np.where(trust_name, ag["date_from_name"], ag["first_spend_date"])
    ag["launch_date"] = ag["launch_date"].where(pd.notna(ag["launch_date"]), None)
    ag["launch_source"] = np.where(trust_name, "name", np.where(spend_dt.notna(), "first_spend", "none"))
    ag["date_flag"] = np.where(
        ag["date_mismatch_days"].abs() > MISMATCH_TOLERANCE_DAYS, "mismatch", ""
    )

    meta = campaigns.set_index("campaign_id")[["campaign_name", "platform", "app_store", "channel_type", "account_name"]]
    ag = ag.merge(meta.rename(columns={"campaign_name": "campaign_name_meta"}), how="left", left_on="campaign_id", right_index=True)
    ag["campaign_name"] = ag["campaign_name_meta"].fillna(ag["campaign_name"])
    ag["platform"] = ag["platform"].fillna(
        pd.Series([classify_platform("", n) for n in ag["campaign_name"]], index=ag.index)
    )
    return ag.drop(columns=["campaign_name_meta"])


# -------------------------------------------------------------------------- adjust


def prepare_adjust(adjust: pd.DataFrame, plan: dict) -> pd.DataFrame:
    """Rename Adjust's account-specific slugs to a fixed schema and derive ROAS D1 / ICR."""
    campaign_dim = plan["campaign_dimension"]
    impressions_metric = plan.get("impressions_metric") or "network_impressions"

    df = adjust.copy()
    df["day"] = df["day"].astype(str).str[:10]
    df["adjust_campaign"] = df[campaign_dim].astype(str)

    id_dim = plan.get("campaign_id_dimension")
    df["adjust_campaign_id"] = df[id_dim].astype(str) if id_dim and id_dim in df.columns else ""

    adgroup_dim = plan.get("adgroup_dimension")
    df["adjust_adgroup"] = df[adgroup_dim].astype(str) if adgroup_dim and adgroup_dim in df.columns else ""

    for target, source in [
        ("spend", "cost"),
        ("installs", "installs"),
        ("impressions", impressions_metric),
        ("clicks", plan.get("clicks_metric")),
        ("revenue_d1", plan.get("revenue_d1_metric")),
        ("roas_d1_raw", plan.get("roas_metric")),
    ]:
        df[target] = pd.to_numeric(df[source], errors="coerce").fillna(0.0) if source and source in df.columns else 0.0

    group_cols = ["day", "app_token", "app_name", "adjust_campaign", "adjust_campaign_id"]
    if adgroup_dim:
        group_cols.append("adjust_adgroup")
    value_cols = ["spend", "installs", "impressions", "clicks", "revenue_d1"]
    agg = df.groupby(group_cols, as_index=False)[value_cols].sum()

    # Prefer deriving ROAS from revenue: Adjust's own roas_* slug can be a fraction or a
    # percentage depending on the account, and it cannot be re-aggregated across rows.
    if plan.get("revenue_d1_metric"):
        agg["roas_d1"] = safe_div(agg["revenue_d1"], agg["spend"])
        agg["roas_source"] = "revenue_d1/spend"
    else:
        weighted = df.assign(_w=df["roas_d1_raw"] * df["spend"]).groupby(group_cols, as_index=False)["_w"].sum()
        agg = agg.merge(weighted, on=group_cols, how="left")
        agg["roas_d1"] = safe_div(agg["_w"], agg["spend"])
        agg = agg.drop(columns=["_w"])
        agg["roas_source"] = plan.get("roas_metric") or "unavailable"
        # Adjust returns ROAS as a percentage in some accounts; normalise to a ratio.
        median = agg.loc[agg["roas_d1"] > 0, "roas_d1"].median()
        if pd.notna(median) and median > 3:
            agg["roas_d1"] = agg["roas_d1"] / 100.0
            agg["roas_source"] += " (÷100, looked like a percentage)"

    agg["icr"] = safe_div(agg["installs"], agg["impressions"])
    agg["norm_campaign"] = agg["adjust_campaign"].map(norm_name)
    return agg


def match_campaigns(adjust: pd.DataFrame, campaigns: pd.DataFrame) -> Tuple[pd.DataFrame, pd.DataFrame]:
    """Attach a Google Ads campaign_id to every Adjust row; report what would not match."""
    by_id = {str(c): c for c in campaigns["campaign_id"]}
    by_name: Dict[str, str] = {}
    by_base_name: Dict[str, str] = {}
    for _, row in campaigns.iterrows():
        by_name.setdefault(norm_name(row["campaign_name"]), row["campaign_id"])
        by_base_name.setdefault(strip_trailing_id(row["campaign_name"]), row["campaign_id"])

    def resolve(row) -> Tuple[Optional[str], str]:
        raw_id = str(row["adjust_campaign_id"] or "").strip()
        if raw_id and raw_id in by_id:
            return by_id[raw_id], "campaign_id"
        # Adjust often carries the network id inside the campaign label, e.g. "Name (123456789)".
        label = row["adjust_campaign"]
        for candidate in re.findall(r"\d+", label):
            if candidate in by_id:
                return by_id[candidate], "id_in_name"
        hit = by_name.get(row["norm_campaign"]) or by_base_name.get(strip_trailing_id(label))
        if hit:
            return hit, "name"
        return None, "unmatched"

    resolved = adjust.apply(resolve, axis=1, result_type="expand")
    adjust = adjust.copy()
    adjust["campaign_id"] = resolved[0]
    adjust["match_method"] = resolved[1]

    unmatched = (
        adjust[adjust["campaign_id"].isna()]
        .groupby(["app_name", "adjust_campaign"], as_index=False)
        .agg(spend=("spend", "sum"), installs=("installs", "sum"), days=("day", "nunique"))
        .sort_values("spend", ascending=False)
    )
    total_spend = adjust["spend"].sum()
    unmatched["share_of_adjust_spend"] = unmatched["spend"] / total_spend if total_spend else 0.0
    return adjust, unmatched


# --------------------------------------------------------------- series and impact


def window_mean(series: pd.Series, center_idx: int, offset_start: int, offset_end: int) -> Optional[float]:
    lo, hi = center_idx + offset_start, center_idx + offset_end
    lo, hi = max(lo, 0), min(hi, len(series) - 1)
    if lo > hi:
        return None
    chunk = series.iloc[lo : hi + 1].dropna()
    return float(chunk.mean()) if len(chunk) else None


def compute_impact(campaign_series: Dict[str, pd.DataFrame], events: pd.DataFrame, dates: List[str]) -> pd.DataFrame:
    """Average spend / ROAS D1 / ICR in the N days before vs after each test launch."""
    index_of = {d: i for i, d in enumerate(dates)}
    out: List[dict] = []
    for _, ev in events.iterrows():
        series = campaign_series.get(ev["campaign_id"])
        idx = index_of.get(ev["launch_date"])
        if series is None or idx is None:
            continue
        row = {
            "campaign_id": ev["campaign_id"],
            "campaign_name": ev["campaign_name"],
            "app_name": ev["app_name"],
            "launch_date": ev["launch_date"],
            "n_test_adgroups": ev["n_test_adgroups"],
            "test_adgroups": ev["test_adgroups"],
        }
        for window in IMPACT_WINDOWS:
            for metric in ("spend", "roas_d1", "icr", "test_spend_share"):
                before = window_mean(series[metric], idx, -window, -1)
                after = window_mean(series[metric], idx, 0, window - 1)
                row[f"{metric}_before_{window}d"] = before
                row[f"{metric}_after_{window}d"] = after
                row[f"{metric}_delta_{window}d"] = (after - before) if (before is not None and after is not None) else None
                row[f"{metric}_delta_pct_{window}d"] = (
                    (after - before) / before if (before not in (None, 0) and after is not None) else None
                )
        out.append(row)
    return pd.DataFrame(out)


# ----------------------------------------------------------------------------- main


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--platform", default=config.PLATFORM, help="Android, iOS, or 'all'")
    args = p.parse_args()

    config.ensure_dirs()
    plan = json.loads((config.RAW_DIR / "adjust_plan.json").read_text())

    campaigns = pd.read_csv(config.RAW_DIR / "google_campaigns.csv", dtype=str).fillna("")
    daily = pd.read_csv(
        config.RAW_DIR / "google_adgroup_daily.csv",
        dtype={"account_id": str, "campaign_id": str, "adgroup_id": str},
    )
    adjust_raw = pd.read_csv(config.RAW_DIR / "adjust_daily.csv")

    daily["day"] = daily["day"].astype(str).str[:10]
    campaigns = campaigns.drop_duplicates(subset=["campaign_id"])
    campaigns["platform"] = [
        classify_platform(s, n) for s, n in zip(campaigns["app_store"], campaigns["campaign_name"])
    ]

    print(f"campaigns: {len(campaigns)}  ({campaigns['platform'].value_counts().to_dict()})")

    adgroups = build_adgroups(daily, campaigns)
    evergreen = int((~adgroups["is_test"] & adgroups["adgroup_name"].str.contains("main", case=False, na=False)).sum())
    print(
        f"ad groups with stats: {len(adgroups)}  tests: {int(adgroups['is_test'].sum())}  "
        f"Main: {evergreen}  other evergreen: {len(adgroups) - int(adgroups['is_test'].sum()) - evergreen}"
    )

    # How much of each campaign-day's Google Ads spend went to test ad groups. Tests are a
    # minority of spend, so a launch reads very differently at 5% than at 40% of the budget.
    test_ids = set(adgroups.loc[adgroups["is_test"], "adgroup_id"])
    gads = daily.assign(is_test=daily["adgroup_id"].isin(test_ids))
    gads_daily = gads.groupby(["campaign_id", "day"]).apply(
        lambda g: pd.Series({
            "gads_spend": g["cost"].sum(),
            "gads_test_spend": g.loc[g["is_test"], "cost"].sum(),
        }),
        include_groups=False,
    )
    gads_daily["test_spend_share"] = safe_div(gads_daily["gads_test_spend"], gads_daily["gads_spend"])

    adjust = prepare_adjust(adjust_raw, plan)
    adjust, unmatched = match_campaigns(adjust, campaigns)
    matched_spend = adjust.loc[adjust["campaign_id"].notna(), "spend"].sum()
    total_spend = adjust["spend"].sum()
    matched_share = f"{matched_spend / total_spend:.1%}" if total_spend else "n/a"
    print(f"adjust rows: {len(adjust):,}  matched to a campaign: {matched_share} of spend")
    print(f"  match methods: {adjust['match_method'].value_counts().to_dict()}")
    if len(unmatched):
        print(f"  unmatched adjust campaigns: {len(unmatched)} "
              f"({unmatched['share_of_adjust_spend'].sum():.1%} of spend)")

    # --- restrict to the requested platform ---
    if args.platform.lower() != "all":
        keep = set(campaigns.loc[campaigns["platform"] == args.platform, "campaign_id"])
        adjust = adjust[adjust["campaign_id"].isin(keep)]
        adgroups = adgroups[adgroups["campaign_id"].isin(keep)]
        print(f"after {args.platform} filter: {len(adjust):,} adjust rows, {len(adgroups)} ad groups")

    if adjust.empty:
        raise SystemExit("No Adjust rows left after matching and platform filtering — nothing to report.")

    campaign_meta = campaigns.set_index("campaign_id")

    # --- daily series per campaign on a continuous date axis ---
    per_campaign = (
        adjust.groupby(["campaign_id", "day"], as_index=False)
        .agg(
            spend=("spend", "sum"),
            installs=("installs", "sum"),
            impressions=("impressions", "sum"),
            clicks=("clicks", "sum"),
            revenue_d1=("revenue_d1", "sum"),
            app_name=("app_name", "first"),
        )
    )
    per_campaign["roas_d1"] = safe_div(per_campaign["revenue_d1"], per_campaign["spend"])
    per_campaign["icr"] = safe_div(per_campaign["installs"], per_campaign["impressions"])
    if not plan.get("revenue_d1_metric"):
        # No revenue metric: carry the ROAS Adjust computed, weighted by spend.
        weighted = adjust.assign(_w=adjust["roas_d1"] * adjust["spend"]).groupby(["campaign_id", "day"], as_index=False)["_w"].sum()
        per_campaign = per_campaign.merge(weighted, on=["campaign_id", "day"], how="left")
        per_campaign["roas_d1"] = safe_div(per_campaign["_w"], per_campaign["spend"])
        per_campaign = per_campaign.drop(columns=["_w"])

    all_dates = pd.date_range(per_campaign["day"].min(), per_campaign["day"].max(), freq="D")
    dates = [d.strftime("%Y-%m-%d") for d in all_dates]

    campaign_series: Dict[str, pd.DataFrame] = {}
    for cid, grp in per_campaign.groupby("campaign_id"):
        s = grp.set_index("day").reindex(dates)
        s[["spend", "installs", "impressions", "clicks", "revenue_d1"]] = s[
            ["spend", "installs", "impressions", "clicks", "revenue_d1"]
        ].fillna(0.0)
        s["roas_d1"] = safe_div(s["revenue_d1"], s["spend"]) if plan.get("revenue_d1_metric") else s["roas_d1"]
        s["icr"] = safe_div(s["installs"], s["impressions"])
        if cid in gads_daily.index.get_level_values(0):
            g = gads_daily.loc[cid].reindex(dates)
            s["gads_spend"] = g["gads_spend"].fillna(0.0)
            s["gads_test_spend"] = g["gads_test_spend"].fillna(0.0)
        else:
            s["gads_spend"] = 0.0
            s["gads_test_spend"] = 0.0
        s["test_spend_share"] = safe_div(s["gads_test_spend"], s["gads_spend"])
        campaign_series[cid] = s

    # --- test launch events ---
    tests = adgroups[adgroups["is_test"] & adgroups["launch_date"].notna()].copy()
    events = (
        tests.groupby(["campaign_id", "launch_date"], as_index=False)
        .agg(
            n_test_adgroups=("adgroup_id", "nunique"),
            test_adgroups=("adgroup_name", lambda s: " | ".join(sorted(set(s)))),
            test_spend=("total_cost", "sum"),
        )
    )
    events["campaign_name"] = events["campaign_id"].map(campaign_meta["campaign_name"])
    events["app_name"] = events["campaign_id"].map(
        per_campaign.groupby("campaign_id")["app_name"].first()
    )
    events = events[events["campaign_id"].isin(campaign_series)]
    print(f"test launch events: {len(events)} across {events['campaign_id'].nunique()} campaigns")

    impact = compute_impact(campaign_series, events, dates)

    # --- joined daily table for the spreadsheet ---
    joined = per_campaign.copy()
    joined["campaign_name"] = joined["campaign_id"].map(campaign_meta["campaign_name"])
    joined["platform"] = joined["campaign_id"].map(campaign_meta["platform"])
    ev_lookup = events.set_index(["campaign_id", "launch_date"])
    joined["tests_launched"] = [
        int(ev_lookup["n_test_adgroups"].get((c, d), 0)) for c, d in zip(joined["campaign_id"], joined["day"])
    ]
    joined["test_adgroup_names"] = [
        ev_lookup["test_adgroups"].get((c, d), "") for c, d in zip(joined["campaign_id"], joined["day"])
    ]
    share_lookup = gads_daily["test_spend_share"]
    gads_lookup = gads_daily["gads_spend"]
    test_lookup = gads_daily["gads_test_spend"]
    keys = list(zip(joined["campaign_id"], joined["day"]))
    joined["gads_spend"] = [gads_lookup.get(k, 0.0) for k in keys]
    joined["gads_test_spend"] = [test_lookup.get(k, 0.0) for k in keys]
    joined["test_spend_share"] = [share_lookup.get(k, np.nan) for k in keys]
    joined = joined[
        ["day", "app_name", "campaign_id", "campaign_name", "platform", "spend", "installs",
         "impressions", "clicks", "revenue_d1", "roas_d1", "icr",
         "gads_spend", "gads_test_spend", "test_spend_share",
         "tests_launched", "test_adgroup_names"]
    ].sort_values(["campaign_name", "day"])

    # --- outputs ---
    test_sheet = adgroups[
        ["account_id", "account_name", "campaign_id", "campaign_name", "platform", "adgroup_id",
         "adgroup_name", "adgroup_status", "is_test", "date_from_name", "first_spend_date",
         "last_spend_date", "date_source", "date_mismatch_days", "date_flag",
         "launch_date", "launch_source",
         "total_cost", "total_impressions", "total_clicks", "total_conversions", "active_days"]
    ].sort_values(["campaign_name", "launch_date"])

    adjust_sheet = adjust.drop(columns=["norm_campaign"]).sort_values(["app_name", "adjust_campaign", "day"])

    sheets = {
        "test_adgroups": test_sheet,
        "joined_daily": joined,
        "events_impact": impact,
        "adjust_daily": adjust_sheet,
        "campaigns": campaigns,
        "unmatched": unmatched,
    }
    for name, df in sheets.items():
        df.to_csv(config.OUT_DIR / f"{name}.csv", index=False)
    with pd.ExcelWriter(config.OUT_DIR / "adgroup_impact.xlsx", engine="openpyxl") as writer:
        for name, df in sheets.items():
            df.to_excel(writer, sheet_name=name[:31], index=False)

    # --- dashboard payload ---
    payload_campaigns = []
    series_payload = {}
    for cid, s in campaign_series.items():
        spend = s["spend"].fillna(0.0)
        nonzero = np.flatnonzero(spend.to_numpy() > 0)
        if not len(nonzero):
            continue
        lo, hi = int(nonzero[0]), int(nonzero[-1])
        sl = s.iloc[lo : hi + 1]
        series_payload[cid] = {
            "start": lo,
            "spend": [r(v, 2) for v in sl["spend"]],
            "installs": [r(v, 0) for v in sl["installs"]],
            "impressions": [r(v, 0) for v in sl["impressions"]],
            "revenue_d1": [r(v, 2) for v in sl["revenue_d1"]],
            "roas_d1": [r(v, 5) for v in sl["roas_d1"]],
            "icr": [r(v, 6) for v in sl["icr"]],
            "gads_spend": [r(v, 2) for v in sl["gads_spend"]],
            "gads_test_spend": [r(v, 2) for v in sl["gads_test_spend"]],
        }
        payload_campaigns.append(
            {
                "id": cid,
                "name": str(campaign_meta["campaign_name"].get(cid, cid)),
                "app": str(per_campaign.loc[per_campaign["campaign_id"] == cid, "app_name"].iloc[0]),
                "platform": str(campaign_meta["platform"].get(cid, "unknown")),
                "spend": r(float(spend.sum()), 2),
                "installs": r(float(s["installs"].sum()), 0),
                "roas_d1": r(float(s["revenue_d1"].sum() / spend.sum()) if spend.sum() else None, 5),
                "n_events": int((events["campaign_id"] == cid).sum()),
            }
        )
    payload_campaigns.sort(key=lambda c: -(c["spend"] or 0))

    payload = {
        "meta": {
            "generated_at": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
            "platform": args.platform,
            "date_from": dates[0],
            "date_to": dates[-1],
            "channel": plan.get("channel_name") or plan.get("channel_id"),
            "roas_source": plan.get("revenue_d1_metric") or plan.get("roas_metric") or "n/a",
            "icr_definition": "installs / impressions",
            "windows": IMPACT_WINDOWS,
            "default_window": DEFAULT_WINDOW,
            "unmatched_spend_share": r(float(unmatched["share_of_adjust_spend"].sum()) if len(unmatched) else 0.0, 4),
        },
        "dates": dates,
        "campaigns": payload_campaigns,
        "series": series_payload,
        "events": [
            {
                "campaign_id": e["campaign_id"],
                "date": e["launch_date"],
                "n": int(e["n_test_adgroups"]),
                "names": e["test_adgroups"],
            }
            for _, e in events.iterrows()
            if e["campaign_id"] in series_payload
        ],
    }
    (config.OUT_DIR / "dashboard_data.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))

    print(f"\nWrote {len(sheets)} sheets + dashboard_data.json to {config.OUT_DIR}")
    print(f"  campaigns in dashboard: {len(payload_campaigns)}, events: {len(payload['events'])}")


if __name__ == "__main__":
    main()
