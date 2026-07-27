"""Render out/dashboard_data.json into a single self-contained dashboard.html.

ECharts is inlined rather than pulled from a CDN so the file works offline and can be
handed around as one artefact. Run build.py first.

Run:  ./venv/bin/python oneoff/adgroup_impact/render.py
"""

import argparse
import json
import shutil
import subprocess
import tempfile
import urllib.request
from pathlib import Path

import config

ECHARTS_VERSION = "5.5.1"
VENDOR_DIR = config.BASE_DIR / "vendor"
ECHARTS_PATH = VENDOR_DIR / "echarts.min.js"
CDN_URL = f"https://cdn.jsdelivr.net/npm/echarts@{ECHARTS_VERSION}/dist/echarts.min.js"


def ensure_echarts() -> str:
    """Return the ECharts source, fetching it once into the gitignored vendor dir."""
    if ECHARTS_PATH.exists():
        return ECHARTS_PATH.read_text(encoding="utf-8")

    VENDOR_DIR.mkdir(parents=True, exist_ok=True)
    try:
        with urllib.request.urlopen(CDN_URL, timeout=60) as resp:
            source = resp.read().decode("utf-8")
        ECHARTS_PATH.write_text(source, encoding="utf-8")
        return source
    except Exception as cdn_error:  # noqa: BLE001 - npm is the fallback path
        print(f"  CDN unavailable ({str(cdn_error)[:120]}), trying the npm registry")

    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(
            ["npm", "pack", f"echarts@{ECHARTS_VERSION}"], cwd=tmp, check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        )
        tarball = next(Path(tmp).glob("echarts-*.tgz"))
        subprocess.run(
            ["tar", "-xzf", str(tarball), "-C", tmp, "package/dist/echarts.min.js"], check=True
        )
        shutil.copy(Path(tmp) / "package" / "dist" / "echarts.min.js", ECHARTS_PATH)
    return ECHARTS_PATH.read_text(encoding="utf-8")


def main() -> None:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--out", default=str(config.OUT_DIR / "dashboard.html"))
    args = p.parse_args()

    data_path = config.OUT_DIR / "dashboard_data.json"
    if not data_path.exists():
        raise SystemExit(f"{data_path} not found — run build.py first.")

    data = data_path.read_text(encoding="utf-8")
    template = (config.BASE_DIR / "dashboard_template.html").read_text(encoding="utf-8")
    app_js = (config.BASE_DIR / "dashboard_app.js").read_text(encoding="utf-8")
    echarts = ensure_echarts()

    # </script> anywhere inside injected content would close the host tag early.
    data = data.replace("</script>", "<\\/script>")

    html = (
        template
        .replace("__ECHARTS__", echarts)
        .replace("__DATA__", data)
        .replace("__APP__", app_js)
    )

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(html, encoding="utf-8")

    payload = json.loads(data_path.read_text(encoding="utf-8"))
    print(f"Wrote {out}  ({out.stat().st_size / 1_048_576:.1f} MB)")
    print(f"  campaigns: {len(payload['campaigns'])}, events: {len(payload['events'])}, days: {len(payload['dates'])}")


if __name__ == "__main__":
    main()
