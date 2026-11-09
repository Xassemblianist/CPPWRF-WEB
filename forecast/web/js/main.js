// SPDX-License-Identifier: GPL-3.0-or-later
// The page: the map, the layers, the time bar, the legend, hover values, the point card, the drawer
// (new forecast, runs, points), comparison, the URL state, units, theme and language.
import { $, h, t, api, prefs, loadLang, getLang, num, fmtTime, fmtValue, conv, units, UNITS, TZ, toast, fmtCycle } from "./util.js";
import { LAYERS, SCALES, lut, cssGradient, tickPos, scaleFor, ICONS } from "./catalog.js";
import { MapView, parseNE, isolines } from "./map.js";
import { Run } from "./data.js";
import { Settings } from "./settings.js";
import { Progress } from "./progress.js";
import { Library } from "./library.js";
import { PointCard, barb } from "./point.js";
import * as exporter from "./export.js";

const NE = new URL("../data/ne/", import.meta.url);
const svg = (path) => `<svg class="i" viewBox="0 0 24 24">${path}</svg>`;

class App {
  constructor() {
    this.lang = prefs.get("lang", "tr");
    this.layer = LAYERS[0];
    this.variant = null;
    this.level = 0;
    this.frame = 0;
    this.domain = 0;
    this.run = null;
    this.cmp = null;        // {run, mode: "split" | "diff"}
    this.opts = { particles: true, barbs: false, iso: true, cities: true, ...prefs.get("view", {}) };
    this.tab = "new";
  }

  async start() {
    await loadLang(this.lang);
    $("searchInput").placeholder = t("ui.search");
    document.documentElement.dataset.theme = prefs.get("theme", "dark");
    this.map = new MapView($("map"));
    this.map.setTheme(document.documentElement.dataset.theme);
    this.map.drawOverlay = (ctx) => this.overlay(ctx);
    this.map.on("hover", (lat, lon, e) => this.hover(lat, lon, e));
    this.map.on("leave", () => { $("probe").hidden = true; });
    this.map.on("click", (lat, lon) => this.click(lat, lon));
    this.map.on("rect", (a, b, c, d) => this.settings.rect(a, b, c, d));
    this.map.on("view", () => this.saveUrl());
    this.settings = new Settings(this);
    this.progress = new Progress(this);
    this.library = new Library(this);
    this.card = new PointCard(this);
    this.wireUi();
    this.loadBasemap();
    this.restoreUrl();
    if (!this.urlView) this.map.setView(39, 35, 4.6);
    await this.connect();
    setInterval(() => this.refreshSystem(), 15000);
    this.fpsLoop();
  }

  // ---- the server, or the samples
  async connect() {
    const sys = await api.detect();
    this.system = sys;
    this.paintSystem();
    if (api.online) {
      const [options, cycles] = await Promise.all([api.get("/api/v1/options"), api.get("/api/v1/cycles").catch(() => ({ cycles: [] }))]);
      this.options = options;
      await this.settings.init(options, cycles.cycles);
    } else {
      this.settings.render();
      this.showTab("runs");
    }
    const runs = await this.library.refresh();
    this.card.renderList();
    const want = this.urlState?.run;
    const pick = (want && runs.find((r) => r.id === want)) || runs.find((r) => r.status === "done" || r.sample);
    if (pick) await this.open(pick.id, { keepView: !!this.urlView });
    if (this.urlState?.cmp) await this.compare(this.urlState.cmp, this.urlState.cm);
    const active = runs.find((r) => r.status === "running" || r.status === "queued");
    if (active) this.track(active);
  }
  async refreshSystem() {
    if (!api.online) return;
    try { this.system = await api.get("/api/v1/system"); } catch { this.system = null; }
    this.paintSystem();
  }
  paintSystem() {
    const el = $("sys"), s = this.system;
    el.className = `panel${s ? (s.busy ? " busy" : " on") : ""}`;
    const txt = el.querySelector(".txt");
    if (!api.online) txt.textContent = t("sys.offline");
    else if (!s) txt.textContent = t("err.server");
    else {
      const gpu = s.gpu?.ok ? t("sys.gpu_free", { gpu: s.gpu.name.replace("NVIDIA GeForce ", ""), free: num(s.gpu.free_mib / 1024, 1) }) : t("sys.no_gpu");
      txt.textContent = `${gpu} · ${t("sys.disk_free", { free: num(s.disk_free_gb, 0) })}${s.queued ? ` · ${t("sys.queue", { n: s.queued })}` : ""}`;
    }
    const commit = s?.cppwrf_commit || this.run?.info?.cppwrf_commit || api.samples?.[0]?.cppwrf_commit || "";
    $("cppwrfTag").textContent = t("footer.cppwrf", { c: commit });
  }

