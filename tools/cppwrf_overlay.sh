#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# A copy of third_party/CPPWRF with the patches the native builds need (upstream-patches/REQUIRED), in
# build/cppwrf-src. The submodule itself is never changed; the copy is rebuilt when the submodule or a patch is newer.
#   0002-real-case-range-for-nvcc-12.4.patch: nvcc 12.4 cannot deduce a braced list in a range-for (CUDA builds)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=$ROOT/third_party/CPPWRF
OUT=$ROOT/build/cppwrf-src
STAMP=$OUT/.overlay
want="$(git -C "$SRC" rev-parse HEAD) $(cd "$ROOT/upstream-patches" && sha256sum $(cat REQUIRED) | sha256sum | cut -c1-16)"
if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$want" ]; then
  exit 0
fi
rm -rf "$OUT"
mkdir -p "$OUT"
git -C "$SRC" archive HEAD | tar -x -C "$OUT"
git -C "$SRC" rev-parse HEAD > "$OUT/src/cases/commit.txt"
for p in $(cat "$ROOT/upstream-patches/REQUIRED"); do
  patch -s -d "$OUT" -p1 < "$ROOT/upstream-patches/$p"
done
echo "$want" > "$STAMP"
echo "build/cppwrf-src: CPPWRF $(git -C "$SRC" describe --tags) + $(wc -l < "$ROOT/upstream-patches/REQUIRED") patch(es)"
