#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The settings of a local forecast: checks, derived values, WPS / WRF namelists, cost estimate.

The server (forecast/server/server.cpp) calls it with argument arrays, never through a shell:

  prepare.py options                                 the controls of the page: presets, CPPWRF's supported values
  prepare.py check SETTINGS.json SYSTEM.json         checks + estimate as JSON (the translator runs on the namelist)
  prepare.py setup SETTINGS.json SYSTEM.json RUN     the same, then RUN/plan.json, RUN/plan.env, RUN/wps/namelist.wps
  prepare.py input RUN                               RUN/run/namelist.input from the met_em files (before real)

Settings (JSON; every key optional but domain.lat / domain.lon):
  domain   lat, lon, dx_km (1-50), nx, ny (20-1000), nz (30-100), projection (auto | lambert | mercator | polar),
           ptop_hpa (10-200)
  time     cycle (YYYYMMDDHH), hours (1-384), output_min, time_step_s (null: 6 dx), adaptive (bool)
  nest     null or {i0, j0, nx, ny (parent cells), ratio (3 | 5), feedback (0 | 1)}
  physics  preset, options {WRF &physics name: value}
  dynamics {WRF &dynamics name: value}
  fdda     {grid_fdda, guv, gt, gq, ...}
  mode     gpu-fp32 | gpu-fp64 | cpu-fp64
