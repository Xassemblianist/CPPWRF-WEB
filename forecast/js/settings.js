// SPDX-License-Identifier: GPL-3.0-or-later
// "Yeni tahmin": the region on the map, time, nest, physics (presets and every option CPPWRF's translator supports),
// the mode, and the estimate the server computes for these settings on this machine (POST /api/v1/estimate).
import { $, h, t, api, num, int, fmtDur, fmtBytes, fmtCycle, fmtClock, prefs, toast } from "./util.js";

const STAGE_COLORS = { download: "#4f86c6", geogrid: "#5fa8a0", ungrib: "#78b36a", metgrid: "#a7b85a", real: "#d1a23f", model: "#e0703a", post: "#b65aa8" };
const DEFAULTS = {
  name: "", mode: "gpu-fp32", keep_partial: false,
  domain: { lat: 39.0, lon: 35.0, dx_km: 12, nx: 100, ny: 80, nz: 45, ptop_hpa: 50, projection: "auto" },
  time: { cycle: "latest", hours: 24, output_min: 60, adaptive: false },
  nest: null,
  physics: { preset: "p4" }, dynamics: {}, fdda: {},
};
const clone = (o) => JSON.parse(JSON.stringify(o));

export class Settings {
  constructor(app) {
    this.app = app;
    this.pane = $("pane-new");
    this.s = clone(prefs.get("settings", DEFAULTS));
    for (const k of Object.keys(DEFAULTS)) if (this.s[k] === undefined) this.s[k] = clone(DEFAULTS[k]);
    this.result = null;
    this.drawNest = false;
  }

  async init(options, cycles) {
    this.options = options;
    this.cycles = cycles || [];
    this.render();
    this.estimate();
  }

  // ---- the settings from outside (the library's "run again" / "change and run")
  load(settings) {
    const s = clone(settings);
    if (s.time) { delete s.time.suggested_step_s; }
    if (s.domain) delete s.domain.dx_m;
    if (s.physics?.options) {
      const pre = this.preset(s.physics.preset), base = this.presetValues(pre);
      const own = {};
      for (const [k, v] of Object.entries(s.physics.options)) if (base[k] !== v) own[k] = v;
      s.physics = { preset: s.physics.preset, ...own };
    }
    this.s = { ...clone(DEFAULTS), ...s };
    this.render();
    this.estimate();
  }

  preset(id) { return this.options.presets.find((p) => p.id === id) || this.options.presets[0]; }
  presetValues(pre) {
    const ph = { ...pre.physics };
    if (ph.physics_suite) { Object.assign(ph, this.options.suites[ph.physics_suite.toLowerCase()] || {}); delete ph.physics_suite; }
    return ph;
  }

