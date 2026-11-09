# WEB1 report

Milestone WEB1: CPPWRF runs in a web browser through WebAssembly, in FP64, and its wrfout is bit-identical to
the native CPU FP64 build of CPPWRF, which is bit-identical to WRF v4.8.0 real*8.

## What works

- **em_squall2d_x** (WRF's 2-D squall line, 1 h):
  - runs in the browser, in a module worker;
  - the page shows θ′, w and rain water as x–z sections while it runs and replays them afterwards;
  - wrfout is checked on the page against the native hashes and can be downloaded.
- **em_quarter_ss** (WRF's 3-D supercell, 1 h): the same. The sections go through the middle row, y = 41 km.
- **Headless:** both cases under node, through the same calls as the page (`tests/run_node.mjs`).
- **Math:** the math check `tests/math_bits.cpp` passes.

Both cases use WRF v4.8.0's own `test/<case>/input_sounding` and `namelist.input`. Their CPPWRF configuration
comes from CPPWRF's translator (`tools/wrf2cppwrf.py --format wrfout`). The namelists differ from WRF's in two
places only:

- `use_netcdf_classic = .true.` in both;
- `mp_physics = 1` (Kessler) for the squall line. WRF's own namelist has 2 (Lin), which CPPWRF does not port.
  CPPWRF's suite runs the squall line with Kessler too.

## Proof

### 1. Native reference

CPPWRF v1.0.0 (commit e8491499) was built with CPPWRF's own CMake:

```
-DCMAKE_BUILD_TYPE=Release -DCPPWRF_ENABLE_CUDA=OFF -DCPPWRF_DOUBLE=ON
```

That gives g++ 14.2 with `-O3 -march=native -ffp-contract=off`, glibc 2.41 (libm and libmvec) and NetCDF-C 4.9.3
(Debian 13). One detail: `CPPWRF_DOUBLE` is OFF by default, so "CPU FP64" means the defaults plus
`CPPWRF_DOUBLE=ON`, as CPPWRF's README builds it.

`tools/nc_hashes.py` hashes every variable and output time of the wrfout file. It has its own NetCDF classic
parser, and on the reference file it agrees with the netCDF4 library on all 1134 hashes. The results are in
`expected/em_squall2d_x.json` and `expected/em_quarter_ss.json`.

The native squall run gives the same wrfout file, byte for byte, with 12 OpenMP threads and with 1.

### 2. Math check

`tests/math_bits.cpp` evaluates 17 functions on 10⁶ arguments each and hashes the result bits. The arguments mix
wide ranges with the ranges the kernels see. The functions are called through CPPWRF's own entry points:

- scalar `cppwrf::libm`: exp, log, log10, pow, sin, cos, atan, atan2, tanh, sqrt;
- `cppwrf::vm` libmvec lanes: exp, log, log10, pow, sin, cos, atan.

| Build | Result |
|---|---|
| native (glibc libm + libmvec) | reference |
| wasm with `CPPWRF_GLIBC_MATH` (CPPWRF's port), under node | **all 17 equal** |
| wasm with Emscripten's own libm (musl) | 16 of 17 differ (only sqrt equal) |

So Emscripten's math library would break bit identity, and CPPWRF's port fixes it.

### 3. Headless wasm run under node

| | em_squall2d_x | em_quarter_ss |
|---|---|---|
| Hashes | 1134 (162 variables × 7 times): **all equal** | 486 (162 variables × 3 times): **all equal** |
| wrfout file | **byte-identical** | **byte-identical** |
| Other outputs | wrfrst and CPPWRF's restart file byte-identical | restart file byte-identical |

The wasm build writes wrfout with the same CPPWRF writer and the same NetCDF-C version (4.9.3) as the native
build, so the files can be compared byte for byte, and they are equal.

### 4. Browser run

The page ran in the desktop app's built-in browser pane (Chromium 152, Linux x86-64), served by
`python3 -m http.server`. It checked the file itself in JS (`web/nchash.js`, SHA-256 with `crypto.subtle`):

| | em_squall2d_x | em_quarter_ss |
|---|---|---|
| Result | 1134 / 1134 equal, file byte-identical | 486 / 486 equal, file byte-identical |

The JS hasher gives the same hashes as the Python tool on the same file. The browser check was not repeated in
Firefox or Safari, and playwright is not installed here.

### 5. The wasm itself

- No SIMD instructions at all, and so no `f64x2.relaxed_madd` / `f32x4.relaxed_madd`. `tools/build_site.sh`
  fails if relaxed fused multiply-adds ever appear.
- `-ffp-contract=off`, no fast-math. The CMake file refuses the flags that change results, as CPPWRF's does.

## Numbers

Machine: 12 hardware threads, 15 GB RAM, Linux 6.12, Debian 13. Other programs were running on it at the same
time, so the times can be off by 10–20 %.

| | em_squall2d_x | em_quarter_ss |
|---|---|---|
| Native, 12 OpenMP threads: stepping / wall | 66.4 s / 67.1 s | – |
| Native, 1 thread: stepping / wall | 73.9 s / 74.2 s | 103.0 s / 103.3 s |
| node 22 (wasm): stepping / wall | 104.0 s / 105.4 s | 146.2 s / 146.7 s |
| Chromium 152 (wasm): stepping / whole run | 106.3 s / 106.6 s | 173.8 s / 174.5 s ¹ |
| Native peak RSS | 82 MB | 219 MB |
| wasm heap peak | 69 MB | 207 MB |
| node process peak RSS | 345 MB | 404 MB |
| wrfout size | 27.4 MB (7 frames) | 25.8 MB (3 frames) |
| wasm module | 5.1 MB (`cppwrf_web.wasm`), 67 kB JS | |

¹ This run shared the machine with a node run and a compilation, so it is slower than it would be alone.

wasm runs both cases at about 1.4× the native single-thread time. The squall line steps at about
34× real time in the browser.

## How the build is made

`wasm/CMakeLists.txt` compiles CPPWRF's sources directly from the submodule, with the source list and the
definitions of CPPWRF's own CPU FP64 build. It has five differences from that build:

1. **`CPPWRF_GLIBC_MATH=1`.** Every double math call goes through CPPWRF's port of glibc 2.41 (src/core/glibc_math.hpp,
   libmvec_x86.hpp): the scalar libm and the libmvec lanes that WRF's vectorised loops use.
2. **No OpenMP** (one thread) and **no `-lmvec`.** The `omp_*` calls are behind `_OPENMP` and the libmvec entry
   points are behind `__x86_64__` in CPPWRF already.
3. **NetCDF-C 4.9.3 for wasm32** (`tools/build_netcdf_wasm.sh`): classic formats, no HDF5. The wasm version has
   no NetCDF-4 output.
4. **`-fwasm-exceptions`, an 8 MB stack** (the native default), `ALLOW_MEMORY_GROWTH` up to 4 GB, and the WRF I/O
   schema (`data/wrf_schema`) embedded at `/cppwrf/data`.
5. **`wasm/cppwrf_web.cpp`** replaces `src/main.cpp`. It is the same time loop for one domain (`before_step`, the
   RK3 step, `after_step`), split into calls the worker makes: `web_init`, `web_step(n)`, `web_field`, `web_finish`.
   `web_field` copies x–z sections for display: θ′ as CPPWRF's own `max_th_pert` diagnostic defines it, w, rain
   water, and the height of the levels. It only reads the model's fields.

## upstream-patches/

**None is needed.** The submodule is the v1.0.0 tag unmodified, and there is no overlay.

`0001-cmake-cpu-glibc-math-option.patch` is a suggestion. It adds a CMake option `CPPWRF_CPU_GLIBC_MATH`, ON by
default where the C library is not glibc on x86-64. It would let a native CPU build on macOS, musl or Windows be
bit-identical to WRF the way the wasm build is. Checks:

- it applies to v1.0.0;
- on a copy of the sources, a native build with the option ON gave em_squall2d_x's wrfout with all 1134 hashes
  equal to the reference, and the same file byte for byte;
- it was not built on a non-glibc system.

## Open problems

- **Speed.** One thread, about 1.4× slower than one native core. Threads are the next step (README roadmap). They
  need SharedArrayBuffer, so COOP/COEP headers, and coi-serviceworker on static hosting.
- **The 3-D section.** The page shows a fixed row through the domain. The supercell moves out of that row in the
  second half hour, so the page needs a horizontal section or a row that follows the storm.
- **Other browsers.** Only Chromium was run. Firefox and Safari should give the same bits: wasm f64 arithmetic is
  IEEE and deterministic, and the build has no relaxed SIMD and no NaN-payload-dependent code on the checked path.
  But that is not shown.
- **`__builtin_constant_p`.** CPPWRF's libm wrapper folds math calls with constant arguments at compile time (gcc
  behaviour). clang folds them with the compiler host's libm. Both cases were equal, but a different Emscripten
  host could in principle fold a constant differently. It would show up as a hash mismatch.
- **Display memory.** The page keeps every frame for replay as Float32 (about 25 MB for the squall line).