Messages are in Turkish (the page shows them); field names are the settings' paths ("physics.mp_physics").
"""
import importlib.util
import json
import math
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CPPWRF = os.path.join(ROOT, "third_party", "CPPWRF")
TRANSLATOR = os.path.join(CPPWRF, "tools", "wrf2cppwrf.py")
CALIBRATION = os.path.join(ROOT, "build", "calibration.json")
MODES = ("gpu-fp32", "gpu-fp64", "cpu-fp64")
MIN_FREE_GB = 15.0


def translator_module():
    spec = importlib.util.spec_from_file_location("wrf2cppwrf", TRANSLATOR)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# ---- the physics presets: WRF's suites and the combinations CPPWRF verifies against WRF (docs/STATUS.md)
PRESETS = [
    {"id": "conus", "name": "Genel amaçlı (CONUS)", "status": "D0",
     "desc": "WRF'nin varsayılan takımı: Thompson, Tiedtke, MYJ, Eta, Noah, RRTMG. Orta enlemler için iyi bir başlangıç.",
     "physics": {"physics_suite": "CONUS"}},
    {"id": "tropical", "name": "Tropikal", "status": "suite",
     "desc": "WSM6, New Tiedtke, YSU, MM5, Noah, RRTMG. Tropik ve sıcak, nemli bölgeler için.",
     "physics": {"physics_suite": "tropical"}},
    {"id": "p4", "name": "Klasik: WSM6 + Kain-Fritsch + YSU", "status": "P4",
     "desc": "Yaygın, sağlam bir seçim; 10 km ve üstü çözünürlükte konveksiyonu parametrize eder.",
     "physics": {"mp_physics": 6, "cu_physics": 1, "bl_pbl_physics": 1, "sf_sfclay_physics": 1,
                 "sf_surface_physics": 2, "ra_lw_physics": 4, "ra_sw_physics": 4}},
    {"id": "p6", "name": "Thompson + Kain-Fritsch + YSU", "status": "P6",
     "desc": "Kış yağışı ve buzlanma için Thompson mikrofiziği; kar ve graupel ayrı hesaplanır.",
     "physics": {"mp_physics": 8, "cu_physics": 1, "bl_pbl_physics": 1, "sf_sfclay_physics": 1,
                 "sf_surface_physics": 2, "ra_lw_physics": 4, "ra_sw_physics": 4}},
    {"id": "acm2", "name": "Hava kalitesi: ACM2 + Pleim-Xiu", "status": "ACM7",
     "desc": "Hava kalitesi modellemesinde kullanılan sınır tabaka ve yüzey katmanı (WSM6, KF, Noah ile).",
     "physics": {"mp_physics": 6, "cu_physics": 1, "bl_pbl_physics": 7, "sf_sfclay_physics": 7,
                 "sf_surface_physics": 2, "ra_lw_physics": 4, "ra_sw_physics": 4}},
    {"id": "morrison", "name": "İki momentli mikrofizik: Morrison", "status": "MORR",
     "desc": "Damla ve buz sayısını da tahmin eder; konvektif fırtına ve bulut çalışmaları için.",
     "physics": {"mp_physics": 10, "cu_physics": 1, "bl_pbl_physics": 1, "sf_sfclay_physics": 1,
                 "sf_surface_physics": 2, "ra_lw_physics": 4, "ra_sw_physics": 4}},
    {"id": "mynn", "name": "MYNN-EDMF sınır tabaka", "status": "MYNN",
     "desc": "Thompson ve MYNN; sığ bulutlar ve stratüs için güçlü, kıyı ve deniz üstü sis tahmininde tercih edilir.",
     "physics": {"mp_physics": 8, "cu_physics": 1, "bl_pbl_physics": 5, "sf_sfclay_physics": 5,
                 "sf_surface_physics": 2, "ra_lw_physics": 4, "ra_sw_physics": 4, "icloud_bl": 1}},
    {"id": "gf", "name": "Grell-Freitas konveksiyon", "status": "A05G",
     "desc": "Ölçek duyarlı konveksiyon (derin ve sığ); 5-15 km arası gri bölgede kullanılır.",
     "physics": {"mp_physics": 6, "cu_physics": 3, "ishallow": 1, "bl_pbl_physics": 1, "sf_sfclay_physics": 1,
                 "sf_surface_physics": 2, "ra_lw_physics": 4, "ra_sw_physics": 4, "cu_rad_feedback": 1}},
    {"id": "hires", "name": "Yüksek çözünürlük (≤ 4 km), konveksiyon çözümlü", "status": "V3",
     "desc": "Kümülüs parametrizasyonu yok; Thompson, MYJ, Eta, Noah-MP, RRTMG. İç alan (nest) ile kullanılamaz.",
     "physics": {"mp_physics": 8, "cu_physics": 0, "bl_pbl_physics": 2, "sf_sfclay_physics": 2,
                 "sf_surface_physics": 4, "ra_lw_physics": 4, "ra_sw_physics": 4}},
]

# ---- the advanced controls: group, WRF namelist record, name, Turkish label and tooltip, kind, default
# Enum values come from the translator's SUPPORTED_OPTIONS when it lists the option.
CONTROLS = [
    ("Mikrofizik", "physics", "mp_physics", "Mikrofizik", "Bulut ve yağış parçacıklarının (yağmur, kar, graupel) hesabı.", "enum", None),
    ("Mikrofizik", "physics", "do_radar_ref", "Radar yansıtıcılığı", "Çıktıya 10 cm radar yansıtıcılığını (REFL_10CM) ekler.", "enum", 0, {0: "Kapalı", 1: "Açık"}),
    ("Mikrofizik", "physics", "hail_opt", "Dolu (WSM6)", "WSM6'da graupel yerine dolu özellikleri.", "enum", 0, {0: "Kapalı", 1: "Açık"}),
    ("Kümülüs", "physics", "cu_physics", "Kümülüs (konveksiyon)", "Izgaranın çözemediği konvektif bulutlar. 4 km altında genelde kapalı.", "enum", None),
    ("Kümülüs", "physics", "cudt", "Kümülüs çağrı aralığı (dk)", "0: her adımda.", "int", 0, (0, 60)),
    ("Kümülüs", "physics", "cu_rad_feedback", "Kümülüs bulutları radyasyona", "Parametrize bulutlar radyasyonu etkilesin.", "enum", 0, {0: "Kapalı", 1: "Açık"}),
    ("Kümülüs", "physics", "ishallow", "Sığ konveksiyon (Grell-Freitas)", "Yalnız Grell-Freitas ile.", "enum", 0, {0: "Kapalı", 1: "Açık"}),
    ("Sınır tabaka", "physics", "bl_pbl_physics", "Gezegensel sınır tabaka", "Yere yakın türbülanslı karışım.", "enum", None),
    ("Sınır tabaka", "physics", "bldt", "Sınır tabaka çağrı aralığı (dk)", "0: her adımda.", "int", 0, (0, 30)),
    ("Sınır tabaka", "physics", "icloud_bl", "Alt-ızgara bulutları (MYNN)", "MYNN'in sınır tabaka bulutları radyasyona girsin.", "enum", 1, {0: "Kapalı", 1: "Açık"}),
    ("Yüzey katmanı", "physics", "sf_sfclay_physics", "Yüzey katmanı", "Yüzeyle atmosfer arası akı hesabı; sınır tabakayla uyumlu olmalı.", "enum", None),
    ("Kara yüzeyi", "physics", "sf_surface_physics", "Kara yüzeyi modeli", "Toprak sıcaklığı, nem ve kar.", "enum", None),
    ("Kara yüzeyi", "physics", "fractional_seaice", "Kesirli deniz buzu", "Buz kısmen kaplı hücreler.", "enum", 1, {0: "Kapalı", 1: "Açık"}),
    ("Radyasyon", "physics", "ra_lw_physics", "Uzun dalga radyasyon", "Yer ve atmosferin ışınımı.", "enum", None),
    ("Radyasyon", "physics", "ra_sw_physics", "Kısa dalga radyasyon", "Güneş ışınımı.", "enum", None),
    ("Radyasyon", "physics", "radt", "Radyasyon aralığı (dk)", "Önerilen: dx (km) kadar dakika.", "int", None, (1, 60)),
    ("Radyasyon", "physics", "icloud", "Bulutlar radyasyonda", "0: bulutlar radyasyonu etkilemez.", "enum", 1, {0: "Kapalı", 1: "Açık"}),
    ("Difüzyon ve sönümleme", "dynamics", "diff_opt", "Difüzyon", "Yatay ve dikey karışımın biçimi.", "enum", 2),
    ("Difüzyon ve sönümleme", "dynamics", "km_opt", "Girdap viskozitesi", "Karışım katsayısının hesabı.", "enum", 4),
    ("Difüzyon ve sönümleme", "dynamics", "diff_6th_opt", "6. derece difüzyon", "Sayısal gürültüyü azaltır; 2: pozitif tanımlı.", "enum", 0, {0: "Kapalı", 1: "Açık", 2: "Pozitif tanımlı"}),
    ("Difüzyon ve sönümleme", "dynamics", "damp_opt", "Üst sönümleme", "Model tepesinde dalga yansımasını önler.", "enum", 3),
    ("Difüzyon ve sönümleme", "dynamics", "zdamp", "Sönümleme kalınlığı (m)", "Tepeden aşağı sönümlenen katman.", "float", 5000.0, (0.0, 20000.0)),
    ("Difüzyon ve sönümleme", "dynamics", "dampcoef", "Sönümleme katsayısı", "damp_opt 3 için 0.2 önerilir.", "float", 0.2, (0.0, 1.0)),
    ("Difüzyon ve sönümleme", "dynamics", "w_damping", "Dikey hız sönümlemesi", "Çok güçlü dikey hareketleri sınırlar; kararlılık için.", "enum", 0, {0: "Kapalı", 1: "Açık"}),
    ("Difüzyon ve sönümleme", "dynamics", "gwd_opt", "Yerçekimi dalgası sürüklemesi", "Alt-ızgara dağların etkisi (kaba çözünürlükte).", "enum", 1, {0: "Kapalı", 1: "Açık"}),
    ("Nudging", "fdda", "grid_fdda", "Analiz nudging", "Modeli GFS analizine doğru çeker. Varsayılan kapalı; uyarlanır adımla kullanılamaz.", "enum", 0, {0: "Kapalı", 1: "Açık"}),
    ("Nudging", "fdda", "gfdda_end_h", "Nudging bitişi (saat)", "Bu saatten sonra serbest tahmin.", "int", 24, (1, 384)),
    ("Nudging", "fdda", "guv", "Rüzgâr nudging katsayısı (1/s)", "", "float", 0.0003, (0.0, 0.01)),
    ("Nudging", "fdda", "gt", "Sıcaklık nudging katsayısı (1/s)", "", "float", 0.0003, (0.0, 0.01)),
    ("Nudging", "fdda", "gq", "Nem nudging katsayısı (1/s)", "", "float", 0.0003, (0.0, 0.01)),
]

TR_SCHEMES = {  # Turkish names for the translator's values
    "None / off": "Kapalı",
}


def options_json():
    tr = translator_module()
    sup = tr.SUPPORTED_OPTIONS
    out = []
    for c in CONTROLS:
        group, record, name, label, tip, kind, default = c[:7]
        ctl = {"group": group, "record": record, "name": name, "label": label, "tip": tip, "kind": kind, "default": default}
        if kind == "enum":
            vals = c[7] if len(c) > 7 else None
            if vals is None and name in sup:
                vals = {k: TR_SCHEMES.get(v, v) for k, v in sup[name].items()}
            ctl["values"] = [{"value": k, "label": v} for k, v in vals.items()]
        elif len(c) > 7:
            ctl["range"] = list(c[7])
        out.append(ctl)
    suites = {k: v for k, v in tr.PHYSICS_SUITES.items()}
    return {"presets": PRESETS, "controls": out, "suites": suites, "modes": list(MODES)}


# ---- checks
class Problems:
    def __init__(self):
        self.errors, self.warnings = [], []

    def err(self, field, msg):
        self.errors.append({"field": field, "message": msg})

    def warn(self, field, msg, level="yellow"):
        self.warnings.append({"field": field, "message": msg, "level": level})


def num(p, d, key, field, lo, hi, default=None, integer=False):
    v = d.get(key, default)
    if v is None:
        p.err(field, "Değer gerekli.")
        return default if default is not None else lo
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v):
        p.err(field, "Sayı olmalı.")
        return default if default is not None else lo
    if integer and int(v) != v:
        p.err(field, "Tam sayı olmalı.")
    if v < lo or v > hi:
        p.err(field, f"{lo} ile {hi} arasında olmalı.")
        v = min(max(v, lo), hi)
    return int(v) if integer else float(v)


def normalise(s, p):
    """The settings with defaults and ranges checked; unknown keys are errors."""
    if not isinstance(s, dict):
        p.err("", "Ayarlar bir JSON nesnesi olmalı.")
        return None
    known = {"domain", "time", "nest", "physics", "dynamics", "fdda", "mode", "keep_partial", "name"}
    for k in s:
        if k not in known:
            p.err(k, f"Bilinmeyen ayar: {k}")
    d = s.get("domain") or {}
    t = s.get("time") or {}
    n = {}
    dom = {
        "lat": num(p, d, "lat", "domain.lat", -89.0, 89.0),
        "lon": num(p, d, "lon", "domain.lon", -180.0, 180.0),
        "dx_km": num(p, d, "dx_km", "domain.dx_km", 1.0, 50.0, 12.0),
        "nx": num(p, d, "nx", "domain.nx", 20, 1000, 100, True),
        "ny": num(p, d, "ny", "domain.ny", 20, 1000, 90, True),
        "nz": num(p, d, "nz", "domain.nz", 30, 100, 45, True),
        "ptop_hpa": num(p, d, "ptop_hpa", "domain.ptop_hpa", 10.0, 200.0, 50.0),
        "projection": d.get("projection", "auto"),
    }
    if dom["projection"] not in ("auto", "lambert", "mercator", "polar"):
        p.err("domain.projection", "auto, lambert, mercator ya da polar olmalı.")
        dom["projection"] = "auto"
    # dx in whole metres; WPS and WRF take dx in metres
    dom["dx_m"] = round(dom["dx_km"] * 1000)
    n["domain"] = dom
    cyc = str(t.get("cycle", ""))
    if not (len(cyc) == 10 and cyc.isdigit() and cyc[8:] in ("00", "06", "12", "18")):
        p.err("time.cycle", "GFS çevrimi YYYYMMDDHH biçiminde olmalı (saat 00, 06, 12 ya da 18).")
        cyc = "2000010100"
    tim = {
        "cycle": cyc,
        "hours": num(p, t, "hours", "time.hours", 1, 384, 24, True),
        "output_min": num(p, t, "output_min", "time.output_min", 10, 360, 60, True),
        "adaptive": bool(t.get("adaptive", False)),
    }
    suggested = max(1, int(round(6 * dom["dx_km"])))
    ts = t.get("time_step_s")
    tim["time_step_s"] = suggested if ts is None else num(p, t, "time_step_s", "time.time_step_s", 1, 600, suggested, True)
    tim["suggested_step_s"] = suggested
    n["time"] = tim
    mode = s.get("mode", "gpu-fp32")
    if mode not in MODES:
        p.err("mode", "gpu-fp32, gpu-fp64 ya da cpu-fp64 olmalı.")
        mode = "gpu-fp32"
    n["mode"] = mode
    n["keep_partial"] = bool(s.get("keep_partial", False))
    n["name"] = str(s.get("name", ""))[:80]
    nest = s.get("nest")
    if nest:
        ne = {
            "i0": num(p, nest, "i0", "nest.i0", 1, 1000, 10, True),
            "j0": num(p, nest, "j0", "nest.j0", 1, 1000, 10, True),
            "nx": num(p, nest, "nx", "nest.nx", 10, 1000, 30, True),
            "ny": num(p, nest, "ny", "nest.ny", 10, 1000, 30, True),
            "ratio": num(p, nest, "ratio", "nest.ratio", 3, 5, 3, True),
            "feedback": num(p, nest, "feedback", "nest.feedback", 0, 1, 1, True),
        }
        if ne["ratio"] not in (3, 5):
            p.err("nest.ratio", "Oran 3 ya da 5 olmalı.")
        # the nest stays 5 parent cells inside the parent's edges (the boundary zone)
        if ne["i0"] < 6 or ne["j0"] < 6 or ne["i0"] + ne["nx"] > dom["nx"] - 5 or ne["j0"] + ne["ny"] > dom["ny"] - 5:
            p.err("nest", "İç alan ana alanın kenarından en az 5 hücre içeride olmalı.")
        n["nest"] = ne
    else:
        n["nest"] = None
    # physics: a preset, then the user's options over it
    ph = s.get("physics") or {}
    preset = ph.get("preset", "conus")
    pre = next((x for x in PRESETS if x["id"] == preset), None)
    if pre is None:
        p.err("physics.preset", "Bilinmeyen ön ayar.")
        pre = PRESETS[0]
    phys = dict(pre["physics"])
    opts = ph.get("options") or {}
    ctl = {c[2]: c for c in CONTROLS}
    for k, v in opts.items():
        if k not in ctl or ctl[k][1] != "physics":
            p.err(f"physics.{k}", f"Bilinmeyen fizik seçeneği: {k}")
            continue
        if isinstance(v, bool) or not isinstance(v, (int, float)):
            p.err(f"physics.{k}", "Sayı olmalı.")
            continue
        phys[k] = v
    if "radt" not in phys:
        phys["radt"] = max(1, min(30, int(round(dom["dx_km"]))))
    n["physics"] = {"preset": pre["id"], "options": phys}
    dyn = {"diff_opt": 2, "km_opt": 4, "diff_6th_opt": 0, "diff_6th_factor": 0.12, "damp_opt": 3, "zdamp": 5000.0,
           "dampcoef": 0.2, "w_damping": 0, "gwd_opt": 1}
    for k, v in (s.get("dynamics") or {}).items():
        if k not in ctl or ctl[k][1] != "dynamics":
            p.err(f"dynamics.{k}", f"Bilinmeyen dinamik seçeneği: {k}")
        elif isinstance(v, bool) or not isinstance(v, (int, float)):
            p.err(f"dynamics.{k}", "Sayı olmalı.")
        else:
            dyn[k] = v
    if dom["dx_km"] < 5 and dyn["gwd_opt"] == 1 and "gwd_opt" not in (s.get("dynamics") or {}):
        dyn["gwd_opt"] = 0  # sub-grid orographic drag is for coarse grids
    n["dynamics"] = dyn
    fd = {"grid_fdda": 0}
    for k, v in (s.get("fdda") or {}).items():
        if k not in ctl or ctl[k][1] != "fdda":
            p.err(f"fdda.{k}", f"Bilinmeyen nudging seçeneği: {k}")
        elif isinstance(v, bool) or not isinstance(v, (int, float)):
            p.err(f"fdda.{k}", "Sayı olmalı.")
        else:
            fd[k] = v
    n["fdda"] = fd
    return n


# ---- derived values
def projection(dom):
    lat = dom["lat"]
    proj = dom["projection"]
    if proj == "auto":
        proj = "mercator" if abs(lat) < 20 else "polar" if abs(lat) > 65 else "lambert"
    if proj == "lambert":
        tl1 = tl2 = lat if abs(lat) >= 5 else math.copysign(5, lat if lat else 1)
    elif proj == "mercator":
        tl1 = tl2 = 0.0 if abs(lat) < 1 else lat
    else:
        tl1 = tl2 = math.copysign(60.0, lat) if abs(lat) < 60 else lat
    return proj, tl1, tl2


def levels(nz, ptop_hpa):
    """auto_levels_opt 2: 30 m at the ground, the smallest stretch (and max_dz) whose column reaches the top."""
    ztop = 7300 * math.log(1013.0 / ptop_hpa) + 2000
    for s100 in range(105, 131):
        for mdz in range(800, 2501, 100):
            z, dz = 0.0, 30.0
            for _ in range(nz):
                z += dz
                dz = min(dz * s100 / 100, mdz)
            if z >= ztop:
                return s100 / 100, mdz
    return None, None


def gfs_plan(n):
    """GFS hours, the input interval and the region to fetch (domain + 4 degrees)."""
    hours = n["time"]["hours"]
    nest_out = 0
    interval_h = 1 if hours <= 120 else 3
    ghours = int(math.ceil(hours / interval_h) * interval_h)
    if ghours == hours and hours % interval_h == 0 and ghours == 0:
        ghours = interval_h
    fh = list(range(0, ghours + 1, interval_h))
    dom = n["domain"]
    hx, hy = dom["nx"] * dom["dx_km"] / 2, dom["ny"] * dom["dx_km"] / 2
    lat = dom["lat"]
    dlat = hy / 111.2 + 4
    if abs(lat) + dlat >= 88 or dom["projection"] == "polar" and abs(lat) > 60:
        s, nn = (max(-90, math.floor(lat - dlat - 15)), 90) if lat > 0 else (-90, min(90, math.ceil(lat + dlat + 15)))
        w, e = 0, 359.75
    else:
        coslat = max(0.1, math.cos(math.radians(min(89, abs(lat) + dlat))))
        dlon = hx / (111.2 * coslat) + 4
        s, nn = max(-90, math.floor(lat - dlat)), min(90, math.ceil(lat + dlat))
        w, e = math.floor(dom["lon"] - dlon), math.ceil(dom["lon"] + dlon)
        if e - w >= 340:
            w, e = 0, 359.75
        elif w < -180 or e > 180:
            w, e = w % 360, e % 360  # NOMADS takes 0-360 longitudes; a box across 180 has w > e there
    return {"interval_h": interval_h, "ghours": ghours, "fhours": fh, "region": [s, nn, w, e]}


def region_deg2(r):
    s, n, w, e = r
    width = (e - w) % 360 if e < w else e - w
    return max(1.0, (n - s) * max(width, 0.25))


# ---- the cost model (build/calibration.json from tools/calibrate.sh; these defaults until it exists)
DEFAULT_CALIBRATION = {
    "source": "varsayılan (kalibrasyon yok)",
    "stages": {
        "download_s_per_file": 2.0, "download_s_per_mb": 0.4, "gfs_mb_per_deg2": 0.0085,
        "geogrid_s": 1.0, "geogrid_s_per_cell2d": 4e-5,
        "ungrib_s_per_file": 0.25, "ungrib_s_per_mb": 0.08,
        "metgrid_s_per_file": 0.25, "metgrid_s_per_cell2d_file": 2.0e-6,
        "real_s": 1.0, "real_s_per_cell3d_file": 6e-8,
        "post_s_per_frame": 0.05, "post_s_per_cell2d_frame": 1.5e-6,
        "met_em_bytes_per_cell2d_file": 2600, "products_bytes_per_cell2d_frame": 60,
        "wrfinput_bytes_per_cell3d": 120,
    },
    "modes": {
        "gpu-fp32": {"step_s": 0.004, "step_s_per_cell3d": 4.0e-8, "rad_s_per_cell3d": 1.2e-7,
                     "mem_mib": 1430, "mem_mib_per_cell3d": 0.0040, "ram_mib": 900, "ram_mib_per_cell3d": 0.0015,
                     "wrfout_bytes_per_cell3d_frame": 40},
        "gpu-fp64": {"step_s": 0.006, "step_s_per_cell3d": 4.0e-7, "rad_s_per_cell3d": 1.2e-6,
                     "mem_mib": 1500, "mem_mib_per_cell3d": 0.0075, "ram_mib": 1100, "ram_mib_per_cell3d": 0.003,
                     "wrfout_bytes_per_cell3d_frame": 80},
        "cpu-fp64": {"step_s": 0.002, "step_s_per_cell3d": 6.0e-7, "rad_s_per_cell3d": 2.0e-6,
                     "mem_mib": 0, "mem_mib_per_cell3d": 0.0, "ram_mib": 600, "ram_mib_per_cell3d": 0.010,
                     "wrfout_bytes_per_cell3d_frame": 80},
    },
}


def calibration():
    c = json.loads(json.dumps(DEFAULT_CALIBRATION))
    try:
        with open(CALIBRATION) as f:
            got = json.load(f)
        c["source"] = got.get("source", "kalibrasyon")
        for k in ("stages",):
            c[k].update(got.get(k, {}))
        for m, v in got.get("modes", {}).items():
            c["modes"].setdefault(m, {}).update(v)
    except (OSError, ValueError):
        pass
    return c


def fmt_dur(s):
    s = int(round(s))
    if s < 60:
        return f"{s} sn"
    if s < 3600:
        return f"{s // 60} dk {s % 60:02d} sn" if s < 600 else f"{round(s / 60)} dk"
    return f"{s // 3600} sa {round((s % 3600) / 60):02d} dk"


def estimate(n, plan, system, mode=None):
    mode = mode or n["mode"]
    cal = calibration()
    st, md = cal["stages"], cal["modes"][mode]
    dom, tim = n["domain"], n["time"]
    nz = dom["nz"]
    domains = [(dom["nx"], dom["ny"], tim["time_step_s"])]
    if n["nest"]:
        ne = n["nest"]
        domains.append((ne["nx"] * ne["ratio"], ne["ny"] * ne["ratio"], tim["time_step_s"] / ne["ratio"]))
    cells2d = sum(a * b for a, b, _ in domains)
    cells3d = cells2d * nz
    nfiles = len(plan["fhours"])
    run_s = tim["hours"] * 3600
    gfs_mb = nfiles * region_deg2(plan["region"]) * st["gfs_mb_per_deg2"] * 4.0  # 4: all levels and variables
    t = {}
    t["download"] = nfiles * st["download_s_per_file"] + gfs_mb * st["download_s_per_mb"]
    t["geogrid"] = st["geogrid_s"] + cells2d * st["geogrid_s_per_cell2d"]
    t["ungrib"] = nfiles * st["ungrib_s_per_file"] + gfs_mb * st["ungrib_s_per_mb"]
    t["metgrid"] = nfiles * (st["metgrid_s_per_file"] + cells2d * st["metgrid_s_per_cell2d_file"])
    t["real"] = st["real_s"] + cells3d * nfiles * st["real_s_per_cell3d_file"]
    model = 0.0
    radt = n["physics"]["options"].get("radt", 10)
    for (a, b, dt) in domains:
        c3 = a * b * nz
        steps = run_s / dt
        model += steps * (md["step_s"] + c3 * md["step_s_per_cell3d"])
        model += (run_s / (radt * 60)) * c3 * md["rad_s_per_cell3d"]
    if tim["adaptive"]:
        model *= 0.7  # the adaptive step is usually longer than 6 dx
    t["model"] = model
    frames = run_s // (tim["output_min"] * 60) + 1
    t["post"] = frames * (st["post_s_per_frame"] + cells2d * st["post_s_per_cell2d_frame"])
    total = sum(t.values())
    gpu_mib = (md["mem_mib"] + cells3d * md["mem_mib_per_cell3d"]) * 1.10 if mode.startswith("gpu") else 0.0
    ram_mib = (md["ram_mib"] + cells3d * md["ram_mib_per_cell3d"]) * 1.10
    disk = {
        "gfs": gfs_mb * 1e6,
        "wps": cells2d * nfiles * st["met_em_bytes_per_cell2d_file"],
        "wrfinput": cells3d * st["wrfinput_bytes_per_cell3d"] * 2 + cells2d * nfiles * 400,
        "wrfout": cells3d * frames * md["wrfout_bytes_per_cell3d_frame"],
        "products": cells2d * frames * st["products_bytes_per_cell2d_frame"] * 4,
    }
    # the peak: GFS and met_em are deleted once used, so the peak is the larger of WPS time and the end
    peak = max(disk["gfs"] + disk["wps"], disk["wps"] + disk["wrfinput"]) + disk["wrfout"] + disk["products"]
    return {"mode": mode, "stages_s": t, "total_s": total, "gpu_mib": gpu_mib, "ram_mib": ram_mib,
            "disk_bytes": disk, "disk_peak_bytes": peak, "gfs_mb": gfs_mb, "frames": int(frames),
            "cells3d": cells3d, "calibration": cal["source"]}


def judge(n, est, system, others):
    """Warning levels: green, yellow (long or above 70 % of GPU memory), red (does not fit)."""
    p = Problems()
    gpu_free = system.get("gpu_free_mib", 0)
    gpu_total = system.get("gpu_total_mib", 0)
    ram = system.get("ram_available_mib", 0)
    disk_free = system.get("disk_free_gb", 0)
    red = []
    if est["mode"].startswith("gpu"):
        if not system.get("gpu_ok"):
            red.append("Bu makinede GPU bulunamadı; CPU FP64 kipini seçin.")
        elif est["gpu_mib"] > gpu_free:
            red.append(f"GPU belleği yetmiyor: ~{est['gpu_mib'] / 1024:.1f} GB gerekli, {gpu_free / 1024:.1f} GB boş.")
        elif est["gpu_mib"] > 0.7 * gpu_total:
            p.warn("mode", f"GPU belleğinin %{100 * est['gpu_mib'] / gpu_total:.0f}'i kullanılacak.")
    if est["ram_mib"] > ram:
        red.append(f"RAM yetmiyor: ~{est['ram_mib'] / 1024:.1f} GB gerekli, {ram / 1024:.1f} GB boş.")
    if disk_free - est["disk_peak_bytes"] / 1e9 < MIN_FREE_GB:
        red.append(f"Disk yetmiyor: ~{est['disk_peak_bytes'] / 1e9:.1f} GB gerekli; diskte en az {MIN_FREE_GB:.0f} GB "
                   f"boş kalmalı ({disk_free:.1f} GB boş). Eski çalışmaları silmek yer açabilir.")
    if est["total_s"] > 1800:
        p.warn("time.hours", f"Uzun sürecek (~{fmt_dur(est['total_s'])}). Devam etmek istiyor musun?")
    for r in red:
        p.warn("", r, "red")
    level = "red" if red else "yellow" if p.warnings else "green"
    return level, p.warnings


def cheapest_fix(n, plan, system):
    """The smallest change that makes a refused run fit: FP32, coarser dx, fewer points, a shorter run."""
    def fits(m):
        pl = gfs_plan(m)
        e = estimate(m, pl, system)
        lvl, _ = judge(m, e, system, {})
        return lvl != "red"
    tries = []
    base = [("", n)]
    if n["mode"] != "gpu-fp32" and system.get("gpu_ok"):
        m = json.loads(json.dumps(n))
        m["mode"] = "gpu-fp32"
        tries.append(("GPU FP32 kipine geç", m))
        base.append(("GPU FP32 kipine geç ve ", m))
    for pre, b in base:
        for f in (0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.15, 0.1):
            m = json.loads(json.dumps(b))
            m["domain"]["nx"] = max(20, int(b["domain"]["nx"] * f))
            m["domain"]["ny"] = max(20, int(b["domain"]["ny"] * f))
            tries.append((f"{pre}{m['domain']['nx']} × {m['domain']['ny']} noktaya indir", m))
            m2 = json.loads(json.dumps(m))
            m2["domain"]["dx_km"] = min(50.0, round(b["domain"]["dx_km"] / f, 1))
            m2["time"]["time_step_s"] = max(1, int(round(6 * m2["domain"]["dx_km"])))
            if m2["domain"]["dx_km"] < 50.0 or f >= 0.3:
                tries.append((f"{pre}aynı alan için dx'i {m2['domain']['dx_km']:g} km yap ({m2['domain']['nx']} × {m2['domain']['ny']} nokta)", m2))
    for h in (n["time"]["hours"] // 2, n["time"]["hours"] // 4, 6):
        if 1 <= h < n["time"]["hours"]:
            m = json.loads(json.dumps(n))
            m["time"]["hours"] = h
            tries.append((f"süreyi {h} saate indir", m))
    tries.sort(key=lambda tm: -tm[1]["domain"]["nx"] * tm[1]["domain"]["ny"] * tm[1]["time"]["hours"] / tm[1]["domain"]["dx_km"] ** 0)
    for text, m in tries:
        if fits(m):
            return text
    return None


# ---- namelists
def wps_namelist(n, plan, geog_dir, start, gend):
    dom = n["domain"]
    proj, tl1, tl2 = projection(dom)
    max_dom = 2 if n["nest"] else 1
    ne = n["nest"] or {}
    def per(a, b):
        return f"{a}, {b}" if max_dom == 2 else f"{a}"
    return f"""&share
 wrf_core = 'ARW', max_dom = {max_dom},
 start_date = {per(repr(start), repr(start))}, end_date = {per(repr(gend), repr(gend))},
 interval_seconds = {plan['interval_h'] * 3600}, io_form_geogrid = 2,