  // ---- Natural Earth, the relief and the places
  async loadBasemap() {
    const get = async (name, kind) => this.map.setLayer(name, parseNE(await (await fetch(new URL(`${name}.bin`, NE))).arrayBuffer(), kind));
    await Promise.all([get("land50", "fill"), get("coast50", "line"), get("border50", "line"), get("lakes50", "fill"), get("coast110", "line"), get("rivers50", "line")]);
    fetch(new URL("../data/relief.bin", import.meta.url)).then((r) => r.arrayBuffer()).then((b) => this.map.setRelief(new Uint8Array(b), 2160, 1080)).catch(() => {});
    fetch(new URL("places.json", NE)).then((r) => r.json()).then((p) => { this.places = p; this.map.request(); });
    // the 1:10 m layers once the page is up
    setTimeout(async () => {
      for (const [n, k] of [["land10", "fill"], ["coast10", "line"], ["border10", "line"], ["lakes10", "fill"], ["rivers10", "line"]]) await get(n, k);
    }, 600);
  }

  // ---- opening a run
  async open(id, { keepView = false } = {}) {
    const info = this.library.find(id) || (api.online ? await api.get(`/api/v1/runs/${id}`) : null);
    if (!info) return;
    const run = new Run(info);
    try { await run.load(); } catch (e) { toast(t("err.generic", { e: e.message })); return; }
    this.run = run;
    this.domain = 0;
    const m = run.meta;
    if (!m.ready.includes(this.frame)) this.frame = m.ready.includes(this.urlState?.t) ? this.urlState.t : m.ready[0] ?? 0;
    if (this.urlState?.t != null && m.ready.includes(this.urlState.t)) this.frame = this.urlState.t;
    if (!keepView) {
      const lats = m.outline.map((p) => p[0]), lons = m.outline.map((p) => p[1]);
      this.map.fit(Math.min(...lats), Math.min(...lons), Math.max(...lats), Math.max(...lons));
    }
    this.urlView = false;
    $("runTag").textContent = `· ${info.settings?.name || fmtCycle(info.settings?.time?.cycle)} · ${t(`mode.${info.settings?.mode}`)}`;
    this.paintSystem();
    this.library.render();
    this.paintRail();
    this.paintTimebar();
    await this.update();
    if (this.tab === "new" && window.innerWidth < 760) this.toggleDrawer(false);
  }
  unload() {
    this.run = null;
    this.map.setField("a", null);
    this.map.setField("b", null);
    this.map.wind = null;
    this.map.setIsolines(null);
    $("timebar").hidden = true;
    $("legend").hidden = true;
  }
  get prod() { return this.run?.domains[this.domain] || this.run?.main; }

  // the field of the current layer, variant, level and frame on a product
  async fieldOn(prod, frame) {
    const f = this.layer.field(this.variant, this.level);
    if (f.speed) {
      const r = await prod.speed(frame, f.speed[0], f.speed[1], f.level);
      return r && { data: r.s, unit: "m/s", name: `${f.speed[0]}${f.level ? f.level : ""}_speed` };
    }
    const d = await prod.get(frame, f.name, f.level);
    return d && { data: d, unit: prod.field(f.name, f.level).unit, name: `${f.name}${f.level ? `_${f.level}` : ""}` };
  }
  available(L) {
    const p = this.prod;
    if (!p?.meta) return true;
    const f = L.field(L.variants ? L.variants[0][0] : null, L.levels === "only" ? L.defaultLevel : 0);
    return f.speed ? p.has(f.speed[0], f.level) : p.has(f.name, f.level);
  }

