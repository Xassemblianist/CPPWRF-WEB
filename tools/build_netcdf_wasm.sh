#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# NetCDF-C 4.9.3 for wasm32 (Emscripten): the classic formats only (no NetCDF-4 / HDF5, no DAP, no plugins), with
# Emscripten's zlib port. Installs into build/deps/netcdf-wasm. Needs emsdk on PATH (source emsdk_env.sh).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DEPS=$ROOT/build/deps
VER=4.9.3
SHA=990f46d49525d6ab5dc4249f8684c6deeaf54de6fec63a187e9fb382cc0ffdff
mkdir -p "$DEPS" && cd "$DEPS"
if [ ! -d netcdf-c-$VER ]; then
  curl -fsSL -o netcdf-c-$VER.tar.gz https://github.com/Unidata/netcdf-c/archive/refs/tags/v$VER.tar.gz
  echo "$SHA  netcdf-c-$VER.tar.gz" | sha256sum -c -
  tar xzf netcdf-c-$VER.tar.gz
fi
embuilder build zlib > /dev/null
SR=$(em-config CACHE)/sysroot
emcmake cmake -S netcdf-c-$VER -B netcdf-build -G Ninja -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_INSTALL_PREFIX="$DEPS/netcdf-wasm" -DBUILD_SHARED_LIBS=OFF -DCMAKE_C_FLAGS="-O2 -ffp-contract=off" \
  -DNETCDF_ENABLE_NETCDF_4=OFF -DNETCDF_ENABLE_HDF5=OFF -DNETCDF_ENABLE_DAP=OFF -DNETCDF_ENABLE_BYTERANGE=OFF \
  -DNETCDF_ENABLE_NCZARR=OFF -DNETCDF_ENABLE_PLUGINS=OFF -DNETCDF_ENABLE_FILTER_TESTING=OFF \
  -DNETCDF_BUILD_UTILITIES=OFF -DNETCDF_ENABLE_TESTS=OFF -DNETCDF_ENABLE_EXAMPLES=OFF -DNETCDF_ENABLE_LIBXML2=OFF \
  -DNETCDF_ENABLE_PARALLEL4=OFF -DNETCDF_ENABLE_MMAP=OFF -DNETCDF_ENABLE_DOXYGEN=OFF -DNETCDF_ENABLE_LOGGING=OFF \
  -DNETCDF_ENABLE_S3=OFF -DZLIB_LIBRARY="$SR/lib/wasm32-emscripten/libz.a" -DZLIB_INCLUDE_DIR="$SR/include"
cmake --build netcdf-build
cmake --install netcdf-build
