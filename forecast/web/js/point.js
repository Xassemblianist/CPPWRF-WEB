// SPDX-License-Identifier: GPL-3.0-or-later
// The point card: the values at the model's nearest grid point, a meteogram and a Skew-T log-p diagram.
import { $, h, t, num, fmtValue, conv, fmtTime, prefs } from "./util.js";

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

export class PointCard {
  constructor(app) {
    this.app = app;
    this.el = $("card");
    this.tab = prefs.get("cardTab", "meteogram");
    this.points = prefs.get("points", []);
  }
  close() { this.el.hidden = true; this.pt = null; this.app.map.request(); }

  async show(lat, lon, name) {
    const run = this.app.run;
    if (!run) return;
    const prod = run.at(lat, lon);
    this.pt = { lat, lon, name };
    this.el.hidden = false;
    document.getElementById("layerbox").hidden = true;
    const frame = this.app.frame;
    const cell = prod.cell(lat, lon);
    const head = h("header", {}, h("h4", { id: "cardTitle" }, name || `${num(lat, 2)}°, ${num(lon, 2)}°`),
      h("button", { class: "btn", onclick: () => this.save() }, t("point.save")),
      h("button", { class: "icon-btn", "aria-label": t("ui.close"), onclick: () => this.close() }, "✕"));
    this.el.replaceChildren(head);
    if (!cell) { this.el.append(h("p", { class: "note" }, t("point.outside"))); return; }
    const nat = await prod.native(frame, lat, lon).catch(() => null);
    if (!nat) { this.el.append(h("p", { class: "note" }, t("point.outside"))); return; }
    const v = nat.values;
    const ws = Math.hypot(v.u10, v.v10), wd = (Math.atan2(-v.u10, -v.v10) * 180 / Math.PI + 360) % 360;
    this.el.append(h("p", { class: "note" }, `${t("point.nearest", { d: num(nat.km, 1) })} · ${prod.dom ? prod.dom.replace("/", "") : "d01"} (${nat.i + 1}, ${nat.j + 1}) · ${fmtTime(prod.meta.times[frame], { date: true })}`));
    const item = (k, val) => h("span", {}, `${k} `, h("b", {}, val));
    this.el.append(h("div", { class: "now" },
      item(t("layer.temp"), fmtValue(v.t2, "°C")), item(t("layer.dew"), fmtValue(v.td2, "°C")), item(t("layer.rh"), `${num(v.rh2, 0)} %`),
      item(t("layer.wind"), `${fmtValue(ws, "m/s")} ${num(wd, 0)}°`), item(t("layer.gust"), fmtValue(v.gust, "m/s")),
      item(t("layer.mslp"), fmtValue(v.mslp, "hPa")), item(t("layer.precip"), fmtValue(v.precip_acc, "mm")),
      item(t("layer.cloud"), `${num(v.cloud_total, 0)} %`)));
    this.el.append(h("p", { class: "note" }, t("point.cape", { c: num(v.cape_sb, 0), n: num(v.cin_sb, 0), l: num(v.li, 1) })));
    const tabs = h("div", { class: "tabs", role: "tablist" });
    const body = h("div");
    for (const k of ["meteogram", "skewt"]) {
      tabs.append(h("button", { role: "tab", "aria-selected": String(this.tab === k), onclick: () => { this.tab = k; prefs.set("cardTab", k); this.show(lat, lon, name); } }, t(`point.${k}`)));
    }
    this.el.append(tabs, body);
    if (this.tab === "meteogram") {
      const s = await prod.series(cell, lat, lon);
      if (s.partial) body.append(h("p", { class: "note" }, t("point.wait_series")));
      const c = h("canvas", { role: "img", "aria-label": t("point.meteogram") });
      body.append(c);
      meteogram(c, s, prod.meta.times.indexOf(prod.meta.times[frame]));
    } else {
      const snd = await prod.sounding(frame, cell);
      const c = h("canvas", { role: "img", "aria-label": t("point.skewt") });
      body.append(c, h("p", { class: "note" }, t("point.parcel")));
      skewT(c, snd, { t: v.t2, td: v.td2, p: v.psfc });
    }
    this.app.map.request();
  }
  save() {
    if (!this.pt) return;
    const name = prompt(t("point.name"), this.pt.name || "") ?? null;
    if (name == null) return;
    this.points.push({ name: name || `${num(this.pt.lat, 2)}, ${num(this.pt.lon, 2)}`, lat: this.pt.lat, lon: this.pt.lon });
    prefs.set("points", this.points);
    this.renderList();
    this.app.toast(t("point.saved"));
  }
  renderList() {
    const p = $("pane-points");
    p.replaceChildren();
    if (!this.points.length) { p.append(h("p", { class: "hint" }, t("point.empty"))); return; }
    this.points.forEach((pt, i) => p.append(h("div", { class: "pt" },
      h("span", { tabindex: 0, role: "button", onclick: () => { this.app.map.setView(pt.lat, pt.lon, Math.max(this.app.map.zoom, 6)); this.show(pt.lat, pt.lon, pt.name); } },
        pt.name, h("small", { style: "color:var(--muted);margin-left:6px" }, `${num(pt.lat, 2)}°, ${num(pt.lon, 2)}°`)),
      h("button", { class: "icon-btn", "aria-label": t("lib.delete"), onclick: () => { this.points.splice(i, 1); prefs.set("points", this.points); this.renderList(); this.app.map.request(); } }, "✕"))));
  }
}

