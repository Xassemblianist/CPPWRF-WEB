#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Assembles the forecast site for GitHub Pages in dist/forecast/: the page (forecast/web) and sample forecasts.
# With the local server running on the visitor's machine the page uses it; without, it shows these samples.
#   tools/build_forecast_site.sh [RUN_ID ...]     (default: the starred runs that are done)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
OUT=dist/forecast
rm -rf "$OUT"
mkdir -p "$OUT/samples"
cp -r forecast/web/. "$OUT/"
rm -rf "$OUT/samples"/*
ids=("$@")
if [ ${#ids[@]} -eq 0 ]; then
  mapfile -t ids < <(python3 -I - build/runs <<'EOF'
import json, os, sys
root = sys.argv[1]
for d in sorted(os.listdir(root)):
    try:
        r = json.load(open(os.path.join(root, d, "run.json")))
    except (OSError, ValueError):
        continue
    if r.get("starred") and r.get("status") == "done":
        print(d)
EOF
)
fi
[ ${#ids[@]} -gt 0 ] || { echo "no runs to publish: star some in the page, or name them" >&2; exit 1; }
for id in "${ids[@]}"; do
  [[ "$id" =~ ^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$ ]] || { echo "bad run id: $id" >&2; exit 1; }
  [ -f "build/runs/$id/products/meta.json" ] || { echo "no products: $id" >&2; exit 1; }
  mkdir -p "$OUT/samples/$id"
  cp -r "build/runs/$id/products" "$OUT/samples/$id/"
done
# the index: the run records without the machine's details
python3 -I - "$OUT/samples/index.json" "${ids[@]}" <<'EOF'
import json, sys
out, ids = sys.argv[1], sys.argv[2:]
keep = ("id", "created", "started", "ended", "status", "settings", "estimate", "actual", "derived", "cppwrf_commit", "level")
runs = []
for i in ids:
    r = json.load(open(f"build/runs/{i}/run.json"))
    runs.append({k: r[k] for k in keep if k in r})
json.dump(runs, open(out, "w"), ensure_ascii=False)
EOF
du -sh "$OUT" | sed 's/\t.*//; s/^/dist\/forecast: /'
echo "serve: python3 -m http.server -d dist 8000, then http://127.0.0.1:8000/forecast/"