  // draw the current state
  async update() {
    const run = this.run;
    if (!run) return;
    const prod = this.prod, frame = this.frame, seq = (this.seq = (this.seq || 0) + 1);
    const g = prod.meta.grid;
    let F;
    try { F = await this.fieldOn(prod, frame); } catch (e) { toast(t("err.generic", { e: e.message })); return; }
    if (seq !== this.seq || !F) return;
    let scale = scaleFor(this.layer, this.variant, this.level);
    let data = F.data;
    this.map.split = null;
    $("splitline").hidden = true;
    this.map.setField("b", null);
    if (this.cmp) {
      const B = this.cmp.run.at(0, 0) && this.cmp.run.main;
      const FB = await this.fieldOn(B, Math.min(frame, B.meta.times.length - 1)).catch(() => null);
      if (seq !== this.seq) return;
      if (FB && this.cmp.mode === "diff") {
        // B on A's grid, then A - B
        const same = JSON.stringify(B.meta.grid) === JSON.stringify(g);
        const d = new Float32Array(data.length);
        let mx = 0;
        for (let r = 0; r < g.nlat; ++r)
          for (let c = 0; c < g.nlon; ++c) {
            const k = r * g.nlon + c;
            const b = same ? FB.data[k] : B.sample(FB.data, g.lat0 + r * g.dlat, g.lon0 + c * g.dlon);
            d[k] = data[k] - b;
            if (Number.isFinite(d[k])) mx = Math.max(mx, Math.abs(d[k]));
          }
        data = d;
        const span = niceSpan(mx);
        scale = { stops: SCALES.diff.stops.map(([v, c, a]) => [v * span, c, a]), ticks: [-span, -span / 2, 0, span / 2, span] };
        this.cmpNote = same ? "" : t("cmp.nogrid");
      } else if (FB) {
        this.map.split = this.splitAt ?? 0.5;
        $("splitline").hidden = false;
        $("splitline").style.left = `${100 * this.map.split}%`;
        const L = lut(scale);
        this.map.setField("b", { data: FB.data, grid: B.meta.grid, lut: L, lo: scale.lo, hi: scale.hi, log: scale.log });
      }
    }
    const L = lut(scale);
    this.map.setField("a", { data, grid: g, lut: L, lo: scale.lo, hi: scale.hi, log: scale.log, alpha: 1 });
    this.current = { data, grid: g, unit: F.unit, name: F.name, scale };
    // wind for the particles and barbs: the layer's level, else 10 m
    const lvl = this.layer.levels && this.level ? this.level : 0;
    const [u, v] = await Promise.all(lvl ? [prod.get(frame, "u", lvl), prod.get(frame, "v", lvl)] : [prod.get(frame, "u10"), prod.get(frame, "v10")]);
    if (seq !== this.seq) return;
    this.wind = u && v ? { u, v } : null;
    this.map.wind = this.wind && this.opts.particles ? (la, lo) => { const a = prod.sample(u, la, lo), b = prod.sample(v, la, lo); return Number.isFinite(a + b) ? [a, b] : null; } : null;
    const light = document.documentElement.dataset.theme === "light";
    this.map.particleColor = light && !["temp", "cape", "radar", "precip"].includes(this.layer.id) ? "rgba(20,30,45,0.7)" : "rgba(255,255,255,0.78)";
    // isolines
    const ct = this.layer.contour;
    this.isoLabels = null;
    if (ct && this.opts.iso && !this.cmp) {
      const vals = Array.from(data).filter(Number.isFinite);
      const iso = isolines(data, g, ct.step, Math.min(...vals), Math.max(...vals));
      this.map.setIsolines(iso.verts);
      this.isoLabels = iso.labels;
    } else this.map.setIsolines(null);
    this.paintLegend(scale, F.unit);
    this.paintNow();
    this.map.request();
    this.saveUrl();
    // the next frames in the background
    const ready = prod.meta.ready, i = ready.indexOf(frame);
    for (const nf of ready.slice(i + 1, i + 3)) this.fieldOn(prod, nf).catch(() => {});
  }
  async setFrame(f, { wait = false } = {}) {
    if (!this.run) return;
    this.frame = f;
    this.paintTimebar();
    const p = this.update();
    if (wait) await p;
  }
  step(d) {
    const r = this.prod?.meta.ready || [];
    const i = r.indexOf(this.frame);
    if (!r.length) return;
    this.setFrame(r[(i + d + r.length) % r.length]);
  }

