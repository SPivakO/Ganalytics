"""Standalone Adjust Report Service client for the one-off ad group impact report.

Mirrors the request/parse behaviour of ``app.py:_fetch_adjust_creative_daily_cost``
(dual auth header, GET-with-POST-fallback, CSV-or-JSON payloads, date-keyed pivot
flattening), but with a configurable metric/dimension set and no FastAPI import.
"""

import csv
import io
import json
import re
import time
from typing import Any, Dict, List, Optional, Tuple
from urllib import parse as urlparse
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

PIVOT_URL = "https://automate.adjust.com/reports-service/pivot_report"

# Transient conditions worth retrying: rate limiting and gateway/server hiccups.
RETRY_STATUSES = {408, 429, 500, 502, 503, 504}


class AdjustError(RuntimeError):
    """Adjust responded with something we cannot use."""

    def __init__(self, message: str, status: Optional[int] = None, body: bytes = b""):
        super().__init__(message)
        self.status = status
        self.body = body


def adjust_request(
    url: str,
    api_token: str,
    method: str = "GET",
    json_body: Optional[dict] = None,
    timeout: int = 180,
    max_attempts: int = 4,
) -> Dict[str, Any]:
    """Call Adjust, trying both documented auth header styles, retrying transient failures."""
    headers_variants = [
        {"Authorization": f"Bearer {api_token}", "Accept": "*/*"},
        {"Authorization": f"Token token={api_token}", "Accept": "*/*"},
    ]
    data = json.dumps(json_body).encode("utf-8") if json_body is not None else None

    last_err: Optional[Exception] = None
    for attempt in range(max_attempts):
        retryable = False
        for headers in headers_variants:
            h = dict(headers)
            if data is not None:
                h["Content-Type"] = "application/json"
            try:
                req = urlrequest.Request(url, headers=h, method=method, data=data)
                with urlrequest.urlopen(req, timeout=timeout) as resp:
                    return {
                        "status": getattr(resp, "status", 200),
                        "content_type": resp.headers.get("Content-Type", ""),
                        "body": resp.read(),
                        "method": method,
                    }
            except HTTPError as e:
                try:
                    body = e.read()
                except Exception:
                    body = b""
                last_err = AdjustError(
                    f"Adjust HTTP {e.code} {e.reason}: {body[:500]!r}", status=e.code, body=body
                )
                if e.code in RETRY_STATUSES:
                    retryable = True
                    break  # no point trying the other auth header for a 5xx/429
            except URLError as e:
                last_err = AdjustError(f"Adjust URLError: {e.reason}")
                retryable = True
                break
            except Exception as e:  # noqa: BLE001 - surfaced via last_err below
                last_err = e

        if not retryable:
            break
        if attempt < max_attempts - 1:
            backoff = 2 ** (attempt + 1)
            print(f"    transient Adjust failure ({last_err}); retrying in {backoff}s")
            time.sleep(backoff)

    raise last_err or AdjustError("Adjust request failed")


def parse_payload(content_type: str, body: bytes) -> List[dict]:
    """Adjust answers with JSON or CSV depending on the endpoint and params."""
    text = body.decode("utf-8", errors="replace")
    ct = (content_type or "").lower()
    stripped = text.lstrip().lower()
    if "text/html" in ct or stripped.startswith("<!doctype") or stripped.startswith("<html"):
        raise AdjustError(f"Adjust returned HTML, not data. Snippet: {text[:300]!r}")
    if "application/json" in ct or text.strip().startswith(("{", "[")):
        data = json.loads(text)
        if isinstance(data, dict):
            for k in ("rows", "data", "result", "results"):
                if isinstance(data.get(k), list):
                    return data[k]
            return []
        if isinstance(data, list):
            return data
        return []
    return list(csv.DictReader(io.StringIO(text)))


def norm_key(k: str) -> str:
    k = (k or "").strip().lower()
    k = re.sub(r"[^a-z0-9]+", "_", k)
    return re.sub(r"_+", "_", k).strip("_")


def _looks_like_date_key(s: str) -> bool:
    return bool(re.match(r"^\d{4}-\d{2}-\d{2}$", (s or "").strip()))


def flatten_rows(rows: List[dict]) -> List[dict]:
    """Un-nest the ``{"2026-01-01": {...}}`` pivot shape into flat rows carrying ``day``."""
    out: List[dict] = []
    for r in rows:
        if not isinstance(r, dict) or not r:
            continue
        found_nested = False
        for k, v in r.items():
            if not _looks_like_date_key(k):
                continue
            found_nested = True
            inner_rows: List[Any] = []
            if isinstance(v, dict):
                if isinstance(v.get("rows"), list):
                    inner_rows = v["rows"]
                elif isinstance(v.get("data"), list):
                    inner_rows = v["data"]
                else:
                    item = dict(v)
                    item["day"] = k
                    out.append(item)
                    continue
            elif isinstance(v, list):
                inner_rows = v
            for inner in inner_rows:
                if isinstance(inner, dict):
                    item = dict(inner)
                    item["day"] = k
                    out.append(item)
        if not found_nested:
            out.append(r)
    return out