  // ---- the form
  field(path, labelKey, input, { tip, sub } = {}) {
    return h("label", { class: "fld", "data-field": path, "data-tip": tip ? "" : null, title: tip || null }, h("span", {}, t(labelKey)), input,
      sub ? h("span", { class: "sub" }, sub) : null);
  }
  numInput(path, { step = 1, min, max } = {}) {
    const [a, b] = path.split(".");
    const v = this.s[a]?.[b];
    return h("input", {
      type: "number", inputmode: "decimal", step, min, max, value: v ?? "",
      oninput: (e) => { const x = e.target.value === "" ? undefined : Number(e.target.value); if (x === undefined) delete this.s[a][b]; else this.s[a][b] = x; this.changed(); },
    });
  }
  render() {
    const p = this.pane;
    p.replaceChildren();
    if (!api.online) {
      p.append(h("div", { class: "notice" }, h("b", {}, t("offline.title")), h("p", {}, t("offline.body")),
        h("pre", { class: "code" }, "git clone --recursive https://github.com/Xassemblianist/CPPWRF-WEB\ncd CPPWRF-WEB\ntools/build_all.sh\nbuild/forecast/cppwrf-forecast --port 8090"),
        h("p", {}, t("offline.samples")), h("button", { class: "btn", onclick: () => this.app.showTab("runs") }, t("tab.runs"))));
      return;
    }
    const s = this.s, d = s.domain, tm = s.time;
    // region
    p.append(h("h3", {}, t("sec.region")), h("p", { class: "hint" }, t(this.drawNest ? "region.hint_nest" : "region.hint")));
    const projAuto = Math.abs(d.lat) < 20 ? "mercator" : Math.abs(d.lat) > 65 ? "polar" : "lambert";
    p.append(h("div", { class: "grid2" },
      this.field("domain.lat", "f.lat", this.numInput("domain.lat", { step: 0.1, min: -89, max: 89 })),
      this.field("domain.lon", "f.lon", this.numInput("domain.lon", { step: 0.1, min: -180, max: 180 })),
      this.field("domain.dx_km", "f.dx", this.numInput("domain.dx_km", { step: 0.5, min: 1, max: 50 })),
      this.field("domain.nz", "f.nz", this.numInput("domain.nz", { min: 30, max: 100 })),
      this.field("domain.nx", "f.nx", this.numInput("domain.nx", { min: 20, max: 1000 })),
      this.field("domain.ny", "f.ny", this.numInput("domain.ny", { min: 20, max: 1000 })),
      this.field("domain.projection", "f.proj", h("select", { onchange: (e) => { d.projection = e.target.value; this.changed(); } },
        ["auto", "lambert", "mercator", "polar"].map((v) => h("option", { value: v, selected: d.projection === v },
          v === "auto" ? t("f.proj.auto", { p: t(`f.proj.${projAuto}`) }) : t(`f.proj.${v}`))))),
      this.field("domain.ptop_hpa", "f.ptop", this.numInput("domain.ptop_hpa", { min: 10, max: 200 })),
    ));
    this.areaEl = h("p", { class: "hint", id: "areaLine" });
    p.append(this.areaEl);
    // time
    p.append(h("h3", {}, t("sec.time")));
    const cyc = h("select", { onchange: (e) => { tm.cycle = e.target.value; this.changed(); } },
      h("option", { value: "latest", selected: tm.cycle === "latest" }, t("f.cycle.latest")),
      this.cycles.map((c) => h("option", { value: c, selected: tm.cycle === c }, fmtCycle(c))));
    const outs = [10, 15, 20, 30, 60, 120, 180, 360];
    p.append(h("div", { class: "grid2" },
      h("div", { style: "grid-column: 1 / -1" }, this.field("time.cycle", "f.cycle", cyc)),
      this.field("time.hours", "f.hours", this.numInput("time.hours", { min: 1, max: 384 }), { sub: t("f.input_interval", { h: (tm.hours ?? 24) <= 120 ? 1 : 3 }) }),
      this.field("time.output_min", "f.output", h("select", { onchange: (e) => { tm.output_min = Number(e.target.value); this.changed(); } },
        outs.map((m) => h("option", { value: m, selected: tm.output_min === m }, m < 60 ? `${m} dk` : `${m / 60} sa`)))),
      this.field("time.time_step_s", "f.step", this.numInput("time.time_step_s", { min: 1, max: 600 }),
        { sub: t("f.step.suggest", { s: this.result?.derived?.suggested_step_s ?? Math.max(1, Math.round(6 * (d.dx_km || 12))) }) }),
      h("label", { class: "check", title: t("f.adaptive.tip") },
        h("input", { type: "checkbox", checked: tm.adaptive, disabled: !!s.nest, onchange: (e) => { tm.adaptive = e.target.checked; this.changed(); } }), t("f.adaptive")),
    ));
    // nest
    p.append(h("h3", {}, t("sec.nest")));
    if (!s.nest) {
      p.append(h("button", { class: "btn", onclick: () => this.addNest() }, t("f.nest.add")));
    } else {
      const ne = s.nest;
      p.append(h("div", { "data-field": "nest", class: "fld" },
        h("p", { class: "hint" }, t("f.nest.box", { i: ne.i0, j: ne.j0, nx: ne.nx, ny: ne.ny })),
        h("div", { class: "row" },
          h("span", {}, t("f.nest.ratio")),
          h("div", { class: "chips" }, [3, 5].map((r) => h("button", { class: "chip", "aria-pressed": String(ne.ratio === r), onclick: () => { ne.ratio = r; this.render(); this.changed(); } }, `1:${r}`))),
          h("span", {}, t("f.nest.feedback")),
          h("select", { onchange: (e) => { ne.feedback = Number(e.target.value); this.changed(); } },
            h("option", { value: 1, selected: ne.feedback !== 0 }, t("f.nest.twoway")), h("option", { value: 0, selected: ne.feedback === 0 }, t("f.nest.oneway")))),
        h("div", { class: "row", style: "margin-top:6px" },
          h("button", { class: "btn", "aria-pressed": String(this.drawNest), onclick: () => { this.drawNest = !this.drawNest; this.render(); } }, t("region.hint_nest").split(";")[0].split(".")[0]),
          h("button", { class: "btn danger", onclick: () => { s.nest = null; this.drawNest = false; this.render(); this.changed(); } }, t("f.nest.remove")))));
    }
    // physics
    p.append(h("h3", {}, t("sec.physics")));
    const pre = this.preset(s.physics.preset);
    p.append(this.field("physics.preset", "f.preset", h("select", { onchange: (e) => { this.s.physics = { preset: e.target.value }; this.render(); this.changed(); } },
      this.options.presets.map((x) => h("option", { value: x.id, selected: x.id === pre.id }, x.name)))));
    p.append(h("p", { class: "hint" }, pre.desc));
    p.append(this.advanced(pre));
    // mode
    p.append(h("h3", {}, t("sec.mode")));
    const sys = this.app.system;
    this.modeEls = {};
    p.append(h("div", { class: "modes", "data-field": "mode" }, this.options.modes.map((m) => {
      const ok = sys?.builds?.[m]?.present && (m === "cpu-fp64" || sys?.gpu?.ok);
      const b = h("button", { class: "mode", "aria-pressed": String(s.mode === m), disabled: !ok, onclick: () => { s.mode = m; this.render(); this.changed(); } },
        h("b", {}, t(`mode.${m}`)), h("small", {}, t(`mode.${m}.d`)), h("span", { class: "t" }, "–"));
      this.modeEls[m] = b;
      return b;
    })));
    p.append(h("label", { class: "check" }, h("input", { type: "checkbox", checked: s.keep_partial, onchange: (e) => { s.keep_partial = e.target.checked; this.changed(); } }), t("f.keep_partial")));
    // estimate and the button
    p.append(h("h3", {}, t("sec.estimate")));
    this.estEl = h("div", { id: "est" }, h("div", { class: "body" }, t("est.checking")));
    p.append(this.estEl);
    this.goBtn = h("button", { class: "btn primary", onclick: () => this.submit() }, t("run.start"));
    p.append(h("div", { class: "go" }, this.goBtn));
    this.showArea();
    if (this.result) this.show(this.result);
    this.app.drawDomain?.();
  }