/
&geogrid
 parent_id = {per(1, 1)}, parent_grid_ratio = {per(1, ne.get('ratio', 3))},
 i_parent_start = {per(1, ne.get('i0', 1))}, j_parent_start = {per(1, ne.get('j0', 1))},
 e_we = {per(dom['nx'] + 1, ne.get('nx', 0) * ne.get('ratio', 3) + 1)},
 e_sn = {per(dom['ny'] + 1, ne.get('ny', 0) * ne.get('ratio', 3) + 1)},
 geog_data_res = {per("'lowres'", "'lowres'")},
 dx = {dom['dx_m']}, dy = {dom['dx_m']}, map_proj = '{proj}',
 ref_lat = {dom['lat']}, ref_lon = {dom['lon']}, truelat1 = {tl1}, truelat2 = {tl2}, stand_lon = {dom['lon']},
 pole_lat = 90.0, pole_lon = 0.0,
 geog_data_path = '{geog_dir}',
/
&ungrib
 out_format = 'WPS', prefix = 'FILE',
/
&metgrid
 fg_name = 'FILE', io_form_metgrid = 2,
/
"""


def wrf_namelist(n, plan, start_dt, met=None):
    dom, tim = n["domain"], n["time"]
    met = met or {"levels": 34, "land_cat": 21, "soil": 4}
    max_dom = 2 if n["nest"] else 1
    ne = n["nest"] or {}
    end_dt = start_dt + timedelta(hours=plan["ghours"])
    stretch, maxdz = levels(dom["nz"] + 1, dom["ptop_hpa"])
    def per(a, b):
        return f"{a}, {b}" if max_dom == 2 else f"{a}"
    def per_all(v):
        return per(v, v)
    phys = n["physics"]["options"]
    lines = []
    for k, v in phys.items():
        if k == "physics_suite":
            lines.append(f" physics_suite = '{v}',")
        elif k in ("radt", "cudt", "bldt"):
            v2 = v if k != "radt" or max_dom == 1 else max(1, int(round(v / ne.get("ratio", 3))))
            lines.append(f" {k} = {per(v, v2)},")
        elif k == "cu_physics" and max_dom == 2 and n["domain"]["dx_km"] / ne.get("ratio", 3) < 4.5 and v != -1:
            lines.append(f" {k} = {per(v, 0)},")  # convection-permitting nest
        elif k in ("mp_physics", "cu_physics", "bl_pbl_physics", "sf_sfclay_physics", "sf_surface_physics",
                   "ra_lw_physics", "ra_sw_physics", "cu_rad_feedback", "icloud_bl"):
            lines.append(f" {k} = {per_all(v)},")
        else:
            lines.append(f" {k} = {v},")
    if "num_soil_layers" not in phys:
        sfc = phys.get("sf_surface_physics")
        if sfc == 1:
            lines.append(" num_soil_layers = 5,")
    lines.append(f" num_land_cat = {met['land_cat']}, sf_urban_physics = {per_all(0)},")
    if "fractional_seaice" not in phys:
        lines.append(" fractional_seaice = 1,")
    if phys.get("do_radar_ref") is None and phys.get("mp_physics") in (6, 8, 28):
        lines.append(" do_radar_ref = 1,")  # REFL_10CM for the radar layer
    physics_block = "\n".join(lines)
    dyn = n["dynamics"]
    dyn_lines = "\n".join(f" {k} = {per_all(v) if k in ('diff_opt', 'km_opt', 'diff_6th_opt', 'diff_6th_factor', 'zdamp', 'dampcoef', 'gwd_opt') else v}," for k, v in dyn.items())
    fd = n["fdda"]
    fdda_lines = ""
    if fd.get("grid_fdda"):
        fdda_lines = (f" grid_fdda = {per_all(1)}, gfdda_inname = 'wrffdda_d<domain>', gfdda_interval_m = {per_all(plan['interval_h'] * 60)},\n"
                      f" gfdda_end_h = {per_all(int(fd.get('gfdda_end_h', 24)))}, io_form_gfdda = 2,\n"
                      f" guv = {per_all(fd.get('guv', 0.0003))}, gt = {per_all(fd.get('gt', 0.0003))}, gq = {per_all(fd.get('gq', 0.0003))},\n"
                      f" if_no_pbl_nudging_uv = {per_all(0)}, if_no_pbl_nudging_t = {per_all(1)}, if_no_pbl_nudging_q = {per_all(1)},")
    adaptive = ""
    if tim["adaptive"]:
        adaptive = (f" use_adaptive_time_step = .true., step_to_output_time = .true., target_cfl = 1.2, target_hcfl = 0.84,\n"
                    f" max_step_increase_pct = 5, starting_time_step = {tim['time_step_s']}, max_time_step = {int(tim['time_step_s'] * 2)}, min_time_step = {max(1, int(tim['time_step_s'] / 2))},")
    sy = start_dt
    ey = end_dt
    return f""" &time_control
 run_days = 0, run_hours = {plan['ghours']}, run_minutes = 0, run_seconds = 0,
 start_year = {per_all(sy.year)}, start_month = {per_all(f'{sy.month:02d}')}, start_day = {per_all(f'{sy.day:02d}')}, start_hour = {per_all(f'{sy.hour:02d}')},
 end_year = {per_all(ey.year)}, end_month = {per_all(f'{ey.month:02d}')}, end_day = {per_all(f'{ey.day:02d}')}, end_hour = {per_all(f'{ey.hour:02d}')},
 interval_seconds = {plan['interval_h'] * 3600}, input_from_file = {per_all('.true.')},
 history_interval = {per_all(tim['output_min'])}, frames_per_outfile = {per_all(1)},
 restart = .false., restart_interval = 1000000,
 io_form_history = 2, io_form_restart = 2, io_form_input = 2, io_form_boundary = 2,
 /
 &domains
 time_step = {tim['time_step_s']}, time_step_fract_num = 0, time_step_fract_den = 1, max_dom = {max_dom},
{adaptive}
 e_we = {per(dom['nx'] + 1, ne.get('nx', 0) * ne.get('ratio', 3) + 1)}, e_sn = {per(dom['ny'] + 1, ne.get('ny', 0) * ne.get('ratio', 3) + 1)}, e_vert = {per_all(dom['nz'] + 1)},
 auto_levels_opt = 2, dzbot = 30., dzstretch_s = {stretch}, dzstretch_u = {stretch}, max_dz = {maxdz}., p_top_requested = {int(dom['ptop_hpa'] * 100)},
 num_metgrid_levels = {met['levels']}, num_metgrid_soil_levels = {met['soil']},
 dx = {per(dom['dx_m'], dom['dx_m'] / ne.get('ratio', 3))}, dy = {per(dom['dx_m'], dom['dx_m'] / ne.get('ratio', 3))},
 grid_id = {per(1, 2)}, parent_id = {per(0, 1)}, i_parent_start = {per(1, ne.get('i0', 1))}, j_parent_start = {per(1, ne.get('j0', 1))},
 parent_grid_ratio = {per(1, ne.get('ratio', 3))}, parent_time_step_ratio = {per(1, ne.get('ratio', 3))},
 feedback = {ne.get('feedback', 0)}, smooth_option = 0,
 /
 &physics
{physics_block}
 /
 &fdda
{fdda_lines}
 /
 &dynamics
 hybrid_opt = 2, base_temp = 290., khdif = {per_all(0)}, kvdif = {per_all(0)}, non_hydrostatic = {per_all('.true.')},
 moist_adv_opt = {per_all(1)}, scalar_adv_opt = {per_all(1)},
{dyn_lines}
 /
 &bdy_control
 spec_bdy_width = 5, specified = {per('.true.', '.false.')}, nested = {per('.false.', '.true.')},
 /
 &grib2
 /
 &namelist_quilt
 nio_tasks_per_group = 0, nio_groups = 1,
 /
