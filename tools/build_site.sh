#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Builds the wasm model (wasm/CMakeLists.txt) and assembles the static site in dist/:
#   index.html, app.js, worker.js, nchash.js, style.css, cppwrf_web.mjs + .wasm, cases/, expected/, NOTICE.md
# Needs emsdk on PATH (source emsdk_env.sh) and build/deps/netcdf-wasm (tools/build_netcdf_wasm.sh).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
[ -f build/deps/netcdf-wasm/lib/libnetcdf.a ] || tools/build_netcdf_wasm.sh
emcmake cmake -S wasm -B build/wasm -G Ninja -DNETCDF_WASM="$ROOT/build/deps/netcdf-wasm" > /dev/null
cmake --build build/wasm
if wasm-objdump -d build/wasm/cppwrf_web.wasm 2> /dev/null | grep -q "relaxed_n\?madd"; then
  echo "error: the wasm has relaxed-SIMD fused multiply-adds" >&2
  exit 1
fi
rm -rf dist
mkdir -p dist/cases dist/expected
cp web/index.html web/app.js web/worker.js web/nchash.js web/style.css NOTICE.md LICENSE dist/
cp build/wasm/cppwrf_web.mjs build/wasm/cppwrf_web.wasm dist/
cp -r cases/em_squall2d_x cases/em_quarter_ss dist/cases/
cp expected/*.json dist/expected/
echo "dist/ ready: python3 -m http.server -d dist 8000"