  // every option of the translator, grouped, with the preset's values filled in
  advanced(pre) {
    const base = this.presetValues(pre);
    const det = h("details", { class: "adv", open: prefs.get("advOpen", false) ? true : null, ontoggle: (e) => prefs.set("advOpen", e.target.open) },
      h("summary", { title: t("f.advanced.tip") }, t("f.advanced")));
    let group = null;
    for (const c of this.options.controls) {
      if (c.group !== group) { group = c.group; det.append(h("div", { class: "grp" }, group)); }
      const rec = c.record;  // physics, dynamics, fdda
      const own = rec === "physics" ? this.s.physics : this.s[rec];
      const cur = own[c.name] ?? (rec === "physics" ? base[c.name] : undefined) ?? c.default;
      const path = `${rec}.${c.name}`;
      const set = (v) => { if (v === undefined || (rec === "physics" && base[c.name] === v)) delete own[c.name]; else own[c.name] = v; this.changed(); };
      let input;
      if (c.kind === "enum") {
        input = h("select", { onchange: (e) => set(e.target.value === "" ? undefined : Number(e.target.value)) },
          cur == null ? h("option", { value: "", selected: true }, "–") : null,
          c.values.map((v) => h("option", { value: v.value, selected: v.value === cur }, `${v.value}: ${v.label}`)));
      } else {
        input = h("input", { type: "number", step: c.kind === "int" ? 1 : "any", min: c.range?.[0], max: c.range?.[1], value: cur ?? "",
          oninput: (e) => set(e.target.value === "" ? undefined : Number(e.target.value)) });
      }
      det.append(h("label", { class: "fld", "data-field": path, title: c.tip || null, "data-tip": c.tip ? "" : null, style: "margin-bottom:6px" },
        h("span", {}, `${c.label} (${c.name})`), input));
    }
    return det;
  }