  // ---- the layer rail and the layer box
  paintRail() {
    const rail = $("rail");
    rail.replaceChildren();
    LAYERS.forEach((L, i) => {
      const b = h("button", { "aria-pressed": String(L === this.layer), title: `${t(L.key)}${i < 9 ? ` (${i + 1})` : ""}`, "aria-label": t(L.key), class: this.available(L) ? "" : "na",
        onclick: () => this.pickLayer(L, true) });
      b.innerHTML = svg(ICONS[L.id] || "") + (i < 9 ? `<span class="k">${i + 1}</span>` : "");
      rail.append(b);
    });
    this.paintLayerBox();
  }
  pickLayer(L, toggleBox = false) {
    if (L === this.layer && toggleBox) { $("layerbox").hidden = !$("layerbox").hidden; return; }
    this.layer = L;
    this.variant = L.variants ? L.variants[0][0] : null;
    if (L.levels === "only") this.level = this.level || L.defaultLevel;
    else if (!L.levels) this.level = 0;
    $("layerbox").hidden = false;
    this.paintRail();
    this.update();
  }
  paintLayerBox() {
    const box = $("layerbox"), L = this.layer;
    box.replaceChildren(h("h4", {}, t(L.key)));
    if (L.variants) {
      box.append(h("div", { class: "chips" }, L.variants.map(([id, key, name]) => h("button", { class: "chip", "aria-pressed": String(this.variant === id),
        disabled: this.prod?.meta && !this.prod.has(name) ? true : null, onclick: () => { this.variant = id; this.paintLayerBox(); this.update(); } }, t(key)))));
    }
    if (L.levels) {
      const lv = this.prod?.meta?.levels || [925, 850, 700, 500, 300, 250];
      const opts = L.levels === "only" ? lv : [0, ...lv];
      box.append(h("div", { class: "chips", role: "radiogroup", "aria-label": "Seviye" }, opts.map((p) => h("button", { class: "chip", role: "radio", "aria-checked": String(this.level === p), "aria-pressed": String(this.level === p),
        onclick: () => { this.level = p; this.paintLayerBox(); this.update(); } }, p ? t("level.hpa", { p }) : L.id === "wind" ? t("level.10m") : t("level.2m")))));
    }
    if (this.run?.domains.length > 1) {
      box.append(h("div", { class: "chips" }, this.run.domains.map((d, i) => h("button", { class: "chip", "aria-pressed": String(this.domain === i),
        onclick: () => { this.domain = i; this.paintLayerBox(); this.paintTimebar(); this.update(); } }, `d0${i + 1}`))));
    }
    const opt = (k, key) => h("label", { class: "check" }, h("input", { type: "checkbox", checked: this.opts[k], onchange: (e) => { this.opts[k] = e.target.checked; prefs.set("view", this.opts); this.update(); } }), t(key));
    box.append(h("div", { class: "opts" }, opt("particles", "ui.particles"), opt("barbs", "ui.barbs"), L.contour ? opt("iso", "ui.isolines") : null, opt("cities", "ui.cities")));
  }

  // ---- the time bar
  paintTimebar() {
    const bar = $("timebar"), m = this.prod?.meta;
    if (!m) { bar.hidden = true; return; }
    bar.hidden = false;
    const ticks = $("ticks"), n = m.times.length;
    ticks.replaceChildren(h("div", { class: "track" }));
    const pos = (i) => (n > 1 ? (100 * i) / (n - 1) : 50);
    const lastReady = Math.max(...m.ready, 0);
    ticks.append(h("div", { class: "ready", style: `width:${pos(lastReady)}%` }));
    let lastDay = "";
    const tz = TZ[prefs.get("tz", "ist")] || TZ.ist;
    m.times.forEach((iso, i) => {
      const day = new Intl.DateTimeFormat(getLang() === "tr" ? "tr-TR" : "en-GB", { weekday: "short", day: "numeric", timeZone: tz.zone }).format(new Date(iso));
      if (day !== lastDay) { ticks.append(h("span", { class: "day", style: `left:${pos(i)}%` }, day)); lastDay = day; }
      else if (n < 80) ticks.append(h("i", { class: "tick", style: `left:${pos(i)}%` }));
    });
    ticks.append(h("div", { class: "knob", style: `left:${pos(this.frame)}%` }));
    ticks.setAttribute("aria-valuemax", n - 1);
    ticks.setAttribute("aria-valuenow", this.frame);
    ticks.setAttribute("aria-valuetext", fmtTime(m.times[this.frame]));
    const lead = Math.round((Date.parse(m.times[this.frame]) - Date.parse(m.times[0])) / 3600e3);
    $("nowLabel").replaceChildren(fmtTime(m.times[this.frame]), h("small", {}, `${t("time.lead", { h: lead })} · ${fmtTime(m.times[this.frame], { weekday: false, date: true }).replace(/ \d\d:\d\d.*/, "")}`));
  }
  paintNow() { this.paintTimebar(); }

  // ---- the legend
  paintLegend(scale, unit) {
    const el = $("legend");
    el.hidden = false;
    const c = conv(1, unit);
    el.replaceChildren(h("div", { class: "ttl" }, h("b", {}, `${t(this.layer.key)}${this.level ? ` · ${this.level} hPa` : ""}${this.cmp?.mode === "diff" ? ` · ${t("cmp.diff")}` : ""}`), h("span", {}, c.label)),
      h("div", { class: "grad", style: `background:${cssGradient(scale)}` }),
      h("div", { class: "tk" }, (scale.ticks || []).map((v) => h("span", { style: `left:${Math.max(3, Math.min(97, 100 * tickPos(scale, v)))}%` }, num(conv(v, unit).v, Math.abs(v) < 1 && v ? 1 : 0)))));
    if (this.cmpNote && this.cmp?.mode === "diff") el.append(h("div", { class: "hint", style: "margin:2px 0 0" }, this.cmpNote));
    const L = lut(scale);
    this.legendGradient = [0, 64, 128, 192, 255].map((q) => `rgba(${L[4 * q]},${L[4 * q + 1]},${L[4 * q + 2]},${Math.max(0.3, L[4 * q + 3] / 255)})`);
    this.legendUnit = `${t(this.layer.key)} (${c.label})`;
  }
  caption() { return `${t(this.layer.key)}${this.level ? ` ${this.level} hPa` : ""} · ${fmtTime(this.prod.meta.times[this.frame])}`; }

