#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# The CPPWRF builds the local forecast needs, from the submodule third_party/CPPWRF, into build/:
#   build/cpu-fp64   CPU FP64 (OpenMP): cppwrf and cppwrf_real (bit-identical to WRF real*8)
#   build/gpu-fp32   CUDA FP32: cppwrf (the fast mode)
#   build/gpu-fp64   CUDA FP64: cppwrf (bit-identical to WRF real*8 and to the CPU FP64 build)
#   build/forecast   the forecast server and wrfpost
# Only what is missing or older than the submodule commit is built; one build at a time, nice -n 10, at most -j6.
# No floating-point flag is passed: CPPWRF's CMake sets what the identity needs (-ffp-contract=off, --fmad=false in
# FP64 kernels) and refuses fast-math flags.
#
#   tools/build_all.sh [cpu-fp64|gpu-fp32|gpu-fp64|forecast ...]   (default: all)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC=$ROOT/third_party/CPPWRF
JOBS=${JOBS:-6}
[ "$JOBS" -le 6 ] || JOBS=6
MIN_FREE_GB=${MIN_FREE_GB:-15}
COMMIT=$(git -C "$SRC" rev-parse --short=7 HEAD)

free_gb() { df -BG --output=avail "$ROOT" | tail -1 | tr -dc 0-9; }
check_disk() {
  [ "$(free_gb)" -gt $((MIN_FREE_GB + 1)) ] || { echo "build_all: less than $((MIN_FREE_GB + 1)) GB free; not building" >&2; exit 1; }
}

# the GPU's compute capability (7.5 -> 75), from nvidia-smi
cuda_arch() {
  local cc
  cc=$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader 2>/dev/null | head -1 | tr -dc 0-9)
  [ -n "$cc" ] || { echo "build_all: no NVIDIA GPU found (nvidia-smi)" >&2; return 1; }
  echo "$cc"
}

# one build at a time, also across shells
exec 9> "$ROOT/build/.build.lock"
flock -n 9 || { echo "build_all: another build is running" >&2; exit 1; }

build() {  # name, source, then the CMake options
  local name=$1 src=$2; shift 2
  local dir=$ROOT/build/$name
  if [ -f "$dir/.commit" ] && [ "$(cat "$dir/.commit")" = "$COMMIT" ]; then
    echo "build_all: $name is up to date ($COMMIT)"
    return
  fi
  check_disk
  echo "build_all: $name ($COMMIT) ..."
  local t0=$SECONDS
  cmake -S "$src" -B "$dir" -G Ninja -DCMAKE_BUILD_TYPE=Release "$@" > "$ROOT/build/$name.configure.log" 2>&1 ||
    { tail -20 "$ROOT/build/$name.configure.log" >&2; exit 1; }
  nice -n 10 cmake --build "$dir" -j "$JOBS" > "$ROOT/build/$name.build.log" 2>&1 ||
    { tail -30 "$ROOT/build/$name.build.log" >&2; exit 1; }
  echo "$COMMIT" > "$dir/.commit"
  echo "build_all: $name done in $((SECONDS - t0)) s"
}

mkdir -p "$ROOT/build"
targets=("$@")
[ ${#targets[@]} -gt 0 ] || targets=(cpu-fp64 gpu-fp32 gpu-fp64 forecast)
for t in "${targets[@]}"; do
  case $t in
    cpu-fp64) build cpu-fp64 "$SRC" -DCPPWRF_ENABLE_CUDA=OFF -DCPPWRF_DOUBLE=ON ;;
    gpu-fp32) build gpu-fp32 "$SRC" -DCPPWRF_ENABLE_CUDA=ON -DCPPWRF_DOUBLE=OFF -DCMAKE_CUDA_ARCHITECTURES="$(cuda_arch)" ;;
    gpu-fp64) build gpu-fp64 "$SRC" -DCPPWRF_ENABLE_CUDA=ON -DCPPWRF_DOUBLE=ON -DCMAKE_CUDA_ARCHITECTURES="$(cuda_arch)" ;;
    forecast)
      check_disk
      cmake -S "$ROOT/forecast" -B "$ROOT/build/forecast" -G Ninja -DCMAKE_BUILD_TYPE=Release > /dev/null
      nice -n 10 cmake --build "$ROOT/build/forecast" -j "$JOBS" ;;
    *) echo "build_all: unknown build $t" >&2; exit 1 ;;
  esac
done