  addNest() {
    const d = this.s.domain;
    const nx = Math.max(10, Math.round(d.nx / 3)), ny = Math.max(10, Math.round(d.ny / 3));
    this.s.nest = { i0: Math.round((d.nx - nx) / 2), j0: Math.round((d.ny - ny) / 2), nx, ny, ratio: 3, feedback: 1 };
    this.s.time.adaptive = false;
    this.drawNest = true;
    this.render();
    this.changed();
  }

  showArea() {
    const d = this.s.domain;
    if (!this.areaEl) return;
    const w = d.nx * d.dx_km, hh = d.ny * d.dx_km;
    this.areaEl.textContent = `${t("f.area")}: ${int(w)} × ${int(hh)} km · ${t("est.cells")}: ${int(d.nx * d.ny * d.nz)}`;
  }

  // the map: a click moves the centre; a Shift-drag draws the domain (or the nest)
  click(lat, lon) {
    if (!api.online || this.app.tab !== "new") return false;
    if (this.drawNest) return false;
    this.s.domain.lat = Math.round(lat * 100) / 100;
    this.s.domain.lon = Math.round(lon * 100) / 100;
    this.render();
    this.changed();
    return true;
  }
  rect(lat0, lon0, lat1, lon1) {
    if (!api.online) return;
    const d = this.s.domain;
    if (this.drawNest && this.s.nest) {
      // parent cells from the approximate box of the parent
      const b = this.box();
      const fx = (lon) => (lon - b.lon0) / (b.lon1 - b.lon0) * d.nx, fy = (lat) => (lat - b.lat0) / (b.lat1 - b.lat0) * d.ny;
      const i0 = Math.max(6, Math.round(fx(lon0))), j0 = Math.max(6, Math.round(fy(lat0)));
      const i1 = Math.min(d.nx - 5, Math.round(fx(lon1))), j1 = Math.min(d.ny - 5, Math.round(fy(lat1)));
      Object.assign(this.s.nest, { i0, j0, nx: Math.max(10, i1 - i0), ny: Math.max(10, j1 - j0) });
    } else {
      d.lat = Math.round((lat0 + lat1) / 2 * 100) / 100;
      d.lon = Math.round((lon0 + lon1) / 2 * 100) / 100;
      const km = 111.2;
      d.nx = Math.max(20, Math.round((lon1 - lon0) * km * Math.cos(d.lat * Math.PI / 180) / d.dx_km));
      d.ny = Math.max(20, Math.round((lat1 - lat0) * km / d.dx_km));
    }
    this.render();
    this.changed();
  }
  // the domain's approximate latitude-longitude box (the exact outline comes with the products)
  box() {
    const d = this.s.domain, km = 111.2;
    const hw = d.nx * d.dx_km / 2 / (km * Math.max(0.05, Math.cos(d.lat * Math.PI / 180))), hh = d.ny * d.dx_km / 2 / km;
    return { lat0: d.lat - hh, lat1: d.lat + hh, lon0: d.lon - hw, lon1: d.lon + hw };
  }
  nestBox() {
    const ne = this.s.nest;
    if (!ne) return null;
    const b = this.box(), d = this.s.domain;
    const x = (i) => b.lon0 + (b.lon1 - b.lon0) * i / d.nx, y = (j) => b.lat0 + (b.lat1 - b.lat0) * j / d.ny;
    return { lat0: y(ne.j0 - 1), lat1: y(ne.j0 - 1 + ne.ny), lon0: x(ne.i0 - 1), lon1: x(ne.i0 - 1 + ne.nx) };
  }

