# CPPWRF-Web

WRF-ARW v4.8.0 in a web browser. The page runs [CPPWRF](https://github.com/Xassemblianist/CPPWRF), the C++20 port
of WRF, compiled to WebAssembly in double precision. Two of WRF's idealized cases run in it:

- `em_squall2d_x`, the 2-D squall line;
- `em_quarter_ss`, the 3-D supercell.

While the model runs, the page shows x–z sections of θ′, w and rain water. At the end it hashes every variable
and output time of the `wrfout` file it wrote and compares them with the native CPU FP64 build of CPPWRF, which is
bit-identical to WRF real*8.

**Result: the wasm build is bit-identical to the native build.** All hashes match, and the wrfout file is the
same byte for byte. This holds under node and in Chromium, for both cases ([docs/WEB1_report.md](docs/WEB1_report.md)).

**Live page:** <https://xassemblianist.github.io/CPPWRF-WEB/>

## How bit identity survives the trip to wasm

1. **No FMA contraction, no fast-math.** The build uses `-ffp-contract=off` and refuses fast-math flags. The
   output wasm is checked for relaxed-SIMD `f64x2.relaxed_madd`, and it contains none: it has no SIMD at all.
2. **The math library.** Native CPPWRF calls glibc's libm and libmvec, as WRF's gfortran build does. Emscripten's
   musl libm gives other bits for exp, log, pow, sin, cos and atan2 (`tests/math_bits.cpp`). The wasm build
   defines `CPPWRF_GLIBC_MATH`, which switches every double math call to CPPWRF's own port of glibc 2.41. That port
   already existed for the CUDA FP64 build. On 10⁶ arguments per function, all 17 checks (scalar libm and
   libmvec lanes) give the same bits in wasm as glibc natively.
3. **The same order of operations.** It comes from the same sources. CPPWRF needed no change: `third_party/CPPWRF`
   is the v1.0.0 tag as it is ([upstream-patches/](upstream-patches/)).
4. **The same writer.** wrfout goes through CPPWRF's own writer and NetCDF-C 4.9.3 in both builds. The wasm build
   has the classic formats only, so the case namelists set `use_netcdf_classic = .true.`.

## Build

You need:

- emsdk 7.0.0 (`emcc 7.0.0`) for the web build;
- CMake ≥ 3.24, Ninja and Python 3 for the build and the hash tool;
- node ≥ 20 for the headless check;
- for the native reference: g++, OpenMP and NetCDF-C.

```bash
git clone --recursive https://github.com/Xassemblianist/CPPWRF-WEB.git && cd CPPWRF-WEB
git clone https://github.com/emscripten-core/emsdk.git ~/emsdk
~/emsdk/emsdk install 7.0.0 && ~/emsdk/emsdk activate 7.0.0 && source ~/emsdk/emsdk_env.sh
tools/build_site.sh          # NetCDF-C for wasm (first time), the model, then dist/
```

`tools/build_site.sh` calls `tools/build_netcdf_wasm.sh` when `build/deps/netcdf-wasm` is missing. That script
builds NetCDF-C 4.9.3 from Unidata's release tarball, checked by its SHA-256.

## Run locally

```bash
python3 -m http.server -d dist 8000
```

Then open <http://localhost:8000/>. Add `?case=em_quarter_ss` to start on the supercell, or `?autorun` to start
the run at once. The site is static files only, so GitHub Pages or Cloudflare Pages can serve `dist/` as it is.
The WEB1 build is single-threaded, so it needs no special headers.

Headless, with the same calls as the page's worker:

```bash
node tests/run_node.mjs build/wasm/cppwrf_web.mjs cases/em_squall2d_x out
python3 tools/nc_hashes.py --check expected/em_squall2d_x.json out/wrfout_d01_0001-01-01_00:00:00
```

## Proof

| | em_squall2d_x | em_quarter_ss |
|---|---|---|
| Grid, steps | 201 × 1 × 80, Δt 3 s, 1200 steps | 41 × 41 × 40, Δt 12 s, 300 steps |
| Hashes compared | 1134 (162 variables × 7 times) | 486 (162 variables × 3 times) |
| node (wasm) vs native | all equal, file byte-identical | all equal, file byte-identical |
| Chromium 152 (wasm) vs native | all equal, file byte-identical | all equal, file byte-identical |

The wall times and memory are in [docs/WEB1_report.md](docs/WEB1_report.md). `expected/*.json` was made once
from the native build with `tools/nc_hashes.py`. The page computes the same hashes in JS (`web/nchash.js`).

## Layout

| Path | What |
|---|---|
| `third_party/CPPWRF` | CPPWRF v1.0.0 (submodule, unmodified) |
| `wasm/` | the Emscripten build (`CMakeLists.txt`) and the calls the page makes (`cppwrf_web.cpp`) |
| `web/` | the page (`index.html`, `app.js`, `style.css`), the model's worker (`worker.js`), the hash check (`nchash.js`) |
| `cases/` | WRF v4.8.0's `input_sounding` and `namelist.input` of each case, and the CPPWRF configuration |
| `expected/` | the native build's SHA-256 per variable and output time |
| `tests/` | the math check (`math_bits.cpp`) and the headless node run (`run_node.mjs`) |
| `tools/` | the builds of NetCDF-C and of the site, and the hash tool (`nc_hashes.py`) |
| `upstream-patches/` | suggested changes to CPPWRF (none is needed) |

## Limits

- **Single-threaded.** A run takes about as long as one native core. The squall line runs about 1.4× slower in
  wasm than natively on one core.
- **wasm32.** Memory is limited to 4 GB (`ALLOW_MEMORY_GROWTH`). The two cases need 69 MB and about 210 MB.
- **Idealized cases only.** No real-data input, nests, radiation or land surface in the page yet. They are in
  the wasm module, but no case uses them.
- **NetCDF classic output only.** The wasm NetCDF-C has no HDF5.
- **Display sections only.** The sections the page shows are a display copy; only wrfout is checked.

## Roadmap

1. **Threads.** An OpenMP-in-wasm or pthreads build. It needs `SharedArrayBuffer`, and so the COOP/COEP headers.
   GitHub Pages and other static hosts cannot set them, so the page would register
   [coi-serviceworker](https://github.com/gzuidhof/coi-serviceworker), which adds the headers from a service
   worker after one reload. The page already talks to the model only through `worker.js` messages, so a threaded
   module can replace it behind the same messages.
2. **em_quarter_ss in more detail.** A horizontal section and an x–z row that follows the storm. Today the row is
   fixed through the middle of the domain, and the storm leaves it in the second half hour.
3. **A small real-data case** from a pre-made wrfinput/wrfbdy pair, loaded into MEMFS.
4. **Maybe a WebGPU path, FP32 only.** WGSL has no f64, so a GPU path in the browser could only be CPPWRF's FP32
   mode, compared with WRF by relative error and not bit for bit.

## Licence

GPL-3.0-or-later, as CPPWRF: [LICENSE](LICENSE), [NOTICE.md](NOTICE.md) (with the WRF notice that UCAR requests).
WRF was developed at NCAR, which is operated by UCAR. CPPWRF and CPPWRF-Web are independent projects, not
affiliated with or endorsed by NCAR or UCAR.