  // ---- hover and click
  hover(lat, lon, e) {
    const p = $("probe");
    if (!this.current) { p.hidden = true; return; }
    const v = this.prod.sample(this.current.data, lat, lon);
    if (!Number.isFinite(v)) { p.hidden = true; return; }
    p.hidden = false;
    p.style.left = `${e.clientX}px`;
    p.style.top = `${e.clientY}px`;
    const wind = this.wind ? [this.prod.sample(this.wind.u, lat, lon), this.prod.sample(this.wind.v, lat, lon)] : null;
    const extra = wind && this.layer.id !== "wind" && Number.isFinite(wind[0]) ? ` · ${fmtValue(Math.hypot(...wind), "m/s")}` : "";
    const dir = wind && Number.isFinite(wind[0]) ? ` ${num((Math.atan2(-wind[0], -wind[1]) * 180 / Math.PI + 360) % 360, 0)}°` : "";
    p.replaceChildren(h("b", {}, fmtValue(v, this.current.unit)), this.layer.id === "wind" ? dir : extra,
      h("small", {}, `${num(lat, 2)}°, ${num(lon, 2)}°`));
  }
  click(lat, lon) {
    if (this.tab === "new" && api.online && !$("drawer").classList.contains("closed") && this.settings.click(lat, lon)) return;
    if (this.run) this.card.show(lat, lon);
  }

  // ---- annotations on the overlay canvas
  overlay(ctx) {
    const map = this.map;
    const dark = document.documentElement.dataset.theme !== "light";
    const ink = dark ? "#e6ebf1" : "#172231", halo = dark ? "rgba(8,12,18,0.85)" : "rgba(255,255,255,0.9)";
    const poly = (pts, color, width, dash) => {
      ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash || []);
      ctx.beginPath();
      const ref = pts[0][1];
      pts.forEach(([la, lo], i) => { const [x, y] = map.projectNear(la, lo, ref); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
      ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    };
    const box = (b, color, dash) => {
      const pts = [];
      for (let k = 0; k <= 16; ++k) pts.push([b.lat0, b.lon0 + (b.lon1 - b.lon0) * k / 16]);
      for (let k = 0; k <= 16; ++k) pts.push([b.lat1, b.lon1 - (b.lon1 - b.lon0) * k / 16]);
      poly(pts, color, 2, dash);
    };
    // the run's domains
    if (this.run) for (const d of this.run.domains) if (d.meta?.outline) poly(d.meta.outline, dark ? "rgba(255,255,255,0.55)" : "rgba(20,30,45,0.6)", 1.3);
    // the settings preview
    if (this.tab === "new" && api.online && this.settings.s && !$("drawer").classList.contains("closed")) {
      box(this.settings.box(), "#4fa3ff", [6, 4]);
      const nb = this.settings.nestBox();
      if (nb) box(nb, "#f2c14e", [4, 3]);
    }
    // isoline labels
    ctx.font = "600 11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    if (this.isoLabels) {
      for (const [la, lo, v] of this.isoLabels) {
        const [x, y] = map.project(la, lo);
        if (x < 0 || y < 0 || x > map.W || y > map.H) continue;
        const s = num(conv(v, this.current.unit).v, 0);
        ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(s, x, y); ctx.fillStyle = ink; ctx.fillText(s, x, y);
      }
    }
    // wind barbs on a screen grid
    if (this.opts.barbs && this.wind) {
      const sp = 44;
      for (let y = sp / 2; y < map.H; y += sp)
        for (let x = sp / 2; x < map.W; x += sp) {
          const [la, lo] = map.unproject(x, y);
          const u = this.prod.sample(this.wind.u, la, lo), v = this.prod.sample(this.wind.v, la, lo);
          if (Number.isFinite(u + v)) barb(ctx, x, y, u, v, ink, 16);
        }
    }
    // cities: by rank, without overlaps
    if (this.opts.cities && this.places) {
      const maxRank = Math.max(1, Math.min(10, Math.round(map.zoom * 1.25 - 2)));
      const taken = [];
      ctx.font = "12px sans-serif";
      ctx.textAlign = "left";
      for (const [lo, la, rank, name] of this.places) {
        if (rank > maxRank) continue;
        const [x, y] = map.project(la, lo);
        if (x < -20 || y < -10 || x > map.W + 20 || y > map.H + 10) continue;
        const w = ctx.measureText(name).width + 10;
        if (taken.some((r) => x < r[0] + r[2] && x + w > r[0] && Math.abs(y - r[1]) < 15)) continue;
        taken.push([x, y, w]);
        ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(x, y, 2.2, 0, 2 * Math.PI); ctx.fill();
        ctx.lineWidth = 3; ctx.strokeStyle = halo; ctx.strokeText(name, x + 5, y); ctx.fillText(name, x + 5, y);
        if (taken.length > 160) break;
      }
    }
    // saved points and the current point
    ctx.fillStyle = "#f2c14e";
    for (const p of this.card.points) { const [x, y] = map.project(p.lat, p.lon); ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill(); }
    if (this.card.pt && !$("card").hidden) {
      const [x, y] = map.project(this.card.pt.lat, this.card.pt.lon);
      ctx.strokeStyle = "#4fa3ff"; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.arc(x, y, 7, 0, 2 * Math.PI); ctx.stroke();
    }
    // a rectangle being drawn
    if (map.rect) {
      const r = map.rect;
      ctx.strokeStyle = this.settings.drawNest ? "#f2c14e" : "#4fa3ff"; ctx.lineWidth = 2; ctx.setLineDash([5, 4]);
      ctx.strokeRect(Math.min(r.x0, r.x1), Math.min(r.y0, r.y1), Math.abs(r.x1 - r.x0), Math.abs(r.y1 - r.y0));
      ctx.setLineDash([]);
    }
  }

