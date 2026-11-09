# Patches for CPPWRF

The web build needs **no change to CPPWRF**: `third_party/CPPWRF` is the v1.0.0 tag as it is, and
`wasm/CMakeLists.txt` builds its sources with the definitions of its own CPU FP64 build plus `CPPWRF_GLIBC_MATH=1`.
There is no overlay. What made that possible is already in CPPWRF:

- the double math functions go through `cppwrf::libm` and `cppwrf::vm` (src/core/libm.hpp, backend.hpp), and
  `CPPWRF_GLIBC_MATH` switches both to CPPWRF's port of glibc 2.41's libm and libmvec, which the CUDA FP64 build
  uses; the macro is not tied to CUDA;
- the x86-64 parts (libmvec's SSE2 entry points, `<emmintrin.h>`) are behind `__x86_64__`;
- `<omp.h>` and the `omp_*` calls are behind `_OPENMP`; the threads of the tiled runs and of the NetCDF-4 compression
  are not started in a single-domain run with NetCDF classic output.

Patch 0001 is a suggestion, not a requirement of the web build. Patch 0002 is needed by the CUDA build of the local
forecast only.

## 0001-cmake-cpu-glibc-math-option.patch

A CMake option `CPPWRF_CPU_GLIBC_MATH` for CPU FP64 builds: ON defines `CPPWRF_GLIBC_MATH` and drops `-lmvec`.
It defaults to ON where the C library is not glibc on x86-64 (macOS, musl, Windows, WebAssembly), whose libm gives
other bits than the glibc of WRF's gfortran build. Today such a build compiles, runs and differs from WRF in the
last bits; with the option it would be bit-identical as the wasm build is.

Checked: applies to v1.0.0 (`git apply --check`); on a copy of the sources (not the submodule), a native build with
`-DCPPWRF_CPU_GLIBC_MATH=ON` on glibc gives em_squall2d_x's wrfout with every hash equal to the default build's
(docs/WEB1_report.md). Not built on macOS or musl.

## 0002-real-case-range-for-nvcc-12.4.patch

**Required for the CUDA build** of the local forecast (listed in `REQUIRED`). nvcc 12.4 stops at the two range-for
loops over braced lists of pairs in `src/cases/real_case.cpp` ("cannot deduce type of range"). The patch spells the
list type, `std::initializer_list<std::pair<const char*, const char*>>`, and includes `<initializer_list>`. It does
not change what the code does. `tools/cppwrf_overlay.sh` applies it to a copy in `build/cppwrf-src`; the
submodule stays as it is. The CPU builds do not need it.
