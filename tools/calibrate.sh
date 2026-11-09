#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Measure this machine for the forecast's cost estimate (build/calibration.json): two small real-data cases through
# the whole pipeline, then the model alone in the three modes. About 6-8 minutes; needs the GPU free and 17 GB free.
#   tools/calibrate.sh [--cycle YYYYMMDDHH]      (default: the latest complete cycle from the running server)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
exec nice -n 10 python3 -I "$ROOT/tools/calibrate.py" run "$@"