  // ---- runs: tracking, partial frames, the end
  track(run) { this.progress.track(run); this.library.refresh(); this.showTab("runs"); }
  async partial(run, frames) {
    if (this.run?.id === run.id) {
      if (await this.run.main.refresh()) { this.paintTimebar(); if (!this.current) this.update(); }
    } else if (!this.run && frames) {
      await this.open(run.id);
    }
    this.library.refresh();
  }
  async finished(run, e) {
    await this.library.refresh();
    this.refreshSystem();
    if (e.status === "done") {
      if (!this.run || this.run.id === run.id) await this.open(run.id, { keepView: this.run?.id === run.id });
      toast(t("run.done"));
    }
  }
  rerun(r, edit) {
    this.settings.load(r.settings);
    this.showTab("new");
    if (!edit) this.settings.estimate().then(() => this.settings.submit());
  }

  // ---- comparison
  async compare(id, mode = "split") {
    if (!id) { this.cmp = null; $("cmpbar").hidden = true; this.update(); this.saveUrl(); return; }
    const info = this.library.find(id);
    if (!info || !this.run) return;
    const run = new Run(info);
    await run.load();
    this.cmp = { run, mode };
    const bar = $("cmpbar");
    bar.hidden = false;
    const name = (r) => r.info.settings?.name || `${t(`mode.${r.info.settings?.mode}`)} ${fmtCycle(r.info.settings?.time?.cycle)}`;
    bar.replaceChildren(h("b", {}, t("cmp.title")), h("span", {}, `A: ${name(this.run)} · B: ${name(run)}`),
      ...["split", "diff"].map((m) => h("button", { class: "chip", "aria-pressed": String(this.cmp.mode === m), onclick: () => this.compare(id, m) }, t(`cmp.${m}`))),
      h("button", { class: "btn", onclick: () => this.compare(null) }, t("cmp.off")));
    $("splitline").querySelector(".a").textContent = `A · ${name(this.run)}`;
    $("splitline").querySelector(".b").textContent = `B · ${name(run)}`;
    await this.update();
    this.saveUrl();
  }

