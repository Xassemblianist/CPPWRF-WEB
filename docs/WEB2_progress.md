# WEB2 progress

## M1 — foundation (2026-11-09)

**Works**
- CPPWRF submodule moved from v1.0.0 (e849149) to 36b9b63, which fixes the nvcc 12.4 range-for error upstream.
  Patch 0002 and the overlay copy are gone; 0001 stays as a suggestion.
- `tools/build_all.sh` builds `build/cpu-fp64` (cppwrf + cppwrf_real), `build/gpu-fp32`, `build/gpu-fp64` and the
  server, one at a time, `nice -n 10`, `-j6`, compute capability from nvidia-smi (7.5 here), no floating-point
  flags. Times on this machine: 69 s, 142 s, 238 s.
- `forecast/prepare.py`: the settings schema (unknown keys and out-of-range values are errors), the derived values
  (projection by latitude, levels, time step 6·dx, GFS hours and region), the WPS and WRF namelists, the
  translator check (`tools/wrf2cppwrf.py` from the submodule; its `[ERROR]` lines are mapped to the setting they
  are about, with a Turkish explanation), the cost estimate and the warning level (green / yellow / red, with the
  cheapest change that makes a red run fit).
- The server (`forecast/server/server.cpp`) rebuilt: `/api/v1` (system, options, cycles, estimate, runs, run,
  delete, cancel, star, events as Server-Sent Events, logs, products, wrfout files), a queue with one run at a
  time, `run.json` per run (settings, mode, CPPWRF commit, estimate, actual numbers), programs started with
  execvp and argument arrays, 64 KB request limit, file paths built from checked run ids and names, cancel by
  SIGTERM then SIGKILL to the process group, partial files removed, orphaned runs found and stopped at start-up.
- GitHub Pages: the owner wants the site on Pages too. The server answers CORS and Private Network Access
  preflights for `https://xassemblianist.github.io` only; POST / DELETE from any other foreign origin get 403.
- The page from the first local forecast milestone talks to `/api/v1` and shows "CPPWRF 36b9b63"; the new
  viewer is M4.

**Measured** (the same case through the API in all three modes: Ankara, 40 × 36 × 35, 15 km, 3 h, P4 physics,
GFS 2026-11-08 18Z, hourly input)

| Mode | stepping | ns/cell/step | GPU memory | whole run |
|---|---|---|---|---|
| GPU FP32 | 1.48 s | 244 | 1075 MiB | 70 s |
| GPU FP64 | 3.42 s | 565 | 1757 MiB | 71 s |
| CPU FP64 (6 threads) | 13.46 s | 2226 | – | 82 s |

The GFS download (4 files from NOMADS) took 64 s of each run. **The GPU FP64 wrfout files equal the CPU FP64
files byte for byte** (`cmp`, all 4 output times).

![The page at M1](img/web2_m1.png)
