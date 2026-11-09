# Local forecast

A small page on this machine (`http://127.0.0.1:8090/`) that runs a real-data CPPWRF forecast for a region you
pick on the map and shows it as wind particles and colour layers over time.

```
GFS 0.25° (NOMADS, the region only) → WPS 4.6.0 (geogrid, ungrib, metgrid) → cppwrf_real → cppwrf (GPU FP32 or CPU FP64)
  → wrfout → wrfpost (lat/lon grid, float32) → the page
```

Everything runs locally. The server listens on 127.0.0.1 only and has no login.

## Parts

| Path | What |
|---|---|
| `forecast/pipeline.sh` | one forecast in `build/runs/<id>/`: download, WPS, real, model, post; writes `state` |
| `forecast/server/server.cpp` | the HTTP server: checks, estimates, starts and cancels runs, serves products and the page |
| `forecast/server/wrfpost.cpp` | wrfout → `meta.json`, `static.bin` and one `frame_NNN.bin` per output time |
| `forecast/web/` | the page (`index.html`, `app.js`, `style.css`): plain HTML, CSS and JS, no library |
| `tools/cppwrf_overlay.sh` | copies the CPPWRF submodule to `build/cppwrf-src` and applies `upstream-patches/REQUIRED` |

## Build

CPPWRF is never built inside the submodule. The CUDA build needs patch 0002 (nvcc 12.4 cannot deduce the type of
a braced list in a range-for loop in `real_case.cpp`), so it is built from an overlay copy:

```bash
tools/cppwrf_overlay.sh
cmake -S third_party/CPPWRF -B build/native -G Ninja -DCMAKE_BUILD_TYPE=Release -DCPPWRF_DOUBLE=ON
nice -n 10 cmake --build build/native -j4             # CPU FP64: cppwrf and cppwrf_real
cmake -S build/cppwrf-src -B build/native-cuda -G Ninja -DCMAKE_BUILD_TYPE=Release \
      -DCPPWRF_ENABLE_CUDA=ON -DCPPWRF_DOUBLE=OFF -DCMAKE_CUDA_ARCHITECTURES=75
nice -n 10 cmake --build build/native-cuda -j4        # GPU FP32: cppwrf
cmake -S forecast -B build/forecast -G Ninja
nice -n 10 cmake --build build/forecast -j4
```

`75` is the RTX 2060 (Turing); use your GPU's compute capability.

WPS 4.6.0, its low-resolution geography and WRF's physics tables are not built here. The pipeline links them,
read-only, from `WPS_DIR`, `GEOG_DIR` and `WRF_RUN_DIR` (defaults under `~/wrf_real`). No program runs with its
working directory there; every step runs in `build/runs/<id>/`.

## Run

```bash
build/forecast/cppwrf-forecast --port 8090
```

Open `http://127.0.0.1:8090/`, click the map to place the centre, set the grid and the length, and press
**Run forecast**. The bar at the top shows the five stages. When the run ends the page loads it: pick a layer on
the right (wind, temperature, rain, humidity, pressure with isobars, clouds), press play or drag the time bar, and
hover for values. **wrfout** downloads the model's output.

## Limits and checks

The server refuses a run, with the reason and a smaller suggestion, when:

- the grid is above 150 × 150 × 45 points or the forecast above 24 h;
- the GPU memory estimate does not fit (FP32 build: about 1430 MiB + 0.0040 MiB per grid cell, plus 10 %;
  measured on an RTX 2060 at 105 k and 480 k cells);
- it would leave less than 15 GB free on the disk, or the repository would grow above 8 GB;
- another run is going (one at a time).

Before a new run it deletes the oldest runs (at most 6 are kept, fewer when the disk or the 8 GB cap need it).
GFS files are downloaded for the domain plus 4° only, every 3 h, at most 2 GB per run, and deleted after
ungrib. `met_em` files are deleted after `cppwrf_real`, restart files after the run.

The namelist is written as WRF's `namelist.input` and translated by CPPWRF's own `tools/wrf2cppwrf.py`. If the
translation or the model fails, the page shows the error and the translator's last lines.

## Choices

- **Projection:** Lambert conformal, or Mercator within 25° of the equator.
- **Physics:** WRF's `CONUS` suite, or `tropical`.
- **Levels:** `auto_levels_opt = 2`; the stretch and the largest Δz are chosen so the levels reach a 50 hPa top.
- **Time step:** 5 × Δx (km) seconds; radiation every Δx minutes.
- **Output:** hourly. The GFS run is the newest one whose 27 h file is already on NOMADS (checked every 10 min).

## Products

`wrfpost` writes the fields on a regular latitude-longitude grid of about the model's spacing (bilinear from the
model grid, found by inverting the model's map projection; NaN outside the domain):

| plane | field | unit |
|---|---|---|
| 0, 1 | U10, V10, turned from the model grid to east and north (COSALPHA, SINALPHA) | m/s |
| 2 | T2 | °C |
| 3 | rain rate: the change of RAINNC + RAINC + RAINSH per hour (0 in the first frame) | mm/h |
| 4 | relative humidity at 2 m | % |
| 5 | sea-level pressure | hPa |
| 6 | cloud cover, column maximum of CLDFRA | % |

The map underneath is drawn from WPS's geography (GMTED2010 height and MODIS water at 5′), served once by
`/api/basemap`.
