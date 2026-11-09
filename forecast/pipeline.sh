#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# One local forecast: GFS (NOMADS, the region only) -> WPS 4.6.0 (geogrid, ungrib, metgrid) -> cppwrf_real -> cppwrf
# (GPU FP32 or CPU FP64) -> wrfout, in the run directory RUN (build/runs/<id>). The server (forecast/server) starts it
# and reads RUN/state; it can be run by hand too:
#
#   LAT=39 LON=32 DX_KM=15 NX=60 NY=50 NZ=40 HOURS=6 CYCLE=2026110818 BACKEND=gpu-fp32 SUITE=CONUS \
#     forecast/pipeline.sh build/runs/test
#
# Everything is written in RUN. WPS, its geography data and WRF's physics tables are only linked (read-only):
#   WPS_DIR (default ~/wrf_real/WPS-4.6.0), GEOG_DIR (~/wrf_real/geog/WPS_GEOG_LOW_RES),
#   WRF_RUN_DIR (~/wrf_real/WRF-4.8.0/run). CPPWRF: build/native (CPU FP64, cppwrf_real) and build/native-cuda (FP32).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN=${1:?usage: pipeline.sh RUN_DIR}
mkdir -p "$RUN" && RUN=$(cd "$RUN" && pwd)
WPS_DIR=${WPS_DIR:-$HOME/wrf_real/WPS-4.6.0}
GEOG_DIR=${GEOG_DIR:-$HOME/wrf_real/geog/WPS_GEOG_LOW_RES}
WRF_RUN_DIR=${WRF_RUN_DIR:-$HOME/wrf_real/WRF-4.8.0/run}
CPU_BUILD=${CPU_BUILD:-$ROOT/build/native}
GPU_BUILD=${GPU_BUILD:-$ROOT/build/native-cuda}
: "${LAT:?}" "${LON:?}" "${DX_KM:?}" "${NX:?}" "${NY:?}" "${NZ:?}" "${HOURS:?}" "${CYCLE:?}"
BACKEND=${BACKEND:-gpu-fp32}
SUITE=${SUITE:-CONUS}
HIST_MIN=${HIST_MIN:-60}
MIN_FREE_GB=${MIN_FREE_GB:-15}

state() { printf '%s\n' "$*" > "$RUN/state.tmp" && mv "$RUN/state.tmp" "$RUN/state"; }
fail() { state "failed $STAGE $*"; echo "FAILED [$STAGE]: $*" >&2; exit 1; }
STAGE=check

# ---- limits (the server checks them first; repeated here for runs by hand)
[ "$NX" -le 150 ] && [ "$NY" -le 150 ] && [ "$NZ" -le 45 ] || fail "domain above 150 x 150 x 45"
[ "$NX" -ge 20 ] && [ "$NY" -ge 20 ] && [ "$NZ" -ge 25 ] || fail "domain below 20 x 20 x 25"
[ "$HOURS" -ge 1 ] && [ "$HOURS" -le 24 ] || fail "forecast length must be 1-24 h"
free_gb() { df -BG --output=avail "$RUN" | tail -1 | tr -dc 0-9; }
[ "$(free_gb)" -gt "$MIN_FREE_GB" ] || fail "less than $MIN_FREE_GB GB free on the disk"
case $BACKEND in
  gpu-fp32) MODEL=$GPU_BUILD/cppwrf ;;
  cpu-fp64) MODEL=$CPU_BUILD/cppwrf ;;
  *) fail "unknown backend $BACKEND" ;;
esac
REAL=$CPU_BUILD/src/init_real/cppwrf_real
for x in "$MODEL" "$REAL" "$WPS_DIR/geogrid.exe" "$WPS_DIR/ungrib.exe" "$WPS_DIR/metgrid.exe"; do
  [ -x "$x" ] || fail "missing $x"
done

# ---- dates: the cycle, the end, GFS every 3 h up to the first output hour >= HOURS
C0=${CYCLE:0:8}; CH=${CYCLE:8:2}
start=$(date -u -d "$C0 $CH:00" +%s)
GHOURS=$(( (HOURS + 2) / 3 * 3 ))
iso() { date -u -d "@$1" +%Y-%m-%d_%H:%M:%S; }
START=$(iso "$start"); END=$(iso $((start + HOURS * 3600))); GEND=$(iso $((start + GHOURS * 3600)))
DX=$((DX_KM * 1000))