"""


def translate(namelist_text, workdir):
    """Run the submodule's translator on a namelist; return (ok, [errors], text)."""
    os.makedirs(workdir, exist_ok=True)
    path = os.path.join(workdir, "namelist.input")
    with open(path, "w") as f:
        f.write(namelist_text)
    r = subprocess.run([sys.executable, "-I", TRANSLATOR, path, "-o", os.path.join(workdir, "run.ini"),
                        "--format", "wrfout"], capture_output=True, text=True, timeout=60)
    text = r.stdout + r.stderr
    errs = [l.strip() for l in text.splitlines() if "[ERROR]" in l]
    return r.returncode == 0, errs, text


OPTION_FIELD = {"mp_physics", "cu_physics", "bl_pbl_physics", "sf_sfclay_physics", "sf_surface_physics",
                "ra_lw_physics", "ra_sw_physics", "radt", "cudt", "bldt", "cu_rad_feedback", "icloud_bl", "ishallow",
                "do_radar_ref", "hail_opt", "icloud", "fractional_seaice"}


def translator_field(line):
    """The settings field a translator error is about ('physics.mp_physics'), or ''."""
    import re
    if "Time step" in line or "time_step /" in line:
        return "time.time_step_s"
    for m in re.finditer(r"\b([a-z_0-9]+)\s*=", line):
        k = m.group(1)
        if k in OPTION_FIELD:
            return f"physics.{k}"
        if k in ("diff_opt", "km_opt", "diff_6th_opt", "damp_opt", "w_damping", "gwd_opt", "zdamp", "dampcoef"):
            return f"dynamics.{k}"
        if k in ("grid_fdda", "guv", "gt", "gq", "gfdda_end_h"):
            return f"fdda.{k}"
        if k in ("time_step",):
            return "time.time_step_s"
        if k in ("use_adaptive_time_step",):
            return "time.adaptive"
        if k in ("max_dom", "feedback", "parent_grid_ratio"):
            return "nest"
    return ""


