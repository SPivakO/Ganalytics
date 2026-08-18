"""Отправка событий в Starplay Metrics (https://metrics.starplay.work).

Вариант А из PROJECT_SETUP.md: браузер шлёт события на свой же origin (/api/r),
наружу в ingest ходит только сервер. UUID проекта в клиентский бандл не попадает,
а блокировщики не видят аналитического хоста.

Сервис не за Cloudflare, поэтому геозаголовки cf-* не пробрасываются: гео ingest
определит по IP, который мы отдаём в True-Client-IP.
"""

import json
import os
import threading
from datetime import datetime
from typing import Any, Optional
from urllib import request as urlrequest
from urllib.error import HTTPError, URLError

WEBSITE_ID = os.getenv("ANALYTICS_WEBSITE_ID", "4061d112-d8ab-4954-894e-819bb15bce98")
SEND_URL = os.getenv("ANALYTICS_SEND_URL", "https://metrics.starplay.work/api/send")

_DISABLED_VALUES = {"0", "false", "no", "off"}
_ENABLED = os.getenv("ANALYTICS_ENABLED", "true").strip().lower() not in _DISABLED_VALUES
_LOCAL_HOSTS = {"localhost", "127.0.0.1", "0.0.0.0", "::1", "testserver", ""}
_TIMEOUT = 3

# Что разрешено присылать браузеру. business_action_success и auth_attempt
# отправляет только сервер: клиентскому телу в таких событиях доверять нельзя.
CLIENT_EVENTS = {"page_visit", "filter_change", "report_export", "error_shown"}
SERVER_EVENTS = {"page_visit", "business_action_success", "auth_attempt"}

# Санитайзер data: на каждое имя события — свой набор ключей, всё лишнее молча
# отбрасывается, чтобы имена и поля не расползались.
EVENT_DATA_KEYS = {
    "filter_change": {"surface", "filter", "value"},
    "report_export": {"format", "rows", "days"},
    "error_shown": {"surface", "kind"},
    "business_action_success": {
        "action", "surface", "accounts", "campaigns", "adgroup_type", "days",
        "rows", "platform", "videos", "created", "failed", "removed", "added",
        "skipped", "total_ms",
    },
    "auth_attempt": {"status", "reason"},
}

MAX_NAME = 128
MAX_TITLE = 512
MAX_URL = 2048
MAX_STRING = 500
MAX_SHORT = 64
MAX_KEYS = 50


def _clip(value: Any, limit: int) -> str:
    if value is None:
        return ""
    text = value if isinstance(value, str) else str(value)
    return text[:limit]


def _as_text(value: Any, limit: int = MAX_STRING) -> str:
    return _clip(value, limit) if isinstance(value, (str, int, float)) else ""


def _header(request: Any, name: str) -> str:
    try:
        return (request.headers.get(name) or "").strip()
    except Exception:
        return ""


def _client_ip(request: Any) -> str:
    """Настоящий IP посетителя, иначе ingest склеит всех в одну сессию сервера."""
    for header in ("x-forwarded-for", "true-client-ip", "x-real-ip"):
        value = _header(request, header)
        if value:
            ip = value.split(",")[0].strip()
            if ip:
                return ip
    client = getattr(request, "client", None)
    return getattr(client, "host", "") or ""


def _hostname(request: Any, fallback: str = "") -> str:
    host = _header(request, "x-forwarded-host") or _header(request, "host")
    host = host.split(",")[0].strip().split(":")[0]
    return host or fallback.split(":")[0]


def sanitize_data(name: str, data: Any) -> dict:
    """Плоский объект: выживают только строки, числа и bool."""
    allowed = EVENT_DATA_KEYS.get(name)
    if not allowed or not isinstance(data, dict):
        return {}
    clean = {}
    for key, value in data.items():
        if len(clean) >= MAX_KEYS:
            break
        if key not in allowed:
            continue
        if isinstance(value, bool) or isinstance(value, (int, float)):
            clean[key] = value
        elif isinstance(value, str):
            clean[key] = value[:MAX_STRING]
    return clean


def days_between(start_date: str, end_date: str) -> Optional[int]:
    try:
        start = datetime.strptime(start_date, "%Y-%m-%d")
        end = datetime.strptime(end_date, "%Y-%m-%d")
    except (TypeError, ValueError):
        return None
    return (end - start).days + 1