// ---- drawing helpers
function setup(c, w, hgt) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = c.parentElement.clientWidth || w;
  c.width = W * dpr;
  c.height = hgt * dpr;
  c.style.height = `${hgt}px`;
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = `11px ${css("--font") || "sans-serif"}`;
  return [ctx, W];
}

// four panels: temperature and dew point; wind and gusts (with arrows); precipitation; pressure and cloud cover
function meteogram(c, s, cur) {
  const n = s.times.length;
  const [ctx, W] = setup(c, 520, 420);
  const L = 44, R = 40, PH = 86, G = 16;
  const x = (i) => L + (W - L - R) * (n > 1 ? i / (n - 1) : 0.5);
  const text = css("--text"), muted = css("--muted"), line = css("--line");
  const panels = [
    { key: "mg.temp", series: [["t2", "#e0703a"], ["td2", "#4fa3ff"]], unit: "°C" },
    { key: "mg.wind", series: [["gust", "#9b8cf0", true], ["ws", "#3fbfb0"]], unit: "m/s" },
    { key: "mg.precip", bars: "precip_rate", line: ["precip_acc", "#4fa3ff"], unit: "mm" },
    { key: "mg.pres", series: [["mslp", text]], clouds: true, unit: "hPa" },
  ];
  const ws = Float32Array.from(s.u10, (u, i) => Math.hypot(u, s.v10[i]));
  const data = { ...s, ws };
  panels.forEach((P, k) => {
    const y0 = 8 + k * (PH + G), y1 = y0 + PH;
    ctx.fillStyle = muted;
    ctx.fillText(t(P.key), L, y0 + 1);
    // the current frame
    if (cur >= 0 && cur < n) { ctx.fillStyle = "rgba(79,163,255,0.12)"; ctx.fillRect(x(cur) - 3, y0 + 6, 6, PH - 6); }
    let vals = [];
    if (P.series) for (const [nm] of P.series) vals.push(...Array.from(data[nm]).map((v) => conv(v, P.unit).v));
    if (P.bars) vals.push(0, ...Array.from(data[P.line[0]]).map((v) => conv(v, "mm").v), ...Array.from(data[P.bars]).map((v) => conv(v, "mm").v));
    vals = vals.filter(Number.isFinite);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    if (P.bars) lo = 0;
    const pad = (hi - lo) * 0.1;
    lo -= P.bars ? 0 : pad; hi += pad;
    const y = (v) => y1 - (y1 - y0 - 10) * (v - lo) / (hi - lo);
    // grid
    ctx.strokeStyle = line; ctx.lineWidth = 1; ctx.fillStyle = muted;
    for (let q = 0; q <= 2; ++q) {
      const v = lo + (hi - lo) * q / 2, yy = y(v);
      ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
      ctx.fillText(num(v, Math.abs(hi - lo) < 5 ? 1 : 0), 4, yy + 3);
    }
    ctx.fillText(conv(1, P.unit === "mm" ? "mm" : P.unit).label, W - R + 4, y0 + 14);
    if (P.clouds) {
      // cloud cover as grey bands (low, mid, high) on the right axis
      ["cloud_high", "cloud_mid", "cloud_low"].forEach((nm, b) => {
        const bh = (PH - 10) / 3, by = y0 + 6 + b * bh;
        for (let i = 0; i < n; ++i) {
          const a = (data[nm][i] || 0) / 100;
          ctx.fillStyle = `rgba(150,160,175,${0.85 * a})`;
          ctx.fillRect(x(i) - (W - L - R) / Math.max(1, n - 1) / 2, by, (W - L - R) / Math.max(1, n - 1), bh - 2);
        }
      });
    }
    if (P.bars) {
      const bw = Math.max(2, (W - L - R) / Math.max(1, n) * 0.7);
      for (let i = 0; i < n; ++i) {
        const v = conv(data[P.bars][i], "mm").v;
        if (!(v > 0)) continue;
        ctx.fillStyle = "#3a7dc4";
        ctx.fillRect(x(i) - bw / 2, y(v), bw, y1 - y(v));
        if (data.snow_rate[i] > 0.05) { ctx.fillStyle = "#c9b8ff"; const sv = conv(data.snow_rate[i], "mm").v; ctx.fillRect(x(i) - bw / 2, y(sv), bw, y1 - y(sv)); }
      }
      P.series = [P.line];
    }
    for (const [nm, col, dash] of P.series || []) {
      ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.setLineDash(dash ? [4, 3] : []);
      ctx.beginPath();
      let pen = false;
      for (let i = 0; i < n; ++i) {
        const v = conv(data[nm][i], P.unit === "mm" ? "mm" : P.unit).v;
        if (!Number.isFinite(v)) { pen = false; continue; }
        if (pen) ctx.lineTo(x(i), y(v)); else ctx.moveTo(x(i), y(v));
        pen = true;
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (k === 1) {
      // wind direction arrows along the top of the panel
      const every = Math.max(1, Math.ceil(n / 24));
      ctx.strokeStyle = text; ctx.lineWidth = 1.3;
      for (let i = 0; i < n; i += every) {
        const u = data.u10[i], v = data.v10[i], sp = Math.hypot(u, v);
        if (!(sp > 0.3)) continue;
        const cx = x(i), cy = y0 + 14, ux = u / sp, uy = -v / sp;
        ctx.beginPath();
        ctx.moveTo(cx - 6 * ux, cy - 6 * uy); ctx.lineTo(cx + 6 * ux, cy + 6 * uy);
        ctx.lineTo(cx + 6 * ux - 4 * (ux - 0.6 * uy), cy + 6 * uy - 4 * (uy + 0.6 * ux));
        ctx.stroke();
      }
    }
  });
  // the time axis
  ctx.fillStyle = muted;
  const yA = 8 + 4 * (PH + G) - 4;
  const step = Math.max(1, Math.ceil(n / 8));
  for (let i = 0; i < n; i += step) {
    const lbl = fmtTime(s.times[i]).replace(/ \(.*\)$/, "");
    ctx.fillText(lbl, Math.min(W - 60, x(i) - 18), yA);
  }
}

// Skew-T log-p: temperature, dew point, the surface parcel, dry adiabats, moist adiabats, wind barbs
function skewT(c, snd, sfc) {
  const [ctx, W] = setup(c, 520, 420);
  const H = 420, L = 36, R = 46, T = 8, B = 22;
  const pT = 100, pB = 1050;
  const yp = (p) => T + (H - T - B) * Math.log(p / pT) / Math.log(pB / pT);
  const skew = 0.95 * (W - L - R) / 1.0;
  const xT = (tc, p) => L + (W - L - R) * (tc + 40) / 80 + skew * (1 - (yp(p) - T) / (H - T - B)) * 0.55;
  const muted = css("--muted"), line = css("--line"), text = css("--text");
  ctx.save();
  ctx.beginPath(); ctx.rect(L, T, W - L - R, H - T - B); ctx.clip();
  // isotherms, dry adiabats, moist adiabats
  ctx.lineWidth = 1;
  for (let tc = -120; tc <= 50; tc += 10) {
    ctx.strokeStyle = tc === 0 ? "rgba(79,163,255,0.6)" : line;
    ctx.beginPath(); ctx.moveTo(xT(tc, pB), yp(pB)); ctx.lineTo(xT(tc, pT), yp(pT)); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(224,112,58,0.25)";
  for (let th = -30; th <= 150; th += 10) {
    ctx.beginPath();
    for (let p = pB; p >= pT; p -= 10) { const tk = (th + 273.15) * (p / 1000) ** 0.2857 - 273.15; p === pB ? ctx.moveTo(xT(tk, p), yp(p)) : ctx.lineTo(xT(tk, p), yp(p)); }
    ctx.stroke();
  }
  ctx.strokeStyle = "rgba(63,191,127,0.25)"; ctx.setLineDash([3, 3]);
  for (let t0 = -10; t0 <= 32; t0 += 6) {
    ctx.beginPath();
    let tk = t0 + 273.15;
    for (let p = 1000; p >= 200; p -= 10) { p === 1000 ? ctx.moveTo(xT(tk - 273.15, p), yp(p)) : ctx.lineTo(xT(tk - 273.15, p), yp(p)); tk -= moistLapse(tk, p) * 10; }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  // the profiles
  const prof = snd.filter((l) => Number.isFinite(l.t));
  const draw = (key, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 2.2; ctx.beginPath();
    let pen = false;
    for (const l of prof) { if (!Number.isFinite(l[key])) { pen = false; continue; } pen ? ctx.lineTo(xT(l[key], l.p), yp(l.p)) : ctx.moveTo(xT(l[key], l.p), yp(l.p)); pen = true; }
    ctx.stroke();
  };
  draw("t", "#e0703a");
  draw("td", "#3fbf7f");
  // the surface parcel: dry adiabat to the LCL, then the pseudoadiabat
  if (Number.isFinite(sfc.t) && Number.isFinite(sfc.td) && Number.isFinite(sfc.p)) {
    const tk = sfc.t + 273.15, tdk = sfc.td + 273.15;
    const tl = 1 / (1 / (tdk - 56) + Math.log(tk / tdk) / 800) + 56;
    const pl = sfc.p * (tl / tk) ** 3.5;
    ctx.strokeStyle = text; ctx.lineWidth = 1.4; ctx.setLineDash([5, 4]); ctx.beginPath();
    ctx.moveTo(xT(sfc.t, sfc.p), yp(sfc.p)); ctx.lineTo(xT(tl - 273.15, pl), yp(pl));
    let tp = tl;
    for (let p = pl; p >= pT; p -= 5) { ctx.lineTo(xT(tp - 273.15, p), yp(p)); tp -= moistLapse(tp, p) * 5; }
    ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
  // axes, labels, barbs
  ctx.fillStyle = muted;
  for (const p of [1000, 850, 700, 500, 300, 200, 100]) { ctx.fillText(String(p), 2, yp(p) + 4); ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(L, yp(p)); ctx.lineTo(W - R, yp(p)); ctx.stroke(); }
  for (let tc = -40; tc <= 40; tc += 20) ctx.fillText(`${tc}°`, xT(tc, pB) - 8, H - 6);
  for (const l of prof) if (Number.isFinite(l.u) && l.p >= pT) barb(ctx, W - R / 2, yp(l.p), l.u, l.v, text);
}
// the pseudoadiabatic lapse rate dT/dp (K per hPa) at T (K) and p (hPa)
function moistLapse(tk, p) {
  const es = 6.112 * Math.exp(17.67 * (tk - 273.15) / (tk - 29.65)), rs = 0.622 * es / (p - es);
  const Lv = 2.501e6, Rd = 287.04, cp = 1005.7, eps = 0.622;
  return (Rd * tk / p + Lv * rs / p) / (cp + Lv * Lv * rs * eps / (Rd * tk * tk));
}
// a wind barb (knots: pennant 50, full 10, half 5) pointing into the wind
export function barb(ctx, x, y, u, v, col, len = 18) {
  const kt = Math.hypot(u, v) * 1.943844;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(Math.atan2(-u, v) + Math.PI);
  ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1.2;
  if (kt < 2.5) { ctx.beginPath(); ctx.arc(0, 0, 3, 0, 2 * Math.PI); ctx.stroke(); ctx.restore(); return; }
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -len); ctx.stroke();
  let r = Math.round(kt / 5) * 5, pos = -len;
  while (r >= 50) { ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(8, pos + 3); ctx.lineTo(0, pos + 6); ctx.fill(); pos += 7; r -= 50; }
  while (r >= 10) { ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(9, pos - 4); ctx.stroke(); pos += 4; r -= 10; }
  if (r >= 5) { if (pos === -len) pos += 3; ctx.beginPath(); ctx.moveTo(0, pos); ctx.lineTo(5, pos - 2); ctx.stroke(); }
  ctx.restore();
}
