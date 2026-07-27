#Requires -Version 5.1
<#
  Один запуск вместо шести команд:

      powershell -ExecutionPolicy Bypass -File oneoff\adgroup_impact\run.ps1

  Создаёт свой venv, ставит только то, что нужно отчёту, затем: разведка Adjust,
  выгрузка, сборка таблиц, рендер дашборда. Повторный запуск продолжает с места
  обрыва — ответы API кэшируются по чанкам.
#>

[CmdletBinding()]
param(
  [string]$Start = "2024-01-01",
  [string]$End   = "2026-06-30"
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $Here "..\..")).Path
$Venv = Join-Path $Here ".venv"

function Step($m) { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "`n$m`n" -ForegroundColor Red; exit 1 }

# Windows puts the venv interpreter in Scripts\, everything else in bin/.
function Get-VenvPython($venv) {
  foreach ($rel in @("Scripts\python.exe", "bin/python")) {
    $p = Join-Path $venv $rel
    if (Test-Path $p) { return $p }
  }
  return $null
}

# --- python ---------------------------------------------------------------
$candidates = @(
  @{ Exe = "py";      Args = @("-3.12") },
  @{ Exe = "py";      Args = @("-3.11") },
  @{ Exe = "py";      Args = @("-3.13") },
  @{ Exe = "py";      Args = @("-3.10") },
  @{ Exe = "py";      Args = @("-3")    },
  @{ Exe = "python";  Args = @()        },
  @{ Exe = "python3"; Args = @()        }
)
$check = 'import sys; sys.exit(0 if (3,10) <= sys.version_info < (3,14) else 1)'
$py = $null
foreach ($c in $candidates) {
  if (-not (Get-Command $c.Exe -ErrorAction SilentlyContinue)) { continue }
  & $c.Exe @($c.Args + @("-c", $check)) 2>$null
  if ($LASTEXITCODE -eq 0) { $py = $c; break }
}
if (-not $py) {
  Fail @"
Не нашёл Python 3.10-3.13.
Поставь с https://www.python.org/downloads/ (галочка "Add python.exe to PATH")
и запусти скрипт снова.
"@
}
$pyVersion = (& $py.Exe @($py.Args + @("-V")) 2>&1) -join " "
Step "Python: $pyVersion"

# --- .env -----------------------------------------------------------------
$envPath = Join-Path $Root ".env"
if (-not (Test-Path $envPath)) {
  Fail @"
Нет файла $envPath

Создай его и впиши свои значения:

  ADJUST_API_TOKEN=...
  ADS_DEVELOPER_TOKEN=...
  ADS_CLIENT_ID=...
  ADS_CLIENT_SECRET=...
  ADS_REFRESH_TOKEN=...
  ADS_LOGIN_CUSTOMER_ID=...
"@
}
$envText = Get-Content $envPath -Raw
$missing = @()
foreach ($k in @("ADJUST_API_TOKEN","ADS_DEVELOPER_TOKEN","ADS_CLIENT_ID",
                 "ADS_CLIENT_SECRET","ADS_REFRESH_TOKEN","ADS_LOGIN_CUSTOMER_ID")) {
  if ($envText -notmatch "(?m)^\s*$k=\S") { $missing += $k }
}
if ($missing.Count) { Fail "В $envPath не заполнено: $($missing -join ', ')" }

# --- доступность хостов ---------------------------------------------------
# Падаем за секунду, а не через десять минут ретраев, если хост закрыт.
function Test-HostReachable($h) {
  try {
    Invoke-WebRequest -Uri "https://$h/" -Method Head -TimeoutSec 15 -UseBasicParsing | Out-Null
    return $true
  } catch {
    # Сервер ответил хоть чем-то (403/404) — значит хост доступен.
    if ($_.Exception.Response) { return $true }
    return $false
  }
}
foreach ($h in @("automate.adjust.com", "googleads.googleapis.com")) {
  if (-not (Test-HostReachable $h)) {
    Fail @"
Нет доступа к https://$h

Проверь сеть, VPN или корпоративный прокси — этот хост должен открываться.
Без него данные оттуда не выгрузятся.
"@
  }
}
Step "Сеть: Adjust и Google Ads доступны"

# --- зависимости ----------------------------------------------------------
$VenvPy = Get-VenvPython $Venv
if (-not $VenvPy) {
  Step "Создаю venv в $Venv"
  & $py.Exe @($py.Args + @("-m", "venv", $Venv))
  $VenvPy = Get-VenvPython $Venv
  if (-not $VenvPy) { Fail "Не удалось создать venv в $Venv" }
}
Step "Ставлю зависимости"
& $VenvPy -m pip install -q --upgrade pip 2>&1 | Out-Null
& $VenvPy -m pip install -q "google-ads>=28.2.0" "pandas>=2.0.0" openpyxl python-dotenv
if ($LASTEXITCODE -ne 0) { Fail "pip install не прошёл. Причина в выводе выше." }

# --- запуск ---------------------------------------------------------------
Push-Location $Here
try {
  $probe = Join-Path $Here "probe_result.json"
  if (-not (Test-Path $probe)) {
    Step "Разведка Adjust (какие метрики и каналы доступны)"
    & $VenvPy probe_adjust.py
    if ($LASTEXITCODE -ne 0) { Fail "Разведка Adjust не прошла — см. ошибку выше." }
  } else {
    Step "probe_result.json уже есть, пропускаю разведку (удали файл, чтобы переснять)"
  }

  Step "Выгрузка $Start .. $End (долгий шаг, чанки кэшируются)"
  & $VenvPy pull.py --start $Start --end $End
  if ($LASTEXITCODE -ne 0) { Fail "Выгрузка не прошла — см. ошибку выше." }

  Step "Сборка таблиц"
  & $VenvPy build.py
  if ($LASTEXITCODE -ne 0) { Fail "Сборка не прошла — см. ошибку выше." }

  Step "Рендер дашборда"
  & $VenvPy render.py
  if ($LASTEXITCODE -ne 0) { Fail "Рендер не прошёл — см. ошибку выше." }
} finally {
  Pop-Location
}

$dash = Join-Path $Here "out\dashboard.html"
Write-Host "`nГотово." -ForegroundColor Green
Write-Host "  дашборд : $dash"
Write-Host "  таблицы : $(Join-Path $Here 'out\adgroup_impact.xlsx')"
Write-Host "`nОткрываю дашборд в браузере..."
if (Test-Path $dash) { Start-Process $dash }
