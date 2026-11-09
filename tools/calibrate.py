#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The cost model of the local forecast (build/calibration.json), from measurements on this machine.

  calibrate.py run [--cycle YYYYMMDDHH]   two real-data cases (40 x 36 and 110 x 100 points, 15 km, 40 levels, 3 h of
                                          hourly GFS) through the whole pipeline, then the model alone in the three
                                          modes and with two radiation intervals; about 6-8 minutes
  calibrate.py add RUN_DIR                a finished run's actual numbers: kept in build/calibration_history.json,
                                          and the coefficients move towards them (forecast/server calls it)

What is fitted (forecast/prepare.py's estimate uses the same names):
  download  s = a * files + b * MB             ungrib   s = a * files + b * MB
  geogrid   s = a + b * cells2d                metgrid  s = files * (a + b * cells2d)
  real      s = a + b * cells3d * files        post     s = frames * (a + b * cells2d)
  model     s = steps * (a + b * cells3d) + radiation calls * c * cells3d      (per mode)
  memory    GPU MiB = a + b * cells3d, RAM MiB = a + b * cells3d                (per mode)
  disk      GFS MB per square degree per file, met_em bytes per cell2d per file, wrfinput bytes per cell3d,
            wrfout bytes per cell3d per frame (per mode), product bytes per cell2d per frame
"""
import glob
import json
import math
import os
import re
import subprocess
import sys
import time
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CAL = os.path.join(ROOT, "build", "calibration.json")
HIST = os.path.join(ROOT, "build", "calibration_history.json")
sys.path.insert(0, os.path.join(ROOT, "forecast"))
import prepare  # noqa: E402

MODES = {"gpu-fp32": "build/gpu-fp32/cppwrf", "gpu-fp64": "build/gpu-fp64/cppwrf", "cpu-fp64": "build/cpu-fp64/cppwrf"}


def fit2(x1, y1, x2, y2):
    """y = a + b x through two points (b >= 0, a >= 0)."""
    b = max(0.0, (y2 - y1) / (x2 - x1)) if x2 != x1 else 0.0
    return max(0.0, y1 - b * x1), b


def system():
    out = subprocess.run(["nvidia-smi", "--query-gpu=memory.total,memory.free", "--format=csv,noheader,nounits"],
                         capture_output=True, text=True).stdout.split(",")
    mem = {l.split(":")[0]: float(l.split()[1]) / 1024 for l in open("/proc/meminfo") if ":" in l}
    st = os.statvfs(ROOT)
    return {"gpu_ok": len(out) == 2, "gpu_total_mib": float(out[0]) if len(out) == 2 else 0,
            "gpu_free_mib": float(out[1]) if len(out) == 2 else 0, "ram_available_mib": mem.get("MemAvailable", 0),
            "disk_free_gb": st.f_bavail * st.f_frsize / 1e9}


def latest_cycle():
    try:
        with urllib.request.urlopen("http://127.0.0.1:8090/api/v1/cycles", timeout=30) as r:
            return json.load(r)["latest"]
    except Exception:
        return None


def times(run):
    t = {}
    for line in open(os.path.join(run, "times")):
        k, v = line.split()
        t[k] = float(v)
    return t


def model_once(run, mode, run_s, radt, tag):
    """The model alone on the run's inputs; stepping seconds, GPU MiB, RAM MiB, wrfout bytes per frame."""
    out = os.path.join(run, f"out_{tag}")
    subprocess.run(["rm", "-rf", out])
    os.makedirs(out)
    cmd = ["/usr/bin/time", "-f", "MAXRSS %M", os.path.join(ROOT, MODES[mode]), "run.ini", f"--set", f"output.dir={out}",
           "--set", f"run.run_time={run_s}", "--set", "restart.interval=0", "--set", f"phys.radt={radt}"]
    env = dict(os.environ, OMP_NUM_THREADS="6", CPPWRF_MEMINFO="1")
    r = subprocess.run(["nice", "-n", "10"] + cmd, cwd=os.path.join(run, "run"), capture_output=True, text=True, env=env)
    log = r.stdout + r.stderr
    if r.returncode != 0:
        raise RuntimeError(f"{mode} failed: {log[-800:]}")
    step = float(re.search(r"stepping ([0-9.]+) s", log).group(1))
    gpu = max([float(x) for x in re.findall(r"([0-9.]+) MiB used", log)] or [0])
    ram = float(re.search(r"MAXRSS (\d+)", log).group(1)) / 1024
    files = sorted(glob.glob(os.path.join(out, "wrfout_d01_*")))
    frame = os.path.getsize(files[-1]) if files else 0
    subprocess.run(["rm", "-rf", out])
    return {"stepping_s": step, "gpu_mib": gpu, "ram_mib": ram, "wrfout_frame_bytes": frame}


def prepare_case(nx, ny, cycle):
    run = os.path.join(ROOT, "build", "calib", f"c{nx}x{ny}")
    subprocess.run(["rm", "-rf", run])
    os.makedirs(os.path.join(run, "logs"))
    settings = {"domain": {"lat": 39.5, "lon": 33.0, "dx_km": 15, "nx": nx, "ny": ny, "nz": 40},
                "time": {"cycle": cycle, "hours": 3, "output_min": 60}, "physics": {"preset": "p4"}, "mode": "gpu-fp32"}
    sf, yf = os.path.join(run, "settings.json"), os.path.join(run, "system.json")
    json.dump(settings, open(sf, "w"))
    json.dump(system(), open(yf, "w"))
    r = subprocess.run([sys.executable, "-I", os.path.join(ROOT, "forecast", "prepare.py"), "setup", sf, yf, run],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stdout[-1500:] + r.stderr[-1500:])
    t0 = time.time()
    p = subprocess.run(["bash", os.path.join(ROOT, "forecast", "pipeline.sh"), run], capture_output=True, text=True)
    state = open(os.path.join(run, "state")).read().strip()
    if state != "done":
        raise RuntimeError(f"pipeline {nx}x{ny}: {state}")
    plan = json.load(open(os.path.join(run, "plan.json")))
    return run, plan, time.time() - t0


def cmd_run(args):
    cycle = args[args.index("--cycle") + 1] if "--cycle" in args else latest_cycle()
    if not cycle:
        print("calibrate: no GFS cycle (start the server, or pass --cycle)", file=sys.stderr)
        return 1
    st = os.statvfs(ROOT)
    if st.f_bavail * st.f_frsize / 1e9 < 17:
        print("calibrate: less than 17 GB free", file=sys.stderr)
        return 1
    cases = []
    for nx, ny in ((40, 36), (110, 100)):
        print(f"calibrate: case {nx} x {ny} (pipeline) ...", flush=True)
        run, plan, wall = prepare_case(nx, ny, cycle)
        t = times(run)
        nfiles = len(plan["derived"]["gfs"]["fhours"])
        c2 = nx * ny
        c3 = c2 * 40
        gfs_mb = int(open(os.path.join(run, "gfs_bytes")).read()) / 1e6
        area = prepare.region_deg2(plan["derived"]["gfs"]["region"])
        wps_bytes = int(open(os.path.join(run, "wps_bytes")).read())
        inp = sum(os.path.getsize(f) for f in glob.glob(os.path.join(run, "run", "wrf*_d0*")))
        frames = len(glob.glob(os.path.join(run, "products", "frame_*.bin")))
        prod = sum(os.path.getsize(f) for f in glob.glob(os.path.join(run, "products", "*")))
        # post-processing alone
        t0 = time.time()
        subprocess.run([os.path.join(ROOT, "build/forecast/wrfpost"), os.path.join(run, "out"), os.path.join(run, "products2")],
                       capture_output=True)
        post = time.time() - t0
        subprocess.run(["rm", "-rf", os.path.join(run, "products2")])
        case = {"nx": nx, "ny": ny, "cells2d": c2, "cells3d": c3, "files": nfiles, "gfs_mb": gfs_mb, "area": area,
                "times": t, "wps_bytes": wps_bytes, "input_bytes": inp, "frames": frames, "product_bytes": prod,
                "post_s": post, "dt": plan["derived"]["time_step_s"], "modes": {}}
        for mode in MODES:
            for radt in ((15, 5) if (nx, ny) == (110, 100) else (15,)):
                print(f"calibrate: {nx} x {ny} {mode} radt {radt} ...", flush=True)
                case["modes"][f"{mode}/{radt}"] = model_once(run, mode, 3600, radt, f"{mode}_{radt}")
        cases.append(case)
        subprocess.run(["rm", "-rf", os.path.join(run, "out"), os.path.join(run, "wps")])
    a, b = cases
    cal = {"source": f"kalibrasyon {time.strftime('%Y-%m-%d')} ({system_name()})", "stages": {}, "modes": {}, "cases": cases}
    s = cal["stages"]
    # download and ungrib: s = x * files + y * MB (both cases have the same number of files)
    def files_mb(key):
        ta, tb = a["times"][key], b["times"][key]
        y = max(0.0, (tb - ta) / (b["gfs_mb"] - a["gfs_mb"])) if b["gfs_mb"] != a["gfs_mb"] else 0.0
        x = max(0.0, (ta - y * a["gfs_mb"]) / a["files"])
        return x, y
    s["download_s_per_file"], s["download_s_per_mb"] = files_mb("download")
    s["ungrib_s_per_file"], s["ungrib_s_per_mb"] = files_mb("ungrib")
    s["gfs_mb_per_deg2"] = (a["gfs_mb"] / a["area"] + b["gfs_mb"] / b["area"]) / 2 / a["files"]
    s["geogrid_s"], s["geogrid_s_per_cell2d"] = fit2(a["cells2d"], a["times"]["geogrid"], b["cells2d"], b["times"]["geogrid"])
    m1, m2 = fit2(a["cells2d"], a["times"]["metgrid"] / a["files"], b["cells2d"], b["times"]["metgrid"] / b["files"])
    s["metgrid_s_per_file"], s["metgrid_s_per_cell2d_file"] = m1, m2
    s["real_s"], s["real_s_per_cell3d_file"] = fit2(a["cells3d"] * a["files"], a["times"]["real"], b["cells3d"] * b["files"], b["times"]["real"])
    p1, p2 = fit2(a["cells2d"], a["post_s"] / max(1, a["frames"]), b["cells2d"], b["post_s"] / max(1, b["frames"]))
    s["post_s_per_frame"], s["post_s_per_cell2d_frame"] = p1, p2
    s["met_em_bytes_per_cell2d_file"] = b["wps_bytes"] / (b["cells2d"] * b["files"])
    s["wrfinput_bytes_per_cell3d"] = b["input_bytes"] / b["cells3d"] / 2
    s["products_bytes_per_cell2d_frame"] = b["product_bytes"] / (b["cells2d"] * max(1, b["frames"])) / 4
    for mode in MODES:
        steps_a, steps_b = 3600 / a["dt"], 3600 / b["dt"]
        ta, tb15, tb5 = a["modes"][f"{mode}/15"]["stepping_s"], b["modes"][f"{mode}/15"]["stepping_s"], b["modes"][f"{mode}/5"]["stepping_s"]
        rad = max(0.0, (tb5 - tb15) / ((12 - 4) * b["cells3d"]))  # 1 h: 12 radiation calls with radt 5, 4 with 15
        sa = (ta - 4 * rad * a["cells3d"]) / steps_a
        sb = (tb15 - 4 * rad * b["cells3d"]) / steps_b
        x, y = fit2(a["cells3d"], sa, b["cells3d"], sb)
        ga, gb = fit2(a["cells3d"], a["modes"][f"{mode}/15"]["gpu_mib"], b["cells3d"], b["modes"][f"{mode}/15"]["gpu_mib"])
        ra, rb = fit2(a["cells3d"], a["modes"][f"{mode}/15"]["ram_mib"], b["cells3d"], b["modes"][f"{mode}/15"]["ram_mib"])
        cal["modes"][mode] = {"step_s": x, "step_s_per_cell3d": y, "rad_s_per_cell3d": rad,
                              "mem_mib": ga if mode.startswith("gpu") else 0, "mem_mib_per_cell3d": gb if mode.startswith("gpu") else 0,
                              "ram_mib": ra, "ram_mib_per_cell3d": rb,
                              "wrfout_bytes_per_cell3d_frame": b["modes"][f"{mode}/15"]["wrfout_frame_bytes"] / b["cells3d"]}
    json.dump(cal, open(CAL, "w"), indent=1)
    subprocess.run(["rm", "-rf", os.path.join(ROOT, "build", "calib")])
    print(json.dumps({k: v for k, v in cal.items() if k != "cases"}, indent=1))
    return 0


def system_name():
    out = subprocess.run(["nvidia-smi", "--query-gpu=name", "--format=csv,noheader"], capture_output=True, text=True).stdout.strip()
    return out.replace("NVIDIA GeForce ", "") or "CPU"


def refit_memory(cal, mode, runs_dir):
    """GPU memory = a + b * cells + c * boundary points x input times, least squares over the finished runs on disk.

    The boundary term matters: every wrfbdy time is held on the device, so a 24 h run of a grid needs more than a
    3 h run of it. With fewer than four runs, or grids too alike, only a + b * cells is fitted (at least two grids
    20 % apart); with fewer than two, nothing changes."""
    pts = []
    for d in os.listdir(runs_dir):
        try:
            r = json.load(open(os.path.join(runs_dir, d, "run.json")))
        except (OSError, ValueError):
            continue
        s, gpu = r.get("settings", {}), r.get("actual", {}).get("gpu_mib")
        if r.get("status") != "done" or s.get("mode") != mode or not gpu or s.get("nest"):
            continue
        dm, nt = s["domain"], len(r.get("derived", {}).get("gfs", {}).get("fhours", []))
        pts.append((dm["nx"] * dm["ny"] * dm["nz"], 2 * (dm["nx"] + dm["ny"]) * dm["nz"] * nt, gpu))
    if len(pts) < 2 or max(p[0] for p in pts) < 1.2 * min(p[0] for p in pts):
        return
    import numpy as np
    X = np.array([[1.0, p[0], p[1]] for p in pts])
    y = np.array([p[2] for p in pts], dtype=float)
    coef = None
    if len(pts) >= 4:
        c, *_ = np.linalg.lstsq(X, y, rcond=None)
        if (c > 0).all():
            coef = c
    if coef is None:
        c, *_ = np.linalg.lstsq(X[:, :2], y, rcond=None)
        if (c > 0).all():
            coef = np.array([c[0], c[1], 0.0])
    if coef is not None:
        m = cal["modes"][mode]
        m["mem_mib"], m["mem_mib_per_cell3d"], m["mem_mib_per_bdy"] = float(coef[0]), float(coef[1]), float(coef[2])
        m["mem_fit_runs"] = len(pts)


def cmd_add(run):
    """Move the time coefficients towards a finished run's numbers (log-space moving average, weight 0.3); refit GPU memory."""
    r = json.load(open(os.path.join(run, "run.json")))
    est, act = r.get("estimate", {}), r.get("actual", {})
    if not est or not act.get("stages_s"):
        return 0
    hist = []
    if os.path.exists(HIST):
        hist = json.load(open(HIST))
    hist.append({"id": r["id"], "mode": r["settings"]["mode"], "cells3d": est.get("cells3d"),
                 "estimate": est.get("stages_s"), "actual": act.get("stages_s"), "gpu_est": est.get("gpu_mib"),
                 "gpu_act": act.get("gpu_mib")})
    json.dump(hist[-200:], open(HIST, "w"))
    if not os.path.exists(CAL):
        return 0
    cal = json.load(open(CAL))
    w = 0.3
    keys = {"download": ["download_s_per_file", "download_s_per_mb"], "geogrid": ["geogrid_s", "geogrid_s_per_cell2d"],
            "ungrib": ["ungrib_s_per_file", "ungrib_s_per_mb"], "metgrid": ["metgrid_s_per_file", "metgrid_s_per_cell2d_file"],
            "real": ["real_s", "real_s_per_cell3d_file"], "post": ["post_s_per_frame", "post_s_per_cell2d_frame"]}
    for stage, ks in keys.items():
        e, a = est["stages_s"].get(stage), act["stages_s"].get(stage)
        if e and a is not None and e > 0.5 and a > 0.5:
            f = math.exp(w * math.log(a / e))
            for k in ks:
                cal["stages"][k] *= f
    mode = r["settings"]["mode"]
    e, a = est["stages_s"].get("model"), act["stages_s"].get("model")
    if e and a and e > 1 and a > 1 and mode in cal["modes"]:
        f = math.exp(w * math.log(a / e))
        for k in ("step_s", "step_s_per_cell3d", "rad_s_per_cell3d"):
            cal["modes"][mode][k] *= f
    if mode.startswith("gpu"):
        refit_memory(cal, mode, os.path.dirname(os.path.abspath(run)))
    cal["updated_from"] = cal.get("updated_from", 0) + 1
    json.dump(cal, open(CAL, "w"), indent=1)
    return 0


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "run":
        sys.exit(cmd_run(sys.argv[2:]))
    if len(sys.argv) == 3 and sys.argv[1] == "add":
        sys.exit(cmd_add(sys.argv[2]))
    print(__doc__, file=sys.stderr)
    sys.exit(2)