# ---- the region of GFS to fetch: the domain plus 4 degrees
read -r S N W E < <(python3 -I -c "
import math
lat, lon, hx, hy = $LAT, $LON, $NX * $DX_KM / 2, $NY * $DX_KM / 2
dlat = hy / 111.2 + 4; dlon = hx / (111.2 * max(0.2, math.cos(math.radians(lat)))) + 4
s, n = max(-90, math.floor(lat - dlat)), min(90, math.ceil(lat + dlat))
w, e = math.floor(lon - dlon), math.ceil(lon + dlon)
print(s, n, w, e)")
[ "$W" -ge -180 ] && [ "$E" -le 180 ] || fail "the region crosses the date line (not supported)"

# ---- 1. GFS, the region only (NOMADS grib filter), 3 tries per file
STAGE=download; state "running download 0"
mkdir -p "$RUN/gfs"
nfiles=$((GHOURS / 3 + 1)); k=0; total=0
for ((h = 0; h <= GHOURS; h += 3)); do
  f=$(printf 'f%03d' "$h"); out="$RUN/gfs/gfs.$f.grb2"
  if [ ! -s "$out" ]; then
    [ "$(free_gb)" -gt "$MIN_FREE_GB" ] || fail "less than $MIN_FREE_GB GB free on the disk"
    [ "$(du -s -BG "$ROOT" | tr -dc 0-9)" -le 8 ] || fail "the repository is above 8 GB"
    ok=0
    for try in 1 2 3; do
      code=$(curl -s --max-time 300 -o "$out.part" -w '%{http_code}' \
        "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.$C0%2F$CH%2Fatmos&file=gfs.t${CH}z.pgrb2.0p25.$f&all_var=on&all_lev=on&subregion=&toplat=$N&leftlon=$W&rightlon=$E&bottomlat=$S")
      if [ "$code" = 200 ] && [ "$(head -c 4 "$out.part")" = GRIB ]; then mv "$out.part" "$out"; ok=1; break; fi
      echo "GFS $f: try $try failed (HTTP $code)" >&2; sleep $((try * 5))
    done
    rm -f "$out.part"
    [ $ok = 1 ] || fail "GFS $f could not be downloaded (3 tries)"
  fi
  total=$((total + $(stat -c %s "$out")))
  [ "$total" -le $((2 * 1024 * 1024 * 1024)) ] || fail "GFS download above 2 GB"
  k=$((k + 1)); state "running download $((100 * k / nfiles))"
done
echo "GFS: $nfiles files, $((total / 1024 / 1024)) MB" >&2

# ---- 2. WPS in RUN/wps (its programs, tables and data linked, read-only)
STAGE=wps; state "running wps 0"
mkdir -p "$RUN/wps" && cd "$RUN/wps" || fail "no wps directory"
for p in geogrid ungrib metgrid; do ln -sfn "$WPS_DIR/$p.exe" "$p.exe"; done
ln -sfn "$WPS_DIR/geogrid" geogrid; ln -sfn "$WPS_DIR/metgrid" metgrid
ln -sfn "$WPS_DIR/ungrib/Variable_Tables/Vtable.GFS" Vtable
L=(A B C D E F G H I J K L M N O P Q R S T U V W X Y Z); n=0
rm -f GRIBFILE.*
for g in "$RUN"/gfs/gfs.f*.grb2; do ln -sfn "$g" "GRIBFILE.AA${L[$n]}"; n=$((n + 1)); done
read -r PROJ TL1 TL2 < <(python3 -I -c "
lat = $LAT
print('mercator', lat, 0) if abs(lat) < 25 else print('lambert', lat, lat)")
cat > namelist.wps <<EOF
&share
 wrf_core = 'ARW', max_dom = 1,
 start_date = '$START', end_date = '$GEND',
 interval_seconds = 10800, io_form_geogrid = 2,
/
&geogrid
 parent_id = 1, parent_grid_ratio = 1, i_parent_start = 1, j_parent_start = 1,
 e_we = $((NX + 1)), e_sn = $((NY + 1)), geog_data_res = 'lowres',
 dx = $DX, dy = $DX, map_proj = '$PROJ',
 ref_lat = $LAT, ref_lon = $LON, truelat1 = $TL1, truelat2 = $TL2, stand_lon = $LON,
 geog_data_path = '$GEOG_DIR',
/
&ungrib
 out_format = 'WPS', prefix = 'FILE',
/
&metgrid
 fg_name = 'FILE', io_form_metgrid = 2,
/
EOF
i=0
for p in geogrid ungrib metgrid; do
  ./$p.exe > $p.log 2>&1
  grep -q "Successful completion of $p" $p.log || fail "$p.exe failed (wps/$p.log)"
  i=$((i + 1)); state "running wps $((100 * i / 3))"
done
rm -f FILE:* GRIBFILE.* "$RUN"/gfs/*.grb2  # the intermediate files and GFS: no longer needed

# ---- 3. cppwrf_real in RUN/run
STAGE=real; state "running real 0"
mkdir -p "$RUN/run" && cd "$RUN/run" || fail "no run directory"
met=$(ls "$RUN"/wps/met_em.d01.* | head -1)
NLEV=$(ncdump -h "$met" | sed -n 's/^\s*num_metgrid_levels = \([0-9]*\).*/\1/p')
NCAT=$(ncdump -h "$met" | sed -n 's/^\s*:NUM_LAND_CAT = \([0-9]*\).*/\1/p')
NSOIL=$(ncdump -h "$met" | sed -n 's/^\s*num_st_layers = \([0-9]*\).*/\1/p')
read -r SY SM SD SH < <(date -u -d "@$start" '+%Y %m %d %H')
# the boundaries cover the GFS hours (cppwrf_real needs the end one interval beyond the start); the model stops
# after HOURS (--set run.run_time below)
e=$((start + GHOURS * 3600)); read -r EY EM ED EH < <(date -u -d "@$e" '+%Y %m %d %H')
TSTEP=$((DX_KM * 5))
# the levels (auto_levels_opt 2): 30 m at the ground, stretched by the smallest factor (and max_dz) whose column
# reaches 23 km (p_top 50 hPa is near 20.5 km), so that few levels still reach the top
read -r STRETCH MAXDZ < <(python3 -I -c "
nz = $NZ
for s100 in range(108, 131):
    for mdz in range(1000, 2001, 100):
        z, dz = 0.0, 30.0
        for k in range(nz):
            z += dz; dz = min(dz * s100 / 100, mdz)
        if z >= 23000: print(s100 / 100, mdz); raise SystemExit
print(0, 0)")
[ "$MAXDZ" -gt 0 ] || fail "$NZ levels cannot reach the model top; use more levels"
cat > namelist.input <<EOF
 &time_control
 run_days = 0, run_hours = $GHOURS, run_minutes = 0, run_seconds = 0,
 start_year = $SY, start_month = $SM, start_day = $SD, start_hour = $SH,
 end_year = $EY, end_month = $EM, end_day = $ED, end_hour = $EH,
 interval_seconds = 10800, input_from_file = .true.,
 history_interval = $HIST_MIN, frames_per_outfile = 1000,
 restart = .false., restart_interval = 100000,
 io_form_history = 2, io_form_restart = 2, io_form_input = 2, io_form_boundary = 2,
 /
 &domains
 time_step = $TSTEP, time_step_fract_num = 0, time_step_fract_den = 1, max_dom = 1,
 e_we = $((NX + 1)), e_sn = $((NY + 1)), e_vert = $((NZ + 1)),
 auto_levels_opt = 2, dzbot = 30., dzstretch_s = $STRETCH, dzstretch_u = $STRETCH, max_dz = $MAXDZ., p_top_requested = 5000,
 num_metgrid_levels = $NLEV, num_metgrid_soil_levels = ${NSOIL:-4},
 dx = $DX, dy = $DX, grid_id = 1, parent_id = 0, i_parent_start = 1, j_parent_start = 1,
 parent_grid_ratio = 1, parent_time_step_ratio = 1, feedback = 0, smooth_option = 0,
 /
 &physics
 physics_suite = '$SUITE',
 radt = $DX_KM, bldt = 0, cudt = 0, icloud = 1,
 num_land_cat = $NCAT, sf_urban_physics = 0, fractional_seaice = 1,
 /
 &fdda
 /
 &dynamics
 hybrid_opt = 2, w_damping = 0, diff_opt = 2, km_opt = 4, diff_6th_opt = 0, diff_6th_factor = 0.12,
 base_temp = 290., damp_opt = 3, zdamp = 5000., dampcoef = 0.2, khdif = 0, kvdif = 0,
 non_hydrostatic = .true., moist_adv_opt = 1, scalar_adv_opt = 1, gwd_opt = 1,
 /
 &bdy_control
 spec_bdy_width = 5, specified = .true.,
 /
 &grib2
 /
 &namelist_quilt
 nio_tasks_per_group = 0, nio_groups = 1,
 /
EOF
"$REAL" --namelist namelist.input --met-dir "$RUN/wps" --out-dir . > real.log 2>&1 || fail "cppwrf_real failed (run/real.log)"
rm -f "$RUN"/wps/met_em.d01.*  # wrfinput and wrfbdy have them now
state "running real 100"

# ---- 4. the model
STAGE=model; state "running model 0"
for f in "$WRF_RUN_DIR"/*; do
  case ${f##*/} in namelist.input|*.exe|README*) ;; *) ln -sfn "$f" . ;; esac
