# The forecast site (WEB2)

A Turkish weather-forecast site that runs real-data CPPWRF forecasts on this machine and shows them on a WebGL2
map. The page also runs on GitHub Pages: with the local server running it starts forecasts there, without it it
shows published sample forecasts. The user guide in Turkish is [KULLANIM.md](KULLANIM.md).

```
GFS 0.25° (NOMADS, the region only) → WPS 4.6.0 (geogrid, ungrib, metgrid) → cppwrf_real
  → cppwrf (GPU FP32, GPU FP64 or CPU FP64) → wrfout → wrfpost (while the model runs) → the page
```

The server listens on 127.0.0.1 only and has no login.

## Parts

| Path | What |
|---|---|
| `forecast/prepare.py` | the settings schema, derived values, WPS and WRF namelists, the translator check, the estimate |
| `forecast/pipeline.sh` | one forecast in `build/runs/<id>/`: download, WPS, real, model, post; writes `state` and `times` |
| `forecast/server/server.cpp` | the HTTP server: `/api/v1`, the run queue, Server-Sent Events, the page's files |
| `forecast/server/wrfpost.cpp`, `postcore.hpp` | wrfout → map products, while the model writes |
| `forecast/web/` | the page: `index.html`, `help.html`, `css/`, `js/` (ES modules), `i18n/`, `data/` (map data) |
| `tools/build_all.sh` | the CPPWRF builds (CPU FP64, GPU FP32, GPU FP64) and the server |
| `tools/calibrate.sh`, `calibrate.py` | measures the stages on this machine into `build/calibration.json` |
| `tools/e2e.sh`, `e2e.py`, `ncdiff.cpp` | the end-to-end test |
| `tools/build_forecast_site.sh` | `dist/forecast/` for GitHub Pages, with sample forecasts |
| `tools/natural_earth.py` | Natural Earth GeoJSON → `forecast/web/data/ne/*.bin` |
| `tests/post_tests.cpp` | unit tests of wrfpost's column diagnostics |

## Build

CPPWRF comes from the submodule `third_party/CPPWRF` (pinned at 36b9b63), built outside it:

```bash
tools/build_all.sh            # build/cpu-fp64, build/gpu-fp32, build/gpu-fp64, build/forecast
tools/build_all.sh forecast   # the server, wrfpost, post_tests and ncdiff only
```

One build at a time (a lock file), `nice -n 10`, at most `-j6`, the GPU's compute capability from nvidia-smi, and
no floating-point flag of our own: CPPWRF's CMake sets `-ffp-contract=off`, and `--fmad=false` with glibc's math in
the FP64 CUDA kernels. Each build writes a `.commit` stamp; the server reports the commit as "CPPWRF 36b9b63".

WPS 4.6.0, its geography and WRF's physics tables are not built here. The pipeline links them read-only from
`WPS_DIR`, `GEOG_DIR` and `WRF_RUN_DIR`. Every program runs in `build/runs/<id>/`.

## Run

```bash
build/forecast/cppwrf-forecast --port 8090
tools/calibrate.sh             # once: about 10 minutes, makes the estimates this machine's own
```

Open `http://127.0.0.1:8090/`. Environment: `CPPWRF_KEEP_RUNS` (runs kept, default 12; starred runs are never
deleted), `CPPWRF_ALLOWED_ORIGINS` (default `https://xassemblianist.github.io`), `CPPWRF_WEB_ROOT` (the repository).

## The three modes

| Mode | Build | What it is for |
|---|---|---|
| GPU FP32 | `build/gpu-fp32` | speed; differs from FP64 by rounding (relative L2 about 1e-4 … 1e-2 after a day) |
| GPU FP64 | `build/gpu-fp64` | "WRF ile birebir": the wrfout files equal the CPU FP64 build byte for byte |
| CPU FP64 | `build/cpu-fp64` | fallback without a GPU; 6 OpenMP threads; bit-identical to WRF real*8 |

The identity is checked by `tools/e2e.sh` on every wrfout of a run (`cmp`).

## Settings

