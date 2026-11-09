#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# One local forecast in its run directory RUN (build/runs/<id>), prepared by forecast/prepare.py setup
# (RUN/plan.env, RUN/plan.json, RUN/wps/namelist.wps). The server starts it in its own process group and reads:
#   RUN/state        "<stage> <percent>" while it runs, then "done" or "failed <stage> <message>"
#   RUN/times        "<stage> <seconds>" per finished stage
#   RUN/logs/*.log   one log per stage
# Stages: download (GFS, the region only) -> wps (geogrid, ungrib, metgrid) -> real (cppwrf_real) -> model (cppwrf)
# -> post (wrfpost, also while the model runs). Every program runs in RUN; WPS, its geography and WRF's tables are only
# linked (read-only): WPS_DIR, GEOG_DIR, WRF_RUN_DIR (defaults under ~/wrf_real).
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
RUN=$(cd "${1:?usage: pipeline.sh RUN_DIR}" && pwd)
WPS_DIR=${WPS_DIR:-$HOME/wrf_real/WPS-4.6.0}
WRF_RUN_DIR=${WRF_RUN_DIR:-$HOME/wrf_real/WRF-4.8.0/run}
MIN_FREE_GB=${MIN_FREE_GB:-15}
# shellcheck source=/dev/null
. "$RUN/plan.env"
mkdir -p "$RUN/logs"
: > "$RUN/times"

STAGE=check
state() { printf '%s\n' "$*" > "$RUN/state.tmp" && mv "$RUN/state.tmp" "$RUN/state"; }
fail() { state "failed $STAGE $*"; echo "HATA [$STAGE]: $*" >&2; exit 1; }
export LC_ALL=C  # decimal points in the numbers this script writes (times, plan)
now() { date +%s.%N; }
since() { awk -v a="$1" -v b="$(now)" 'BEGIN { printf "%.2f", b - a }'; }
T0=$(now)
begin() { STAGE=$1; T0=$(now); state "$STAGE 0"; }
finish() { echo "$STAGE $(since "$T0")" >> "$RUN/times"; }
free_gb() { df -BG --output=avail "$RUN" | tail -1 | tr -dc 0-9; }
disk_ok() { [ "$(free_gb)" -gt "$MIN_FREE_GB" ] || fail "Diskte $MIN_FREE_GB GB'tan az boş yer kaldı; eski çalışmaları silin."; }

case $MODE in
  gpu-fp32) MODEL=$ROOT/build/gpu-fp32/cppwrf ;;
  gpu-fp64) MODEL=$ROOT/build/gpu-fp64/cppwrf ;;
  cpu-fp64) MODEL=$ROOT/build/cpu-fp64/cppwrf ;;
  *) fail "Bilinmeyen kip: $MODE" ;;
esac
REAL=$ROOT/build/cpu-fp64/src/init_real/cppwrf_real
for x in "$MODEL" "$REAL" "$WPS_DIR/geogrid.exe" "$WPS_DIR/ungrib.exe" "$WPS_DIR/metgrid.exe" "$ROOT/build/forecast/wrfpost"; do
  [ -x "$x" ] || fail "Eksik program: ${x##*/} (tools/build_all.sh)"
done
disk_ok

# ---- 1. GFS, the region only (NOMADS grib filter); retries with backoff
begin download
mkdir -p "$RUN/gfs"
C0=${CYCLE:0:8}; CH=${CYCLE:8:2}
read -ra FH <<< "$FHOURS"
k=0; total=0
for h in "${FH[@]}"; do
  f=$(printf 'f%03d' "$h"); out="$RUN/gfs/gfs.$f.grb2"
  if [ ! -s "$out" ]; then
    disk_ok
    ok=0
    for try in 1 2 3; do
      code=$(curl -s --max-time 300 -o "$out.part" -w '%{http_code}' \
        "https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_0p25.pl?dir=%2Fgfs.$C0%2F$CH%2Fatmos&file=gfs.t${CH}z.pgrb2.0p25.$f&all_var=on&all_lev=on&subregion=&toplat=$REGION_N&leftlon=$REGION_W&rightlon=$REGION_E&bottomlat=$REGION_S")
      if [ "$code" = 200 ] && [ "$(head -c 4 "$out.part")" = GRIB ]; then mv "$out.part" "$out"; ok=1; break; fi
      echo "GFS $f: deneme $try başarısız (HTTP $code)" >> "$RUN/logs/download.log"
      # 404, 403 "Request for Old Data" or an HTML answer: the file is not published (yet, or any more)
      if [ "$code" = 404 ] || { [ "$code" = 403 ] && grep -qi 'old data' "$out.part"; } ||
         { [ "$code" = 200 ] && grep -qi 'data file is not present\|not exist' "$out.part"; }; then
        rm -f "$out.part"
        fail "GFS $CYCLE çevriminin $h. saati NOMADS'ta yok (henüz yayımlanmadı ya da arşivden kalktı). Daha eski bir çevrim seçin."
      fi
      sleep $((5 * 3 ** (try - 1)))
    done
    rm -f "$out.part"
    [ $ok = 1 ] || fail "GFS indirilemedi (ağ hatası, 3 deneme): $f. Bağlantıyı denetleyip tekrar çalıştırın."
  fi
  total=$((total + $(stat -c %s "$out")))
  k=$((k + 1)); state "download $((100 * k / ${#FH[@]}))"
