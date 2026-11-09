#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The end-to-end test of the forecast site (see tools/e2e.py): API, cancel, the three modes, GPU FP64 = CPU FP64
# byte for byte, FP32 against FP64, the page in headless Chrome. Starts the server if none answers on port 8090.
#   tools/e2e.sh [--case small|perf] [--skip-runs]
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
free_gb=$(df -BG --output=avail /home | tail -1 | tr -dc 0-9)
[ "$free_gb" -gt 16 ] || { echo "e2e: only $free_gb GB free on /home (at least 15 GB must stay free)" >&2; exit 1; }
[ -x build/forecast/ncdiff ] || tools/build_all.sh forecast
started=""
if ! curl -sf -o /dev/null http://127.0.0.1:8090/api/v1/system; then
  build/forecast/cppwrf-forecast --port 8090 > build/forecast/server-e2e.log 2>&1 &
  started=$!
  for _ in $(seq 50); do curl -sf -o /dev/null http://127.0.0.1:8090/api/v1/system && break; sleep 0.2; done
fi
status=0
python3 -I tools/e2e.py "$@" || status=$?
[ -n "$started" ] && kill "$started"
exit $status