There are no fixed caps: a run is allowed when it fits this machine. The schema (`prepare.py normalise`):

| Setting | Range | Notes |
|---|---|---|
| centre | any latitude −89…89, longitude | |
| dx | 1–50 km | |
| nx, ny | 20–1000 | |
| levels | 30–100 | WRF's `auto_levels_opt = 2` (ported exactly), dzbot 50 m, stretch 1.3 / 1.1, max Δz 1000 m |
| model top | 10–200 hPa | |
| projection | auto, Lambert, Mercator, polar | auto: Mercator within 20° of the equator, polar above 65°, else Lambert |
| cycle | latest complete, or one of the last 8 days | "complete": its f384 index exists on NOMADS |
| length | 1–384 h | GFS input hourly up to 120 h, 3-hourly beyond |
| output | 10–360 min | |
| time step | 1–600 s | default 6·dx (km), lowered to a divisor of the output interval; CFL warning |
| adaptive step | on / off | single domain only |
| nest | ratio 1:3 or 1:5, one- or two-way | at least 5 parent cells from the edges; Noah-MP with nests is refused |
| physics | a preset and any option | the options and their values come from the submodule's translator |

Every run is written as WRF's `namelist.input` and translated by CPPWRF's own `tools/wrf2cppwrf.py`. Its `[ERROR]`
lines are mapped to the setting they are about and shown under that control in Turkish.

## Estimates

`prepare.py estimate` predicts each stage, GPU memory, RAM, disk and the GFS download from
`build/calibration.json` (written by `tools/calibrate.sh`, then refined after every finished run by a log-space
moving average with weight 0.3; history in `build/calibration_history.json`). The model time is
steps × (cells × s/cell/step) + radiation calls × (cells × s/cell), per mode. GPU memory is a + b·cells +
c·(boundary points × input times), because every wrfbdy time is kept on the device; after each run the three
coefficients are fitted again by least squares to the finished runs on disk. A 10 % margin is added.

| Level | When | The page |
|---|---|---|
| green | it fits | runs |
| yellow | longer than 30 min, or above 70 % of GPU memory | asks "Uzun sürecek, devam etmek istiyor musun?" |
| red | does not fit (GPU memory, RAM, disk floor, translator) | refuses, with the cheapest change that fits |

## API (`/api/v1`)

| Method | Path | |
|---|---|---|
| GET | `/system` | GPU, memory, disk, builds and their commits, queue |
| GET | `/options` | presets, controls, modes |
| GET | `/cycles` | GFS cycles |
| POST | `/estimate` | the check and the estimate of settings |
| GET, POST | `/runs` | the runs; start one (422 with field errors) |
| GET, DELETE | `/runs/<id>` | one run; delete it (stops it first) |
| POST | `/runs/<id>/cancel`, `/runs/<id>/star` | |
| GET | `/runs/<id>/events` | Server-Sent Events: stage, percent, simulated time, rate, remaining, frames ready, log tail |
| GET | `/runs/<id>/logs/<stage>`, `/runs/<id>/files`, `/runs/<id>/out/<wrfout>` | |
| GET | `/runs/<id>/products/[d0N/][f\|n\|s/]<file>` | products, with single byte ranges (206) |
| GET | `/basemap` | WPS's 5′ water fraction and height |

Security: JSON schema checks with unknown keys refused; file paths built only from checked run ids and names;
programs started with `execvp` and argument arrays; requests above 64 KB refused; only `forecast/web` and
`build/runs` are served. Cross-origin requests are allowed for the Pages origin only (with Private Network Access);
other origins' POST and DELETE get 403.

Cancel sends SIGTERM to the run's process group, then SIGKILL after 10 s. At start-up the server stops pipelines
left from a previous server and marks their runs failed. Partial files of failed or cancelled runs are deleted
unless the run asked to keep them. Old runs are deleted beyond `CPPWRF_KEEP_RUNS`, never starred ones, and the disk
is checked against the 15 GB floor before every download, build and run.

## Failures (shown in Turkish)