def tr_explain(line):
    l = line.replace("[ERROR]", "").strip()
    if "is not supported" in l or "not ported" in l:
        return "CPPWRF bu seçeneği desteklemiyor. " + l
    if "Time step too large" in l:
        return "Zaman adımı bu dx için çok büyük; daha küçük bir adım seçin. " + l
    if "nest" in l.lower():
        return "Bu seçenek iç alanla (nest) birlikte kullanılamıyor. " + l
    return "Çevirici bu ayar birleşimini kabul etmedi. " + l


def check(settings, system, workdir):
    p = Problems()
    n = normalise(settings, p)
    if n is None or p.errors:
        return {"ok": False, "errors": p.errors, "warnings": [], "level": "red"}, None, None
    dom, tim = n["domain"], n["time"]
    plan = gfs_plan(n)
    stretch, maxdz = levels(dom["nz"] + 1, dom["ptop_hpa"])
    if stretch is None:
        p.err("domain.nz", f"{dom['nz']} seviye {dom['ptop_hpa']:g} hPa tepeye ulaşamıyor; seviye sayısını artırın.")
    # CFL: a 100 m/s jet over dx, RK3 with 5th-order advection is stable up to about 1.4
    cfl = 100.0 * tim["time_step_s"] / (dom["dx_km"] * 1000)
    if not tim["adaptive"]:
        if cfl > 1.2:
            p.warn("time.time_step_s", f"Zaman adımı riskli: 100 m/s rüzgârda CFL ≈ {cfl:.2f}. Önerilen {tim['suggested_step_s']} sn.", "yellow")
        elif tim["time_step_s"] > 1.34 * tim["suggested_step_s"]:
            p.warn("time.time_step_s", f"Zaman adımı önerilenden büyük ({tim['suggested_step_s']} sn).", "yellow")
    if tim["adaptive"] and n["nest"]:
        p.err("time.adaptive", "Uyarlanır zaman adımı iç alanla (nest) kullanılamaz.")
    if tim["adaptive"] and n["fdda"].get("grid_fdda"):
        p.err("time.adaptive", "Uyarlanır zaman adımı nudging ile kullanılamaz.")
    if n["nest"] and n["physics"]["options"].get("sf_surface_physics") == 4:
        p.err("nest", "Noah-MP kara yüzeyi iç alanla (nest) kullanılamaz (WRF 4.8.0 de durur). Noah'yı seçin ya da iç alanı kaldırın.")
    if dom["dx_km"] < 4.5 and n["physics"]["options"].get("cu_physics") not in (None, 0, 3) and n["physics"]["preset"] != "conus":
        p.warn("physics.cu_physics", "4 km altında kümülüs parametrizasyonu genelde kapatılır.", "yellow")
    start = datetime.strptime(tim["cycle"], "%Y%m%d%H").replace(tzinfo=timezone.utc)
    if p.errors:
        return {"ok": False, "errors": p.errors, "warnings": p.warnings, "level": "red"}, n, plan
    nl = wrf_namelist(n, plan, start)
    ok, terrs, ttext = translate(nl, workdir)
    for e in terrs:
        p.err(translator_field(e), tr_explain(e))
    est = estimate(n, plan, system)
    others = {}
    for m in MODES:
        if m != n["mode"]:
            o = estimate(n, plan, system, m)
            others[m] = {"total_s": o["total_s"], "model_s": o["stages_s"]["model"], "gpu_mib": o["gpu_mib"]}
    level, warns = judge(n, est, system, others)
    p.warnings.extend(warns)
    fix = cheapest_fix(n, plan, system) if level == "red" else None
    proj, tl1, tl2 = projection(dom)
    finish = datetime.now(timezone.utc) + timedelta(seconds=est["total_s"])
    out = {
        "ok": not p.errors and level != "red",
        "level": "red" if p.errors else level,
        "errors": p.errors,
        "warnings": p.warnings,
        "fix": fix,
        "estimate": est,
        "other_modes": others,
        "finish_utc": finish.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "derived": {"projection": proj, "truelat1": tl1, "truelat2": tl2, "stretch": stretch, "max_dz": maxdz,
                    "time_step_s": tim["time_step_s"], "suggested_step_s": tim["suggested_step_s"], "cfl100": cfl,
                    "radt": n["physics"]["options"].get("radt"), "gfs": plan},
        "settings": n,
        "translator": ttext[-4000:] if terrs else "",
    }
    return out, n, plan