def store_type_for_platform(platform: str) -> str:
    return "app_store" if (platform or "").strip().lower() == "ios" else "google_play"


def build_pivot_params(
    app_token: str,
    start_date: str,
    end_date: str,
    dimensions: List[str],
    metrics: List[str],
    channel_id: Optional[str] = None,
    store_type: Optional[str] = None,
    index: str = "day",
    cohort_maturity: str = "mature",
    extra: Optional[Dict[str, str]] = None,
) -> Dict[str, str]:
    params: Dict[str, str] = {
        "app_token__in": f'"{app_token}"',
        "index": index,
        "dimensions": ",".join(dimensions),
        "metrics": ",".join(metrics),
        "date_period": f"{start_date}:{end_date}",
        "ad_spend_mode": "network",
        "attribution_source": "first",
        "reattributed": "all",
        "sandbox": "false",
        "cohort_maturity": cohort_maturity,
        "format_dates": "true",
        "full_data": "true",
        "readable_names": "true",
    }
    if channel_id:
        params["channel_id__in"] = f'"{channel_id}"'
    if store_type:
        params["store_type__in"] = f'"{store_type}"'
    if extra:
        params.update(extra)
    return params


def pivot_report(
    api_token: str,
    app_token: str,
    start_date: str,
    end_date: str,
    dimensions: List[str],
    metrics: List[str],
    channel_id: Optional[str] = None,
    store_type: Optional[str] = None,
    index: str = "day",
    cohort_maturity: str = "mature",
    extra: Optional[Dict[str, str]] = None,
    timeout: int = 180,
) -> Tuple[List[dict], Dict[str, Any]]:
    """Run one pivot_report call and return (rows with snake_cased keys, debug info).

    Values are returned as Adjust sent them; callers decide how to coerce and rename.
    """
    params = build_pivot_params(
        app_token=app_token,
        start_date=start_date,
        end_date=end_date,
        dimensions=dimensions,
        metrics=metrics,
        channel_id=channel_id,
        store_type=store_type,
        index=index,
        cohort_maturity=cohort_maturity,
        extra=extra,
    )
    url = PIVOT_URL + "?" + urlparse.urlencode(params, safe=',:"')

    try:
        resp = adjust_request(url, api_token=api_token, method="GET", timeout=timeout)
        raw_body = resp.get("body", b"") or b""
        rows = parse_payload(resp.get("content_type", ""), raw_body)
    except AdjustError as e:
        msg = str(e)
        # Some tenants reject the query-string form of index/date_period; retry as POST.
        if 'loc":["index"]' not in msg and 'loc":["date_period"]' not in msg and "validation_error" not in msg:
            raise
        payload_variants = [
            {
                **{k: v.strip('"') if isinstance(v, str) else v for k, v in params.items()},
                "format_dates": True,
                "full_data": True,
                "readable_names": True,
            },
            {
                "index": index,
                "dimensions": list(dimensions),
                "metrics": list(metrics),
                "date_period": f"{start_date}:{end_date}",
                "cohort_maturity": cohort_maturity,
                "ad_spend_mode": "network",
                "filters": {
                    k: [v]
                    for k, v in (
                        ("app_token__in", app_token),
                        ("channel_id__in", channel_id),
                        ("store_type__in", store_type),
                    )
                    if v
                },
                "readable_names": True,
                "full_data": True,
            },
        ]
        rows = None
        last = e
        for payload in payload_variants:
            try:
                resp = adjust_request(PIVOT_URL, api_token=api_token, method="POST", json_body=payload, timeout=timeout)
                raw_body = resp.get("body", b"") or b""
                rows = parse_payload(resp.get("content_type", ""), raw_body)
                break
            except Exception as e2:  # noqa: BLE001 - re-raised below if every variant fails
                last = e2
        if rows is None:
            raise last

    flat = flatten_rows(rows)
    norm: List[dict] = [{norm_key(k): v for k, v in r.items()} for r in flat if isinstance(r, dict)]

    debug = {
        "method": resp.get("method", "GET"),
        "content_type": resp.get("content_type", ""),
        "body_len": len(raw_body),
        "row_count": len(norm),
        "first_row_keys": list(norm[0].keys())[:40] if norm else [],
        "snippet": raw_body[:200].decode("utf-8", errors="replace"),
    }
    return norm, debug


def to_float(v: Any) -> float:
    if v is None or v == "":
        return 0.0
    if isinstance(v, str):
        v = v.replace(",", "").replace("%", "").strip()
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def to_int(v: Any) -> int:
    return int(to_float(v))
