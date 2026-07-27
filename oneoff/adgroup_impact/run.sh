#!/usr/bin/env bash
# One command to produce the report:  bash oneoff/adgroup_impact/run.sh
#
# Creates its own venv, installs only what this report needs (not the web service's
# dependencies), then probes Adjust, pulls, builds and renders. Safe to re-run:
# API responses are cached per chunk, so a second run resumes instead of refetching.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
VENV="$HERE/.venv"
START="${START:-2024-01-01}"
END="${END:-2026-06-30}"

fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }
step() { printf '\n\033[36m==> %s\033[0m\n' "$*"; }

# --- python ---------------------------------------------------------------
PY=""
for c in python3.12 python3.11 python3.10 python3; do
  command -v "$c" >/dev/null 2>&1 || continue
  if "$c" -c 'import sys; sys.exit(0 if (3,10) <= sys.version_info < (3,14) else 1)' 2>/dev/null; then
    PY="$c"; break
  fi
done
[ -n "$PY" ] || fail "Нужен Python 3.10-3.13. Установи python3.12 и запусти снова."
step "Python: $($PY -V)"

# --- env ------------------------------------------------------------------
if [ ! -f "$ROOT/.env" ]; then
  fail "Нет файла $ROOT/.env
Создай его с этими строками (значения свои):

  ADJUST_API_TOKEN=...
  ADS_DEVELOPER_TOKEN=...
  ADS_CLIENT_ID=...
  ADS_CLIENT_SECRET=...
  ADS_REFRESH_TOKEN=...
  ADS_LOGIN_CUSTOMER_ID=..."
fi
missing=""
for k in ADJUST_API_TOKEN ADS_DEVELOPER_TOKEN ADS_CLIENT_ID ADS_CLIENT_SECRET ADS_REFRESH_TOKEN ADS_LOGIN_CUSTOMER_ID; do
  grep -qE "^[[:space:]]*${k}=[^[:space:]]" "$ROOT/.env" || missing="$missing $k"
done
[ -z "$missing" ] || fail "В $ROOT/.env не заполнено:$missing"

# --- reachability ---------------------------------------------------------
# Fail in seconds rather than after minutes of retries if a host is unreachable.
for host in automate.adjust.com googleads.googleapis.com; do
  if ! curl -sS -o /dev/null --max-time 15 "https://$host/" 2>/dev/null; then
    fail "Нет доступа к https://$host

Проверь сеть, VPN или корпоративный прокси — API этого хоста должен быть доступен.
Данные оттуда без этого не выгрузятся."
  fi
done
step "Сеть: Adjust и Google Ads доступны"

# --- deps -----------------------------------------------------------------
if [ ! -x "$VENV/bin/python" ]; then
  step "Создаю venv в $VENV"
  "$PY" -m venv "$VENV" || fail "Не удалось создать venv. На Debian/Ubuntu: sudo apt install python3-venv"
fi
step "Ставлю зависимости"
"$VENV/bin/pip" install -q --upgrade pip >/dev/null 2>&1
"$VENV/bin/pip" install -q "google-ads>=28.2.0" "pandas>=2.0.0" openpyxl python-dotenv \
  || fail "pip install не прошёл. Покажи вывод выше — по нему видно причину."

# --- run ------------------------------------------------------------------
cd "$HERE" || fail "Не найден каталог $HERE"

if [ ! -f "$HERE/probe_result.json" ]; then
  step "Разведка Adjust (какие метрики и каналы доступны)"
  "$VENV/bin/python" probe_adjust.py || fail "Разведка Adjust не прошла — см. ошибку выше."
else
  step "probe_result.json уже есть, пропускаю разведку (удали файл, чтобы переснять)"
fi

step "Выгрузка $START .. $END (долгий шаг, чанки кэшируются)"
"$VENV/bin/python" pull.py --start "$START" --end "$END" || fail "Выгрузка не прошла — см. ошибку выше."

step "Сборка таблиц"
"$VENV/bin/python" build.py || fail "Сборка не прошла — см. ошибку выше."

step "Рендер дашборда"
"$VENV/bin/python" render.py || fail "Рендер не прошёл — см. ошибку выше."

printf '\n\033[32mГотово.\033[0m\n'
printf '  дашборд : %s\n' "$HERE/out/dashboard.html"
printf '  таблицы : %s\n' "$HERE/out/adgroup_impact.xlsx"
printf '\nОткрой dashboard.html в браузере.\n'