done
echo "GFS: ${#FH[@]} dosya, $((total / 1024 / 1024)) MB" >> "$RUN/logs/download.log"
echo "$total" > "$RUN/gfs_bytes"
finish

# ---- 2. WPS in RUN/wps
begin wps
cd "$RUN/wps" || fail "wps dizini yok"
for p in geogrid ungrib metgrid; do ln -sfn "$WPS_DIR/$p.exe" "$p.exe"; done
ln -sfn "$WPS_DIR/geogrid" geogrid; ln -sfn "$WPS_DIR/metgrid" metgrid
ln -sfn "$WPS_DIR/ungrib/Variable_Tables/Vtable.GFS" Vtable
rm -f GRIBFILE.*
n=0
for g in "$RUN"/gfs/gfs.f*.grb2; do
  a=$((n / 676)); b=$((n / 26 % 26)); c=$((n % 26))
  L=ABCDEFGHIJKLMNOPQRSTUVWXYZ
  ln -sfn "$g" "GRIBFILE.${L:a:1}${L:b:1}${L:c:1}"; n=$((n + 1))
done
i=0
for p in geogrid ungrib metgrid; do
  t=$(now)
  ./$p.exe > "$RUN/logs/$p.log" 2>&1
  if ! grep -q "Successful completion of $p" "$RUN/logs/$p.log"; then
    fail "$p.exe başarısız oldu: $(grep -iE 'error|fatal' "$RUN/logs/$p.log" | tail -2 | tr '\n' ' ')"
  fi
  i=$((i + 1)); state "wps $((100 * i / 3))"
  echo "$p $(since "$t")" >> "$RUN/times"
done
du -sb "$RUN/wps" | cut -f1 > "$RUN/wps_bytes"
rm -f FILE:* GRIBFILE.* "$RUN"/gfs/*.grb2  # the intermediate files and GFS are no longer needed

# ---- 3. cppwrf_real in RUN/run
begin real
disk_ok
python3 -I "$ROOT/forecast/prepare.py" input "$RUN" > "$RUN/logs/real.log" 2>&1 || fail "namelist.input yazılamadı"
cd "$RUN/run" || fail "run dizini yok"
"$REAL" --namelist namelist.input --met-dir "$RUN/wps" --out-dir . >> "$RUN/logs/real.log" 2>&1 ||
  fail "cppwrf_real başarısız oldu: $(grep -iE 'error|stop' "$RUN/logs/real.log" | tail -2 | tr '\n' ' ')"
rm -f "$RUN"/wps/met_em.d0*  # wrfinput and wrfbdy have them now
finish

# ---- 4. the model; wrfpost follows the output as it is written
begin model
for f in "$WRF_RUN_DIR"/*; do
  case ${f##*/} in namelist.input|*.exe|README*) ;; *) ln -sfn "$f" . ;; esac
done
python3 -I "$ROOT/third_party/CPPWRF/tools/wrf2cppwrf.py" namelist.input -o run.ini --format wrfout \
  > "$RUN/logs/translate.log" 2>&1 || fail "Çevirici seçenekleri kabul etmedi: $(grep ERROR "$RUN/logs/translate.log" | head -2 | tr '\n' ' ')"
mkdir -p "$RUN/out" "$RUN/products"
"$ROOT/build/forecast/wrfpost" --follow "$RUN/out" "$RUN/products" > "$RUN/logs/post.log" 2>&1 &
POST=$!
OMP_NUM_THREADS=${OMP_NUM_THREADS:-6} CPPWRF_MEMINFO=1 nice -n 10 "$MODEL" run.ini --set output.dir="$RUN/out" \
  --set run.run_time="$RUN_SECONDS" --set restart.interval=0 > "$RUN/logs/model.log" 2>&1 &
MP=$!
while kill -0 $MP 2> /dev/null; do
  s=$(tail -n 1 "$RUN/out/diag.csv" 2> /dev/null | cut -d, -f2 | cut -d. -f1 | tr -dc 0-9)
  [ -n "$s" ] && state "model $((100 * s / RUN_SECONDS))"
  sleep 1
done
if ! wait $MP; then
  touch "$RUN/out/.done"; wait $POST
  if grep -q 'non-finite' "$RUN/logs/model.log"; then
    fail "Model kararsızlaştı (sayısal patlama, CFL). Daha küçük bir zaman adımı ya da w_damping = 1 deneyin. $(grep 'non-finite' "$RUN/logs/model.log" | head -1)"
  elif grep -qi 'out of memory\|cudaErrorMemoryAllocation' "$RUN/logs/model.log"; then
    fail "GPU belleği yetmedi. Alanı küçültün, dx'i büyütün ya da GPU FP32 kipini seçin."
  elif grep -qi 'No space left' "$RUN/logs/model.log"; then
    fail "Disk doldu. Eski çalışmaları silin."
  fi
  fail "cppwrf başarısız oldu: $(grep -iE 'error' "$RUN/logs/model.log" | tail -2 | tr '\n' ' ')"
fi
finish

# ---- 5. the rest of the products
begin post
touch "$RUN/out/.done"
wait $POST || fail "wrfpost başarısız oldu: $(tail -2 "$RUN/logs/post.log" | tr '\n' ' ')"
rm -f "$RUN"/out/restart_*.nc
finish
state "done"