  // ---- the URL: #run=…&l=wind&v=…&p=850&t=3&m=lat,lon,zoom&cmp=…&cm=split
  saveUrl() {
    clearTimeout(this.urlTimer);
    this.urlTimer = setTimeout(() => {
      const v = this.map.view();
      const q = new URLSearchParams();
      if (this.run) q.set("run", this.run.id);
      q.set("l", this.layer.id);
      if (this.variant) q.set("v", this.variant);
      if (this.level) q.set("p", this.level);
      if (this.run) q.set("t", this.frame);
      q.set("m", `${v.lat.toFixed(3)},${v.lon.toFixed(3)},${v.zoom.toFixed(2)}`);
      if (this.cmp) { q.set("cmp", this.cmp.run.id); q.set("cm", this.cmp.mode); }
      history.replaceState(null, "", `#${q}`);
    }, 250);
  }
  restoreUrl() {
    const q = new URLSearchParams(location.hash.slice(1));
    this.urlState = { run: q.get("run"), t: q.has("t") ? Number(q.get("t")) : null, cmp: q.get("cmp"), cm: q.get("cm") || "split" };
    const L = LAYERS.find((x) => x.id === q.get("l"));
    if (L) { this.layer = L; this.variant = q.get("v") || (L.variants ? L.variants[0][0] : null); this.level = Number(q.get("p")) || (L.levels === "only" ? L.defaultLevel : 0); }
    const m = (q.get("m") || "").split(",").map(Number);
    if (m.length === 3 && m.every(Number.isFinite)) { this.map.setView(m[0], m[1], m[2]); this.urlView = true; }
    if (q.get("t") != null) this.frame = Number(q.get("t"));
    this.paintRail();
  }