| Failure | Message (start) |
|---|---|
| GFS hour not on NOMADS | "GFS … çevriminin N. saati NOMADS'ta yok (henüz yayımlanmadı ya da arşivden kalktı). Daha eski bir çevrim seçin." |
| download failing 3 times (5, 15, 45 s back-off) | "GFS indirilemedi (ağ hatası, 3 deneme) …" |
| translator refusal | before the run: the translator's message under the setting; in the run: "Çevirici seçenekleri kabul etmedi …" |
| CFL violation, non-finite values | "Model kararsızlaştı (sayısal patlama, CFL). Daha küçük bir zaman adımı ya da w_damping = 1 deneyin." |
| GPU out of memory | "GPU belleği yetmedi. Alanı küçültün, dx'i büyütün ya da GPU FP32 kipini seçin." |
| disk below the floor, disk full | "Diskte 15 GB'tan az boş yer kaldı; eski çalışmaları silin." / "Disk doldu. …" |
| a program missing | "Eksik program: … (tools/build_all.sh)" |
| any stage's program failing | the stage and the last error lines of its log |

## Products (`build/runs/<id>/products/`, written by `wrfpost`)

Per domain (`d02/`, `d03/` for nests) and frame, on a regular latitude-longitude grid of about the model's spacing
(bilinear from the model grid by inverting the model's map projection; NaN outside the domain):

- `meta.json`: grid, model projection, times, the frames ready, fields with units and ranges, methods.
- `f/NNN.f32`: every field, plane after plane (the page reads one plane with one Range request).
- `n/NNN.f32`: the surface fields at every model grid point, point after point (exact values for the point card).
- `s/NNN.f32`: soundings: T, Td, u, v, z at 21 pressure levels, point after point.
- `ts.f32`: the time series of 15 surface fields per point, written at the end (meteogram).
- `static.f32` (terrain height, land mask), `native.f32` (the model grid's latitude and longitude).

Fields: wind (10 m and the six levels), gusts, temperature, dew point and RH (2 m and the levels), geopotential
height, MSLP, surface pressure, precipitation rate and accumulation (total, rain, snow, graupel, convective,
grid-scale), cloud cover (low, mid, high, total), radar reflectivity (when the microphysics gives it), SB and MU
CAPE and CIN, lifted index, 0–6 km shear, snow depth, soil moisture, skin temperature, SST, freezing level, PBL
height. The methods:

| Product | Method |
|---|---|
| pressure levels | linear in ln p between mass levels (as NCEP UPP); NaN below the ground |
| MSLP | wrf-python `slp` (NCL DCOMPUTESEAPRS) |
| dew point | Bolton (1980) |
| CAPE / CIN | pseudoadiabatic parcel with the virtual-temperature correction; SB: 2 m parcel; MU: highest θe in the lowest 300 hPa; first LFC |
| lifted index | environment minus SB parcel at 500 hPa |
| gusts | UPP CALGUST |
| clouds | maximum CLDFRA per band (low > 680 hPa, mid 680–440, high < 440 hPa); total: random overlap |

`build/forecast/post_tests` checks these against closed forms (`tests/post_tests.cpp`).

## The page

Plain ES modules and WebGL2, nothing vendored, nothing from a CDN. Natural Earth (public domain) at 1:110m, 1:50m
and 1:10m and a hill shading from WPS's 5′ height are in `forecast/web/data/`. Without WebGL2 the same map is drawn
on a 2-D canvas. Details and keyboard use: [KULLANIM.md](KULLANIM.md) and the page's help.

## GitHub Pages

```bash
tools/build_forecast_site.sh [RUN_ID ...]     # dist/forecast/; default: the starred runs that are done
```

The owner publishes `dist/forecast/` on the gh-pages branch. Opened from Pages, the page asks
`http://127.0.0.1:8090/api/v1/system`; if the visitor's server answers it is used, else the samples are shown.

## Tests

```bash
build/forecast/post_tests            # wrfpost's diagnostics
tools/e2e.sh                         # API, cancel, three modes, FP64 identity, FP32 accuracy, the page (small case)
tools/e2e.sh --case perf             # the same on 100 × 100 × 45, 9 km, 24 h
```