def met_info(wps_dir):
    import glob
    met = sorted(glob.glob(os.path.join(wps_dir, "met_em.d01.*")))
    if not met:
        return None
    out = subprocess.run(["ncdump", "-h", met[0]], capture_output=True, text=True).stdout
    import re
    def get(pat, default):
        m = re.search(pat, out)
        return int(m.group(1)) if m else default
    return {"levels": get(r"num_metgrid_levels = (\d+)", 34), "land_cat": get(r":NUM_LAND_CAT = (\d+)", 21),
            "soil": get(r"num_st_layers = (\d+)", 4)}


def main():
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        return 2
    cmd = sys.argv[1]
    if cmd == "options":
        json.dump(options_json(), sys.stdout, ensure_ascii=False)
        return 0
    if cmd in ("check", "setup"):
        with open(sys.argv[2]) as f:
            settings = json.load(f)
        with open(sys.argv[3]) as f:
            system = json.load(f)
        run = sys.argv[4] if cmd == "setup" else None
        work = os.path.join(run, "check") if run else tempfile.mkdtemp(prefix="check-", dir=os.path.join(ROOT, "build", "tmp"))
        try:
            out, n, plan = check(settings, system, work)
        finally:
            if not run:
                import shutil
                shutil.rmtree(work, ignore_errors=True)
        if run and out["ok"]:
            geog = os.environ.get("GEOG_DIR", os.path.expanduser("~/wrf_real/geog/WPS_GEOG_LOW_RES"))
            start = datetime.strptime(n["time"]["cycle"], "%Y%m%d%H").replace(tzinfo=timezone.utc)
            iso = lambda d: d.strftime("%Y-%m-%d_%H:%M:%S")
            gend = start + timedelta(hours=plan["ghours"])
            os.makedirs(os.path.join(run, "wps"), exist_ok=True)
            with open(os.path.join(run, "wps", "namelist.wps"), "w") as f:
                f.write(wps_namelist(n, plan, geog, iso(start), iso(gend)))
            with open(os.path.join(run, "plan.json"), "w") as f:
                json.dump(out, f, ensure_ascii=False, indent=1)
            s, nn, w, e = plan["region"]
            env = {"CYCLE": n["time"]["cycle"], "HOURS": n["time"]["hours"], "FHOURS": " ".join(str(h) for h in plan["fhours"]),
                   "REGION_S": s, "REGION_N": nn, "REGION_W": w, "REGION_E": e, "MODE": n["mode"],
                   "MAX_DOM": 2 if n["nest"] else 1, "RUN_SECONDS": n["time"]["hours"] * 3600,
                   "TIME_STEP": n["time"]["time_step_s"], "OUTPUT_MIN": n["time"]["output_min"],
                   "KEEP_PARTIAL": 1 if n["keep_partial"] else 0}
            with open(os.path.join(run, "plan.env"), "w") as f:
                for k, v in env.items():
                    f.write(f"{k}='{v}'\n")
        json.dump(out, sys.stdout, ensure_ascii=False)
        return 0 if out["ok"] else 1
    if cmd == "input":
        run = sys.argv[2]
        with open(os.path.join(run, "plan.json")) as f:
            plan_all = json.load(f)
        n = plan_all["settings"]
        plan = plan_all["derived"]["gfs"]
        met = met_info(os.path.join(run, "wps"))
        start = datetime.strptime(n["time"]["cycle"], "%Y%m%d%H").replace(tzinfo=timezone.utc)
        os.makedirs(os.path.join(run, "run"), exist_ok=True)
        with open(os.path.join(run, "run", "namelist.input"), "w") as f:
            f.write(wrf_namelist(n, plan, start, met))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main())