  // ---- the user interface around the map
  wireUi() {
    document.querySelectorAll(".tabs[role=tablist] > button[role=tab]").forEach((b) => {
      if (b.closest("#drawer")) b.addEventListener("click", () => this.showTab(b.id.slice(4)));
    });
    $("menuBtn").onclick = () => this.toggleDrawer();
    if (window.innerWidth < 760 || prefs.get("drawer", true) === false) this.toggleDrawer(false);
    $("themeBtn").onclick = () => {
      const th = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = th;
      prefs.set("theme", th);
      this.map.setTheme(th);
      this.update();
    };
    $("langBtn").onclick = async () => {
      this.lang = this.lang === "tr" ? "en" : "tr";
      prefs.set("lang", this.lang);
      await loadLang(this.lang);
      $("searchInput").placeholder = t("ui.search");
      this.settings.render();
      this.library.render();
      this.card.renderList();
      this.paintSystem();
      this.paintRail();
      this.update();
    };
    $("unitsBtn").onclick = () => this.unitsDialog();
    $("exportBtn").onclick = () => exporter.menu(this);
    $("shareBtn").onclick = async () => { this.saveUrl(); await new Promise((r) => setTimeout(r, 300)); try { await navigator.clipboard.writeText(location.href); toast(t("ui.copied")); } catch { toast(location.href, 6000); } };
    $("prevBtn").onclick = () => this.step(-1);
    $("nextBtn").onclick = () => this.step(1);
    $("playBtn").onclick = () => this.play();
    // the time slider: click or drag; arrows on the keyboard
    const ticks = $("ticks");
    const seek = (e) => {
      const m = this.prod?.meta;
      if (!m) return;
      const r = ticks.getBoundingClientRect();
      const i = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * (m.times.length - 1));
      const ready = m.ready.reduce((a, b) => (Math.abs(b - i) < Math.abs(a - i) ? b : a), m.ready[0]);
      if (ready !== this.frame) this.setFrame(ready);
    };
    ticks.addEventListener("pointerdown", (e) => { ticks.setPointerCapture(e.pointerId); seek(e); ticks.onpointermove = seek; });
    ticks.addEventListener("pointerup", () => { ticks.onpointermove = null; });
    // the split line
    const split = $("splitline");
    split.addEventListener("pointerdown", (e) => {
      split.setPointerCapture(e.pointerId);
      split.onpointermove = (ev) => { this.splitAt = Math.max(0.05, Math.min(0.95, ev.clientX / innerWidth)); this.map.split = this.splitAt; split.style.left = `${100 * this.splitAt}%`; this.map.request(); };
    });
    split.addEventListener("pointerup", () => { split.onpointermove = null; });
    // keys
    addEventListener("keydown", (e) => {
      if (e.target.closest("input, select, textarea, dialog")) return;
      if (e.key >= "1" && e.key <= "9" && !e.ctrlKey && !e.metaKey) { const L = LAYERS[Number(e.key) - 1]; if (L) this.pickLayer(L); }
      else if (e.key === "ArrowRight" || e.key === ".") { this.step(1); e.preventDefault(); }
      else if (e.key === "ArrowLeft" || e.key === ",") { this.step(-1); e.preventDefault(); }
      else if (e.key === " ") { this.play(); e.preventDefault(); }
      else if (e.key === "+" || e.key === "=") this.map.zoomBy(0.5);
      else if (e.key === "-") this.map.zoomBy(-0.5);
      else if (e.key === "Escape") { this.card.close(); $("layerbox").hidden = true; }
      else if (e.key === "ArrowUp" && e.shiftKey) this.map.panBy(0, -80);
      else if (e.key === "ArrowDown" && e.shiftKey) this.map.panBy(0, 80);
    });
    // a link pasted into the address bar of an open page
    addEventListener("hashchange", () => location.reload());
    // search the places
    const input = $("searchInput"), list = $("searchList");
    input.addEventListener("input", () => {
      const q = input.value.trim().toLocaleLowerCase("tr");
      list.replaceChildren();
      if (q.length < 2 || !this.places) { list.hidden = true; return; }
      const hits = this.places.filter((p) => p[3].toLocaleLowerCase("tr").startsWith(q)).sort((a, b) => a[2] - b[2]).slice(0, 8);
      for (const [lo, la, , name] of hits) list.append(h("li", { role: "option", onclick: () => { this.map.setView(la, lo, Math.max(this.map.zoom, 7)); list.hidden = true; input.value = name; if (this.run) this.card.show(la, lo, name); } }, name));
      list.hidden = !hits.length;
      $("search").setAttribute("aria-expanded", String(!list.hidden));
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") list.firstChild?.click(); if (e.key === "Escape") list.hidden = true; });
  }
  play() {
    if (this.playing) { clearInterval(this.playing); this.playing = null; $("playBtn").innerHTML = svg('<path d="M7 5l12 7-12 7z"/>'); return; }
    $("playBtn").innerHTML = svg('<path d="M7 5h3v14H7zM14 5h3v14h-3z"/>');
    this.playing = setInterval(() => this.step(1), prefs.get("speed", 700));
  }
  showTab(name) {
    this.tab = name;
    for (const n of ["new", "runs", "points"]) {
      $(`tab-${n}`).setAttribute("aria-selected", String(n === name));
      $(`pane-${n}`).hidden = n !== name;
    }
    if ($("drawer").classList.contains("closed")) this.toggleDrawer(true);
    this.map.request();
  }
  toggleDrawer(open) {
    const d = $("drawer");
    const want = open ?? d.classList.contains("closed");
    d.classList.toggle("closed", !want);
    document.body.classList.toggle("drawer-closed", !want);
    $("menuBtn").setAttribute("aria-expanded", String(want));
    if (window.innerWidth >= 760) prefs.set("drawer", want);
    this.map.request();
  }
  drawDomain() { this.map?.request(); }
  toast(m) { toast(m); }

  // ---- dialogs
  dialog(body, buttons) {
    const dlg = $("dlg");
    $("dlgBody").replaceChildren(body);
    $("dlgMenu").replaceChildren(...buttons.map(([label, value], i) => h("button", { class: `btn${i === buttons.length - 1 ? " primary" : ""}`, value: String(value) }, label)));
    dlg.showModal();
    return new Promise((res) => { dlg.onclose = () => res(dlg.returnValue === "true"); });
  }
  confirm(msg, detail) {
    return this.dialog(h("div", {}, h("p", { style: "margin-top:0;font-weight:600" }, msg), detail ? h("p", { class: "hint" }, detail) : null), [[t("ui.close"), false], ["OK", true]]);
  }
  unitsDialog() {
    const u = units();
    const body = h("div", {}, h("h3", { style: "margin-top:0" }, t("units.title")));
    for (const fam of ["temp", "wind", "pres", "precip"]) {
      body.append(h("label", { class: "fld", style: "margin-bottom:8px" }, h("span", {}, t(`units.${fam}`)),
        h("select", { onchange: (e) => { prefs.set("units", { ...units(), [fam]: e.target.value }); } },
          Object.entries(UNITS[fam]).map(([k, v]) => h("option", { value: k, selected: u[fam] === k }, k === "bft" ? t("units.bft") : v.label)))));
    }
    body.append(h("label", { class: "fld" }, h("span", {}, t("time.tz")), h("select", { onchange: (e) => prefs.set("tz", e.target.value) },
      ["ist", "utc", "local"].map((k) => h("option", { value: k, selected: prefs.get("tz", "ist") === k }, t(`time.tz.${k}`))))));
    this.dialog(body, [["OK", true]]).then(() => { this.update(); this.paintTimebar(); this.library.render(); });
  }

  // frames per second of the page (the performance numbers in the docs)
  fpsLoop() {
    let n = 0, t0 = performance.now();
    const tick = (now) => {
      ++n;
      if (now - t0 >= 2000) { window.cppwrfFps = Math.round((1000 * n) / (now - t0)); n = 0; t0 = now; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
}

function niceSpan(x) {
  if (!(x > 0)) return 1;
  const e = 10 ** Math.floor(Math.log10(x)), m = x / e;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * e;
}

const app = new App();
window.cppwrf = app;
app.start().catch((e) => { console.error(e); toast(t("err.generic", { e: e.message }), 8000); });