done
python3 -I "$ROOT/third_party/CPPWRF/tools/wrf2cppwrf.py" namelist.input -o run.ini --format wrfout \
  > translate.log 2>&1 || { tail -5 translate.log >&2; fail "the namelist translator refused the options (run/translate.log)"; }
NSTEPS=$((HOURS * 3600 / TSTEP))
mkdir -p "$RUN/out"
OMP_NUM_THREADS=${OMP_NUM_THREADS:-4} nice -n 10 "$MODEL" run.ini --set output.dir="$RUN/out" --set run.run_time=$((HOURS * 3600)) > model.log 2>&1 &
mp=$!
while kill -0 $mp 2> /dev/null; do
  s=$(tail -n 1 "$RUN/out/diag.csv" 2> /dev/null | cut -d, -f1 | tr -dc 0-9)
  [ -n "$s" ] && state "running model $((100 * s / NSTEPS))"
  sleep 2
done
wait $mp || { tail -5 model.log >&2; fail "cppwrf failed (run/model.log)"; }

# ---- 5. the products for the map
STAGE=post; state "running post 0"
rm -f "$RUN"/out/restart_*.nc  # CPPWRF's own restart file: not used here
"$ROOT/build/forecast/wrfpost" "$RUN/out" "$RUN/products" > "$RUN/post.log" 2>&1 || fail "wrfpost failed (post.log)"
state "done"
