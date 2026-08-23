#!/usr/bin/env python3
"""Generate bounded, read-only Google Ads JSON reports for GitHub Actions."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Iterable


MAX_ROWS = 50_000
REQUIRED_ENV = {
    "developer_token": "ADS_DEVELOPER_TOKEN",
    "client_id": "ADS_CLIENT_ID",
    "client_secret": "ADS_CLIENT_SECRET",
    "refresh_token": "ADS_REFRESH_TOKEN",
}


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def enum_name(value: Any) -> str:
    return str(getattr(value, "name", value))


def normalize_customer_id(value: str | None, *, required: bool = True) -> str | None:
    if value is None or not value.strip():
        if required:
            raise ValueError("customer_id is required for this report type")
        return None
    normalized = re.sub(r"\D", "", value)
    if not normalized:
        raise ValueError("customer_id must contain digits")
    return normalized


def normalize_campaign_ids(values: str | None) -> list[str]:
    output: list[str] = []
    for value in (values or "").split(","):
        value = value.strip()
        if not value:
            continue
        if not value.isdigit():
            raise ValueError(f"campaign_ids must contain digits only: {value!r}")
        if value not in output:
            output.append(value)
    return output


def gaql_string(value: str) -> str:
    return "'" + value.replace("\\", "\\\\").replace("'", "\\'") + "'"


def validate_date_range(start_date: str | None, end_date: str | None, max_days: int = 366) -> tuple[str, str]:
    if not start_date or not end_date:
        raise ValueError("start_date and end_date are required for performance reports")
    try:
        start = date.fromisoformat(start_date)
        end = date.fromisoformat(end_date)
    except ValueError as exc:
        raise ValueError("dates must use YYYY-MM-DD") from exc
    if end < start:
        raise ValueError("end_date must be on or after start_date")
    if (end - start).days + 1 > max_days:
        raise ValueError(f"date range exceeds {max_days} days")
    return start_date, end_date


def config_from_env() -> dict[str, Any]:
    config: dict[str, Any] = {}
    missing: list[str] = []
    for field, env_name in REQUIRED_ENV.items():
        value = os.environ.get(env_name)
        if value:
            config[field] = value
        else:
            missing.append(env_name)
    if missing:
        raise ValueError("Missing required GitHub repository secrets: " + ", ".join(missing))
    login_customer_id = os.environ.get("ADS_LOGIN_CUSTOMER_ID")
    if login_customer_id:
        config["login_customer_id"] = normalize_customer_id(login_customer_id)
    config["use_proto_plus"] = os.environ.get("ADS_USE_PROTO_PLUS", "true").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }
    return config


def load_client() -> Any:
    try:
        from google.ads.googleads.client import GoogleAdsClient
    except ImportError as exc:
        raise RuntimeError("google-ads package is not installed") from exc
    return GoogleAdsClient.load_from_dict(config_from_env())


def sanitized_error(exc: Exception) -> dict[str, Any]:
    failure = getattr(exc, "failure", None)
    errors = []
    for error in getattr(failure, "errors", []) or []:
        errors.append(
            {
                "code": str(getattr(error, "error_code", type(exc).__name__)),
                "message": str(getattr(error, "message", "Google Ads API error")),
            }
        )
    if not errors:
        errors.append({"code": type(exc).__name__, "message": str(exc)})
    return {
        "request_id": getattr(exc, "request_id", None),
        "errors": errors,
        "credentials_included": False,
    }


def search_rows(client: Any, customer_id: str, query: str, max_rows: int = MAX_ROWS) -> list[Any]:
    service = client.get_service("GoogleAdsService")
    stream = service.search_stream(customer_id=customer_id, query=query)
    rows: list[Any] = []
    for batch in stream:
        rows.extend(batch.results)
        if len(rows) > max_rows:
            raise ValueError(f"Report exceeds the safety limit of {max_rows} rows; narrow the scope")
    return rows


def customer_identity(client: Any, customer_id: str) -> dict[str, Any]:
    query = """
        SELECT customer.id, customer.descriptive_name, customer.currency_code,
               customer.time_zone, customer.manager, customer.status
        FROM customer
        LIMIT 1
    """
    rows = search_rows(client, customer_id, query)
    if len(rows) != 1:
        raise ValueError(f"Expected one customer row for {customer_id}; found {len(rows)}")
    customer = rows[0].customer
    return {
        "customer_id": str(customer.id),
        "name": customer.descriptive_name,
        "currency_code": customer.currency_code,
        "time_zone": customer.time_zone,
        "manager": bool(customer.manager),
        "status": enum_name(customer.status),
    }


def accounts_report(client: Any) -> dict[str, Any]:
    login_customer_id = normalize_customer_id(getattr(client, "login_customer_id", None), required=False)
    if not login_customer_id:
        raise ValueError("ADS_LOGIN_CUSTOMER_ID is required for the accounts report")
    query = """
        SELECT customer_client.id, customer_client.descriptive_name,
               customer_client.currency_code, customer_client.time_zone,
               customer_client.status, customer_client.manager
        FROM customer_client
        WHERE customer_client.status = 'ENABLED'
          AND customer_client.manager = FALSE
        ORDER BY customer_client.descriptive_name
    """
    accounts = []
    for row in search_rows(client, login_customer_id, query):
        item = row.customer_client
        accounts.append(
            {
                "customer_id": str(item.id),
                "name": item.descriptive_name,
                "currency_code": item.currency_code,
                "time_zone": item.time_zone,
                "status": enum_name(item.status),
            }
        )
    return {
        "report_type": "accounts",
        "source": "Google Ads API",
        "retrieved_at": utc_timestamp(),
        "login_customer_id": login_customer_id,
        "rows": accounts,
        "row_count": len(accounts),
    }


def campaign_filters(campaign_ids: Iterable[str], name_contains: str | None) -> list[str]:
    filters = ["campaign.status != 'REMOVED'"]
    campaign_ids = list(campaign_ids)
    if campaign_ids:
        filters.append("campaign.id IN (" + ",".join(campaign_ids) + ")")
    if name_contains:
        filters.append(f"campaign.name LIKE {gaql_string('%' + name_contains + '%')}")
    return filters


def campaign_inventory_report(
    client: Any,
    customer_id: str,
    campaign_ids: list[str],
    name_contains: str | None,
) -> dict[str, Any]:
    filters = campaign_filters(campaign_ids, name_contains)
    query = f"""
        SELECT campaign.id, campaign.resource_name, campaign.name, campaign.status,
               campaign.advertising_channel_type, campaign.advertising_channel_sub_type,
               campaign.bidding_strategy_type, campaign.campaign_budget,
               campaign_budget.resource_name, campaign_budget.amount_micros,
               campaign_budget.total_amount_micros, campaign_budget.period,
               campaign_budget.explicitly_shared
        FROM campaign
        WHERE {' AND '.join(filters)}
        ORDER BY campaign.name
    """
    rows = []
    for row in search_rows(client, customer_id, query):
        campaign = row.campaign
        budget = row.campaign_budget
        rows.append(
            {
                "campaign_id": str(campaign.id),
                "resource_name": campaign.resource_name,
                "campaign_name": campaign.name,
                "status": enum_name(campaign.status),
                "advertising_channel_type": enum_name(campaign.advertising_channel_type),
                "advertising_channel_sub_type": enum_name(campaign.advertising_channel_sub_type),
                "bidding_strategy_type": enum_name(campaign.bidding_strategy_type),
                "budget_resource_name": budget.resource_name,
                "budget_amount_micros": int(budget.amount_micros or 0),
                "budget_amount": round(int(budget.amount_micros or 0) / 1_000_000, 6),
                "budget_total_amount_micros": int(budget.total_amount_micros or 0),
                "budget_period": enum_name(budget.period),
                "budget_explicitly_shared": bool(budget.explicitly_shared),
            }
        )
    return {
        "report_type": "campaign_inventory",
        "source": "Google Ads API",
        "retrieved_at": utc_timestamp(),
        "customer": customer_identity(client, customer_id),
        "filters": {"campaign_ids": campaign_ids, "campaign_name_contains": name_contains},
        "rows": rows,
        "row_count": len(rows),
    }


def metric_values(metrics: Any) -> dict[str, Any]:
    cost_micros = int(metrics.cost_micros or 0)
    cost = cost_micros / 1_000_000
    impressions = int(metrics.impressions or 0)
    clicks = int(metrics.clicks or 0)
    conversions = float(metrics.conversions or 0)
    conversion_value = float(metrics.conversions_value or 0)
    return {
        "cost_micros": cost_micros,
        "cost": round(cost, 6),
        "impressions": impressions,
        "clicks": clicks,
        "interactions": int(metrics.interactions or 0),
        "conversions": round(conversions, 6),
        "all_conversions": round(float(metrics.all_conversions or 0), 6),
        "conversions_value": round(conversion_value, 6),
        "ctr": round(clicks / impressions, 8) if impressions else None,
        "cost_per_click": round(cost / clicks, 6) if clicks else None,
        "cost_per_conversion": round(cost / conversions, 6) if conversions else None,
        "conversions_value_per_cost": round(conversion_value / cost, 8) if cost else None,
    }


def campaign_performance_report(
    client: Any,
    customer_id: str,
    start_date: str,
    end_date: str,
    grain: str,
    campaign_ids: list[str],
    name_contains: str | None,
) -> dict[str, Any]:
    filters = campaign_filters(campaign_ids, name_contains)
    filters.append(f"segments.date BETWEEN {gaql_string(start_date)} AND {gaql_string(end_date)}")
    segment_select = ", segments.date" if grain == "day" else ""
    segment_order = ", segments.date" if grain == "day" else ""
    query = f"""
        SELECT campaign.id, campaign.name, campaign.status{segment_select},
               metrics.cost_micros, metrics.impressions, metrics.clicks,
               metrics.interactions, metrics.conversions, metrics.all_conversions,
               metrics.conversions_value
        FROM campaign
        WHERE {' AND '.join(filters)}
        ORDER BY campaign.id{segment_order}
    """
    rows = []
    for row in search_rows(client, customer_id, query):
        item = {
            "campaign_id": str(row.campaign.id),
            "campaign_name": row.campaign.name,
            "campaign_status": enum_name(row.campaign.status),
            **metric_values(row.metrics),
        }
        if grain == "day":
            item["date"] = str(row.segments.date)
        rows.append(item)
    totals = {
        "cost_micros": sum(item["cost_micros"] for item in rows),
        "impressions": sum(item["impressions"] for item in rows),
        "clicks": sum(item["clicks"] for item in rows),
        "interactions": sum(item["interactions"] for item in rows),
        "conversions": round(sum(item["conversions"] for item in rows), 6),
        "all_conversions": round(sum(item["all_conversions"] for item in rows), 6),
        "conversions_value": round(sum(item["conversions_value"] for item in rows), 6),
    }
    totals["cost"] = round(totals["cost_micros"] / 1_000_000, 6)
    return {
        "report_type": "campaign_performance",
        "source": "Google Ads API",
        "retrieved_at": utc_timestamp(),
        "customer": customer_identity(client, customer_id),
        "date_start": start_date,
        "date_end": end_date,
        "grain": grain,
        "metric_note": "conversions are Google Ads conversions, not assumed installs",
        "filters": {"campaign_ids": campaign_ids, "campaign_name_contains": name_contains},
        "totals": totals,
        "rows": rows,
        "row_count": len(rows),
    }


def canonical_creative_name(raw_name: str) -> str:
    value = raw_name or ""
    value = re.sub(r"^[0-9a-fA-F]{32}[\s_.-]+", "", value)
    value = re.sub(r"\s*\(\d+\)\s*$", "", value)
    return value.strip() or raw_name


def creative_performance_report(
    client: Any,
    customer_id: str,
    start_date: str,
    end_date: str,
    campaign_ids: list[str],
    name_contains: str | None,
) -> dict[str, Any]:
    filters = [f"segments.date BETWEEN {gaql_string(start_date)} AND {gaql_string(end_date)}"]
    if campaign_ids:
        filters.append("campaign.id IN (" + ",".join(campaign_ids) + ")")
    if name_contains:
        filters.append(f"campaign.name LIKE {gaql_string('%' + name_contains + '%')}")
    query = f"""
        SELECT campaign.id, campaign.name, ad_group.id, ad_group.name,
               ad_group_ad.ad.id, ad_group_ad_asset_view.asset,
               ad_group_ad_asset_view.field_type,
               ad_group_ad_asset_view.performance_label,
               asset.id, asset.resource_name, asset.name, asset.type,
               asset.youtube_video_asset.youtube_video_id,
               asset.youtube_video_asset.youtube_video_title,
               metrics.cost_micros, metrics.impressions, metrics.clicks,
               metrics.interactions, metrics.conversions, metrics.all_conversions,
               metrics.conversions_value
        FROM ad_group_ad_asset_view
        WHERE {' AND '.join(filters)}
        ORDER BY campaign.id, ad_group.id, asset.id
    """
    rows = []
    for row in search_rows(client, customer_id, query):
        raw_name = (
            row.asset.name
            or row.asset.youtube_video_asset.youtube_video_title
            or row.asset.youtube_video_asset.youtube_video_id
            or f"asset_{row.asset.id}"
        )
        rows.append(
            {
                "campaign_id": str(row.campaign.id),
                "campaign_name": row.campaign.name,
                "ad_group_id": str(row.ad_group.id),
                "ad_group_name": row.ad_group.name,
                "ad_id": str(row.ad_group_ad.ad.id),
                "asset_id": str(row.asset.id),
                "asset_resource_name": row.asset.resource_name,
                "asset_name_raw": raw_name,
                "asset_name_canonical": canonical_creative_name(raw_name),
                "asset_type": enum_name(row.asset.type),
                "field_type": enum_name(row.ad_group_ad_asset_view.field_type),
                "performance_label": enum_name(row.ad_group_ad_asset_view.performance_label),
                "youtube_video_id": row.asset.youtube_video_asset.youtube_video_id or None,
                **metric_values(row.metrics),
            }
        )
    return {
        "report_type": "creative_performance",
        "source": "Google Ads API",
        "retrieved_at": utc_timestamp(),
        "customer": customer_identity(client, customer_id),
        "date_start": start_date,
        "date_end": end_date,
        "grain": "campaign × ad_group × ad × asset",
        "metric_note": "conversions are Google Ads conversions, not assumed installs",
        "additivity_warning": "Do not sum asset rows into campaign totals without reconciliation against campaign_performance",
        "normalization": ["leading 32-character hex hash", "trailing numeric ID in parentheses"],
        "filters": {"campaign_ids": campaign_ids, "campaign_name_contains": name_contains},
        "rows": rows,
        "row_count": len(rows),
    }


def generate_report(args: argparse.Namespace) -> dict[str, Any]:
    client = load_client()
    if args.report_type == "accounts":
        return accounts_report(client)

    customer_id = normalize_customer_id(args.customer_id)
    campaign_ids = normalize_campaign_ids(args.campaign_ids)
    name_contains = args.campaign_name_contains.strip() if args.campaign_name_contains else None
    if args.report_type == "campaign_inventory":
        return campaign_inventory_report(client, customer_id, campaign_ids, name_contains)

    start_date, end_date = validate_date_range(args.start_date, args.end_date)
    if args.report_type == "campaign_performance":
        return campaign_performance_report(
            client,
            customer_id,
            start_date,
            end_date,
            args.grain,
            campaign_ids,
            name_contains,
        )
    return creative_performance_report(
        client,
        customer_id,
        start_date,
        end_date,
        campaign_ids,
        name_contains,
    )


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--report-type",
        required=True,
        choices=["accounts", "campaign_inventory", "campaign_performance", "creative_performance"],
    )
    parser.add_argument("--customer-id")
    parser.add_argument("--start-date")
    parser.add_argument("--end-date")
    parser.add_argument("--grain", choices=["total", "day"], default="total")
    parser.add_argument("--campaign-ids", default="")
    parser.add_argument("--campaign-name-contains", default="")
    parser.add_argument("--output", required=True)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    output = Path(args.output).expanduser().resolve()
    try:
        report = generate_report(args)
        write_json(output, {"ok": True, **report, "credentials_included": False})
        print(json.dumps({"ok": True, "output": str(output), "report_type": args.report_type}))
        return 0
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError) as exc:
        write_json(
            output,
            {
                "ok": False,
                "report_type": args.report_type,
                "generated_at": utc_timestamp(),
                "error": str(exc),
                "credentials_included": False,
            },
        )
        print(json.dumps({"ok": False, "output": str(output), "error": str(exc)}))
        return 2
    except Exception as exc:
        write_json(
            output,
            {
                "ok": False,
                "report_type": args.report_type,
                "generated_at": utc_timestamp(),
                "google_ads_error": sanitized_error(exc),
                "credentials_included": False,
            },
        )
        print(json.dumps({"ok": False, "output": str(output), "google_ads_error": sanitized_error(exc)}))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