  changed() {
    prefs.set("settings", this.s);
    this.showArea();
    this.app.drawDomain?.();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.estimate(), 350);
  }

  async estimate() {
    if (!api.online) return;
    const seq = (this.seq = (this.seq || 0) + 1);
    let r;
    try { r = await api.send("POST", "/api/v1/estimate", this.s); } catch { return; }
    if (seq !== this.seq) return;  // a newer request is on its way
    this.result = r.json;
    this.show(r.json);
  }

  // the estimate panel and the errors next to their controls
  show(e) {
    const p = this.pane;
    p.querySelectorAll(".fld.bad").forEach((x) => x.classList.remove("bad"));
    p.querySelectorAll(".fld .err").forEach((x) => x.remove());
    const general = [];
    for (const er of e.errors || []) {
      let el = er.field && p.querySelector(`[data-field="${CSS.escape(er.field)}"]`);
      if (!el && er.field) el = p.querySelector(`[data-field="${CSS.escape(er.field.split(".")[0])}"]`);
      if (el) {
        el.classList.add("bad");
        el.append(h("span", { class: "err" }, er.message));
        const det = el.closest("details");
        if (det) det.open = true;
      } else general.push(er.message);
    }
    const est = e.estimate, level = e.level || "red";
    const el = this.estEl;
    el.className = level;
    el.replaceChildren();
    el.append(h("div", { class: "head" }, h("i", { class: "lvl" }), t(`est.level.${level}`),
      h("span", { class: "tot" }, est ? fmtDur(est.total_s) : "–")));
    const body = h("div", { class: "body" });
    if (est) {
      const st = Object.fromEntries(Object.keys(STAGE_COLORS).filter((k) => k in est.stages_s).map((k) => [k, est.stages_s[k]])), tot = Object.values(st).reduce((a, b) => a + b, 0) || 1;
      body.append(h("div", { class: "bars", role: "img", "aria-label": t("est.total") },
        Object.entries(st).map(([k, v]) => h("span", { style: `width:${100 * v / tot}%;background:${STAGE_COLORS[k]}`, title: `${t(`stage.${k}`)} ${fmtDur(v)}` }))));
      const sys = this.app.system || {};
      const gpuTot = sys.gpu?.total_mib || 0, gpuPct = gpuTot ? est.gpu_mib / gpuTot : 0;
      const ramPct = sys.ram_available_mib ? est.ram_mib / sys.ram_available_mib : 0;
      const diskFree = (sys.disk_free_gb || 0) * 1e9 - (sys.disk_floor_gb || 15) * 1e9, diskPct = diskFree > 0 ? est.disk_peak_bytes / diskFree : 1;
      const meter = (f) => h("div", { class: `meter${f > 1 ? " over" : f > 0.7 ? " hot" : ""}` }, h("i", { style: `width:${Math.min(100, 100 * f)}%` }));
      body.append(h("table", {},
        Object.entries(st).map(([k, v]) => h("tr", {}, h("td", {}, h("i", { class: "sw", style: `background:${STAGE_COLORS[k]}` }), t(`stage.${k}`)), h("td", {}, fmtDur(v)))),
        h("tr", {}, h("td", { colspan: 2, style: "padding-top:6px" })),
        est.gpu_mib ? h("tr", {}, h("td", {}, t("est.gpu")), h("td", {}, `${int(est.gpu_mib)} / ${int(gpuTot)} MiB`)) : null,
        est.gpu_mib ? h("tr", {}, h("td", { colspan: 2 }, meter(gpuPct))) : null,
        h("tr", {}, h("td", {}, t("est.ram")), h("td", {}, `${int(est.ram_mib)} MiB`)),
        h("tr", {}, h("td", { colspan: 2 }, meter(ramPct))),
        h("tr", {}, h("td", {}, t("est.disk")), h("td", {}, fmtBytes(est.disk_peak_bytes))),
        h("tr", {}, h("td", { colspan: 2 }, meter(diskPct))),
        h("tr", {}, h("td", {}, t("est.gfs")), h("td", {}, `${num(est.gfs_mb, 0)} MB · ${e.derived?.gfs?.fhours?.length ?? "–"} ${this.app.lang === "tr" ? "dosya" : "files"}`)),
        h("tr", {}, h("td", {}, t("est.frames")), h("td", {}, int(est.frames))),
      ));
      if (e.finish_utc) body.append(h("p", { style: "margin:6px 0 0" }, t("est.finish", { t: fmtClock(new Date(e.finish_utc)) })));
      // the other modes
      for (const [m, o] of Object.entries(e.other_modes || {})) {
        const x = o.total_s / est.total_s;
        body.append(h("div", { class: "hint", style: "margin:2px 0" }, t("est.compare", { mode: t(`mode.${m}`), t: fmtDur(o.total_s) }),
          " · ", x >= 1 ? t("est.slower", { x: num(x, 1) }) : t("est.faster", { x: num(1 / x, 1) })));
      }
      for (const m of Object.keys(this.modeEls || {})) {
        const tt = m === est.mode ? est.total_s : e.other_modes?.[m]?.total_s;
        this.modeEls[m].querySelector(".t").textContent = tt ? `~${fmtDur(tt)}` : "–";
      }
    }
    const msgs = h("ul", { class: "msg" });
    for (const m of general) msgs.append(h("li", { class: "e" }, m));
    for (const w of e.warnings || []) msgs.append(h("li", { class: "w" }, typeof w === "string" ? w : w.message));
    if (msgs.children.length) body.append(msgs);
    if (e.fix) body.append(h("p", { class: "fix" }, t("est.fix", { fix: e.fix.text || e.fix }),
      e.fix.settings ? h("button", { class: "btn", style: "margin-left:6px;padding:3px 8px", onclick: () => this.applyFix(e.fix.settings) }, "✓") : null));
    if (est?.calibration) body.append(h("p", { class: "src" }, t("est.source", { s: est.calibration })));
    el.append(body);
    this.goBtn.disabled = !e.ok || level === "red";
  }
  applyFix(patch) {
    for (const [k, v] of Object.entries(patch)) {
      if (k === "mode") this.s.mode = v;
      else if (typeof v === "object") Object.assign(this.s[k], v);
    }
    this.render();
    this.changed();
  }

  async submit() {
    const e = this.result;
    if (!e?.ok) return;
    if (e.level === "yellow" && !(await this.app.confirm(t("run.confirm_long"), fmtDur(e.estimate?.total_s)))) return;
    this.goBtn.disabled = true;
    const r = await api.send("POST", "/api/v1/runs", this.s);
    this.goBtn.disabled = false;
    if (!r.ok) {
      if (r.json?.errors) this.show(r.json);
      toast(r.json?.error || t("err.generic", { e: r.status }));
      return;
    }
    if ("Notification" in window && Notification.permission === "default") Notification.requestPermission().catch(() => {});
    this.app.track(r.json);
  }
}