def _post(body: dict, headers: dict) -> None:
    payload = json.dumps(body).encode("utf-8")
    req = urlrequest.Request(SEND_URL, data=payload, headers=headers, method="POST")
    with urlrequest.urlopen(req, timeout=_TIMEOUT) as resp:
        status = getattr(resp, "status", 200)
        if status >= 300:
            print(f"[analytics] Ingest rejected payload: {status}")


def _deliver(bodies: list, headers: dict) -> None:
    for body in bodies:
        try:
            _post(body, headers)
        except HTTPError as e:
            snippet = b""
            try:
                snippet = e.read()[:200]
            except Exception:
                pass
            print(f"[analytics] Ingest rejected payload: {e.code} {snippet!r}")
        except URLError as e:
            print(f"[analytics] Failed to deliver payload: {e.reason}")
        except Exception as e:
            print(f"[analytics] Failed to deliver payload: {e}")


def track(
    request: Any,
    name: str,
    *,
    url: str = "/",
    data: Any = None,
    title: str = "",
    referrer: str = "",
    screen: str = "",
    language: str = "",
    hostname: str = "",
    email: Optional[str] = None,
    identify: bool = False,
) -> None:
    """Кладёт событие в фоновую отправку. Никогда не бросает и не блокирует ответ."""
    if not _ENABLED or not WEBSITE_ID:
        return
    if name not in SERVER_EVENTS and name not in CLIENT_EVENTS:
        return

    host = _hostname(request, hostname)
    if host in _LOCAL_HOSTS:
        return

    payload = {
        "website": WEBSITE_ID,
        "hostname": host,
        "url": _clip(url, MAX_URL) or "/",
        "referrer": _clip(referrer, MAX_URL),
        "title": _clip(title, MAX_TITLE),
        "screen": _clip(screen, MAX_SHORT),
        "language": _clip(language, MAX_SHORT),
    }
    # Email берём только из серверной сессии: в теле клиентского запроса его
    # подделает кто угодно.
    if email:
        payload["id"] = _clip(email, MAX_STRING)

    # Без name запись считается просмотром страницы, с name — событием.
    if name != "page_visit":
        payload["name"] = _clip(name, MAX_NAME)
        clean = sanitize_data(name, data)
        if clean:
            payload["data"] = clean

    bodies = [{"type": "event", "payload": payload}]
    # identify не создаёт сессию, поэтому идёт после просмотра страницы;
    # id на самом событии проставит пользователя в любом случае.
    if identify and email:
        bodies.append({
            "type": "identify",
            "payload": {
                "website": WEBSITE_ID,
                "hostname": host,
                "url": payload["url"],
                "id": payload.get("id"),
            },
        })

    headers = {
        "Content-Type": "application/json",
        # UA посетителя, а не рантайма: он входит в хеш визитора.
        "User-Agent": _header(request, "user-agent") or "ganalytics-server",
    }
    ip = _client_ip(request)
    if ip:
        headers["X-Forwarded-For"] = ip
        # Ingest стоит за nginx, который перезаписывает X-Real-IP своим адресом,
        # True-Client-IP он не трогает.
        headers["True-Client-IP"] = ip

    threading.Thread(target=_deliver, args=(bodies, headers), daemon=True).start()


def track_client_event(
    request: Any,
    body: Any,
    email: Optional[str] = None,
    identify: bool = False,
) -> None:
    """Клиентское тело — недоверенный ввод: имя по белому списку, data по санитайзеру."""
    if not isinstance(body, dict):
        return
    name = body.get("name")
    if not isinstance(name, str) or name not in CLIENT_EVENTS:
        return
    track(
        request,
        name,
        url=_as_text(body.get("url"), MAX_URL) or "/",
        data=body.get("data"),
        title=_as_text(body.get("title"), MAX_TITLE),
        referrer=_as_text(body.get("referrer"), MAX_URL),
        screen=_as_text(body.get("screen"), MAX_SHORT),
        language=_as_text(body.get("language"), MAX_SHORT),
        hostname=_as_text(body.get("hostname"), MAX_SHORT),
        email=email,
        identify=identify,
    )
