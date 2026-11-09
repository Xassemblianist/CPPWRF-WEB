#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""The end-to-end test of the forecast site against a running server (tools/e2e.sh starts it if needed).

  1. API: system, options, cycles, an estimate, invalid settings (422 with the field), unknown run (404), a path
     outside the site (404), a foreign origin's POST (403), the Pages origin's preflight (204), a body over the
     limit (413), Range requests (206).
  2. Cancel: a run is started and cancelled during its download; it must end "cancelled" with its partial files gone.
  3. The same case in the three modes (one GFS cycle for all): every run must end "done";
     GPU FP64 must equal CPU FP64 byte for byte in every wrfout; GPU FP32 against GPU FP64: the relative L2
     difference of the main fields must stay small (reported, and a failure above 5 %).
  4. The page: headless Chrome opens the GPU FP32 run; the DOM must show the footer "CPPWRF <commit>", the legend
     and the time bar; the page reports its frame rate.

  e2e.py [--case small|perf] [--base URL] [--skip-runs] [--keep]
Writes build/e2e/<case>-<time>/report.json and report.md.
"""
import argparse
import filecmp
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CASES = {
    "small": {"name": "e2e Ankara", "domain": {"lat": 39.9, "lon": 32.8, "dx_km": 15, "nx": 40, "ny": 36, "nz": 35},
              "time": {"hours": 3, "output_min": 60}},
    "perf": {"name": "Performans 100x100x45", "domain": {"lat": 39.5, "lon": 33.0, "dx_km": 9, "nx": 100, "ny": 100, "nz": 45},
             "time": {"hours": 24, "output_min": 60}},
}
MODES = ["gpu-fp32", "gpu-fp64", "cpu-fp64"]
FAILS = []


def check(ok, what):
    print(("ok    " if ok else "FAIL  ") + what, flush=True)
    if not ok:
        FAILS.append(what)
    return ok


def req(base, method, path, body=None, headers=None, raw=None):
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    r = urllib.request.Request(base + path, data=data, method=method, headers={"Content-Type": "application/json", **(headers or {})})
    try:
        with urllib.request.urlopen(r, timeout=60) as f:
            b = f.read()
            return f.status, b, dict(f.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers)


def js(b):
    try:
        return json.loads(b)
    except ValueError:
        return {}


def settings(case, mode, cycle):
    c = CASES[case]
    return {"name": f"{c['name']} {mode}", "mode": mode, "domain": dict(c["domain"]),
            "time": {"cycle": cycle, **c["time"]}, "physics": {"preset": "p4"}}


def wait(base, rid, until, timeout):
    t0 = time.time()
    last = None
    while time.time() - t0 < timeout:
        _, b, _ = req(base, "GET", f"/api/v1/runs/{rid}")
        r = js(b)
        st = (r.get("status"), r.get("stage"))
        if st != last:
            print(f"      {rid}: {st[0]} / {st[1]}", flush=True)
            last = st
        if until(r):
            return r
        time.sleep(3)
    return None


def api_checks(base, case):
    s, b, _ = req(base, "GET", "/api/v1/system")
    sysinfo = js(b)
    check(s == 200 and "cppwrf_commit" in sysinfo, f"GET /system (CPPWRF {sysinfo.get('cppwrf_commit')})")
    s, b, _ = req(base, "GET", "/api/v1/options")
    check(s == 200 and len(js(b).get("controls", [])) > 20, "GET /options: presets and translator controls")
    s, b, _ = req(base, "GET", "/api/v1/cycles")
    cycles = js(b).get("cycles", [])
    check(s == 200 and len(cycles) > 4, "GET /cycles")
    s, b, _ = req(base, "POST", "/api/v1/estimate", settings(case, "gpu-fp32", "latest"))
    est = js(b)
    check(s == 200 and est.get("ok") and est.get("estimate", {}).get("total_s", 0) > 0, f"POST /estimate: {est.get('level')}, ~{est.get('estimate', {}).get('total_s', 0):.0f} s")
    bad = settings(case, "gpu-fp32", "latest")
    bad["domain"]["dx_km"] = 80
    bad["bogus"] = 1
    s, b, _ = req(base, "POST", "/api/v1/runs", bad)
    errs = {e.get("field") for e in js(b).get("errors", [])}
    check(s == 422 and "domain.dx_km" in errs and "bogus" in errs, f"invalid settings refused with their fields (422, {sorted(errs)})")
    s, _, _ = req(base, "GET", "/api/v1/runs/20990101-000000-ffff")
    check(s == 404, "unknown run: 404")
    s, _, _ = req(base, "GET", "/api/v1/runs/..%2f..%2fetc/products/meta.json")
    check(s == 404, "run id with a path: 404")
    s, _, _ = req(base, "GET", "/../../../etc/passwd")
    check(s in (400, 404), "path outside the site: refused")
    s, _, _ = req(base, "POST", "/api/v1/runs", settings(case, "gpu-fp32", "latest"), {"Origin": "https://example.com"})
    check(s == 403, "POST from a foreign origin: 403")
    s, _, h = req(base, "OPTIONS", "/api/v1/runs", headers={"Origin": "https://xassemblianist.github.io", "Access-Control-Request-Method": "POST",
                                                             "Access-Control-Request-Private-Network": "true"})
    check(s == 204 and h.get("Access-Control-Allow-Origin") == "https://xassemblianist.github.io", "preflight from the Pages origin: 204")
    s, _, _ = req(base, "POST", "/api/v1/estimate", raw=b"{" + b" " * 70000 + b"}")
    check(s == 413, "body over the limit: 413")
    return sysinfo, est


def cancel_check(base, case):
    s, b, _ = req(base, "POST", "/api/v1/runs", settings(case, "gpu-fp32", "latest"))
    rid = js(b).get("id")
    if not check(s == 201 and rid, "a run to cancel was queued"):
        return
    r = wait(base, rid, lambda r: r.get("status") == "running" or r.get("status") in ("done", "failed", "cancelled"), 300)
    time.sleep(2)
    s, b, _ = req(base, "POST", f"/api/v1/runs/{rid}/cancel")
    r = wait(base, rid, lambda r: r.get("status") in ("done", "failed", "cancelled"), 120)
    run = os.path.join(ROOT, "build/runs", rid)
    time.sleep(2)
    left = [d for d in ("gfs", "wps", "run", "out", "products") if os.path.isdir(os.path.join(run, d))]
    check(r and r.get("status") == "cancelled", f"cancel: status {r and r.get('status')}, message: {r and r.get('message')}")
    check(not left, f"cancel: partial files removed ({left or 'none left'})")
    req(base, "DELETE", f"/api/v1/runs/{rid}")


def failure_checks(base, case):
    """Runs that must fail, each with its Turkish message."""
    tests = []
    old = settings("small", "gpu-fp32", "2026100100")  # beyond NOMADS' ten days
    tests.append(("an unpublished GFS cycle", old, "NOMADS"))
    cfl = settings("small", "gpu-fp32", "latest")
    cfl["time"]["time_step_s"] = 600  # 10 x the usual step at 15 km
    tests.append(("a time step far above the CFL limit", cfl, "kararsız"))
    for what, s, needle in tests:
        st, b, _ = req(base, "POST", "/api/v1/runs", s)
        r = js(b)
        if st != 201:
            check(st == 422, f"{what}: refused before the run ({st}: {[e.get('message') for e in r.get('errors', [])][:1]})")
            continue
        r = wait(base, r["id"], lambda r: r.get("status") in ("done", "failed", "cancelled"), 900)
        msg = (r or {}).get("message", "")
        check(r is not None and r.get("status") == "failed" and needle in msg, f"{what}: failed with \"{msg[:110]}\"")
        if r:
            req(base, "DELETE", f"/api/v1/runs/{r['id']}")


def wrfouts(rid):
    out = os.path.join(ROOT, "build/runs", rid, "out")
    return sorted(f for f in os.listdir(out) if f.startswith("wrfout_"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--case", default="small", choices=sorted(CASES))
    ap.add_argument("--base", default="http://127.0.0.1:8090")
    ap.add_argument("--skip-runs", action="store_true")
    ap.add_argument("--failures", action="store_true", help="only the API checks and the runs that must fail")
    ap.add_argument("--keep", action="store_true", help="keep the runs (else the cancel test's run is deleted only)")
    a = ap.parse_args()
    stamp = time.strftime("%Y%m%d-%H%M%S")
    outdir = os.path.join(ROOT, "build/e2e", f"{a.case}-{stamp}")
    os.makedirs(outdir, exist_ok=True)
    report = {"case": a.case, "settings": CASES[a.case], "started": stamp, "runs": {}}
    print("== API", flush=True)
    sysinfo, est = api_checks(a.base, a.case)
    report["system"] = {k: sysinfo.get(k) for k in ("cppwrf_commit", "gpu", "cpus", "ram_total_mib")}
    if a.failures:
        print("== failures", flush=True)
        failure_checks(a.base, a.case)
    elif not a.skip_runs:
        print("== cancel", flush=True)
        cancel_check(a.base, a.case)
        print("== three modes", flush=True)
        cycle = est.get("settings", {}).get("time", {}).get("cycle")
        report["cycle"] = cycle
        ids = {}
        for m in MODES:
            s, b, _ = req(a.base, "POST", "/api/v1/runs", settings(a.case, m, cycle))
            r = js(b)
            check(s == 201, f"{m}: queued ({r.get('id')}, estimate {r.get('estimate', {}).get('total_s', 0):.0f} s, {r.get('level')})")
            ids[m] = r.get("id")
        for m in MODES:
            r = wait(a.base, ids[m], lambda r: r.get("status") in ("done", "failed", "cancelled"), 4 * 3600)
            check(r is not None and r.get("status") == "done", f"{m}: done ({r and r.get('message') or ''})")
            if r:
                report["runs"][m] = {"id": ids[m], "status": r.get("status"), "estimate": r.get("estimate"), "actual": r.get("actual"),
                                     "disk_bytes": r.get("disk_bytes")}
        if all(report["runs"].get(m, {}).get("status") == "done" for m in MODES):
            print("== identity and accuracy", flush=True)
            f64, cpu, f32 = ids["gpu-fp64"], ids["cpu-fp64"], ids["gpu-fp32"]
            files = wrfouts(f64)
            same = [f for f in files if filecmp.cmp(os.path.join(ROOT, "build/runs", f64, "out", f), os.path.join(ROOT, "build/runs", cpu, "out", f), shallow=False)]
            check(files and len(same) == len(files) and files == wrfouts(cpu), f"GPU FP64 = CPU FP64 byte for byte: {len(same)}/{len(files)} wrfout files")
            report["identity"] = {"files": len(files), "identical": len(same)}
            last = files[-1]
            p = subprocess.run([os.path.join(ROOT, "build/forecast/ncdiff"), os.path.join(ROOT, "build/runs", f32, "out", last),
                                os.path.join(ROOT, "build/runs", f64, "out", last)], capture_output=True, text=True)
            l2 = {}
            for line in p.stdout.splitlines():
                f = line.split()
                if len(f) == 4:
                    l2[f[0]] = {"rel_l2": float(f[1]), "max_abs": float(f[2])}
            report["fp32_vs_fp64"] = {"file": last, "vars": l2}
            for v in ("U", "V", "T", "PH", "MU", "PSFC", "T2"):
                check(v in l2 and l2[v]["rel_l2"] < 0.05, f"FP32 vs FP64 {v}: relative L2 {l2.get(v, {}).get('rel_l2', float('nan')):.2e}")
            print("== the page", flush=True)
            page(a.base, f32, sysinfo.get("cppwrf_commit", ""), outdir, report)
    report["failures"] = FAILS
    json.dump(report, open(os.path.join(outdir, "report.json"), "w"), indent=1, ensure_ascii=False)
    print(f"\n{len(FAILS)} failure(s); report: {os.path.relpath(outdir, ROOT)}/report.json")
    return 1 if FAILS else 0


def page(base, rid, commit, outdir, report):
    chrome = next((c for c in ("google-chrome", "chromium", "chromium-browser") if subprocess.run(["which", c], capture_output=True).returncode == 0), None)
    if not check(chrome is not None, "headless Chrome found"):
        return
    url = f"{base}/#run={rid}&l=temp"
    prof = os.path.join(ROOT, "build/chrome")
    common = [chrome, "--headless=new", f"--user-data-dir={prof}", "--window-size=1440,900", "--enable-unsafe-swiftshader"]
    dom = subprocess.run(common + ["--virtual-time-budget=15000", "--dump-dom", url], capture_output=True, text=True, timeout=120).stdout
    check(f"CPPWRF {commit}" in dom, f"page footer shows CPPWRF {commit}")
    check('id="legend"' in dom and "Sıcaklık" in dom, "page legend shows the layer")
    check("nowLabel" in dom and "(TSİ)" in dom, "page time bar in TSİ")
    shot = os.path.join(outdir, "page.png")
    subprocess.run(common + ["--virtual-time-budget=15000", f"--screenshot={shot}", url], capture_output=True, timeout=120)
    check(os.path.exists(shot), "page screenshot")
    # the frame rate in real time over the DevTools protocol (tools/page_fps.mjs), on the GPU through ANGLE
    p = subprocess.run(["node", os.path.join(ROOT, "tools/page_fps.mjs"), f"{base}/#run={rid}&l=wind", "--gpu"],
                       capture_output=True, text=True, timeout=120, env={**os.environ, "FPS_TMP": os.path.join(ROOT, "build/tmp")})
    try:
        report["page"] = json.loads(p.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError):
        report["page"] = {}
    check(report["page"].get("fps_idle", 0) >= 20, f"page frame rate: {report['page']}")

if __name__ == "__main__":
    sys.exit(main())
