// SPDX-License-Identifier: GPL-3.0-or-later
// CPPWRF Forecast: the map page. Talks to the local server (forecast/server/server.cpp) only.
//   - a Web Mercator map drawn from WPS's geography (the server's /api/basemap): water, relief, coastlines
//   - the chosen run's fields (wrfpost products on a latitude-longitude grid) as a colour layer, wind particles,
//     isobars, a time bar and a value probe
//   - the new-forecast form (domain on the map, checks by the server) and the progress of the running forecast
"use strict";

const $ = (id) => document.getElementById(id);
const DEG = Math.PI / 180;

// ---- colour scales: [value, [r, g, b]] stops
const SCALES = {
  wind: { title: "Wind speed at 10 m", unit: "m/s", stops: [[0, [40, 64, 125]], [3, [36, 110, 168]], [6, [32, 158, 160]],
    [9, [80, 184, 104]], [12, [196, 196, 72]], [15, [232, 150, 52]], [19, [216, 76, 64]], [24, [176, 46, 112]],
    [30, [120, 50, 150]]], ticks: [0, 5, 10, 15, 20, 25, 30] },
  t2: { title: "Temperature at 2 m", unit: "°C", stops: [[-30, [110, 60, 160]], [-20, [70, 80, 190]], [-10, [52, 128, 214]],
    [0, [90, 196, 220]], [8, [120, 200, 140]], [15, [210, 210, 100]], [22, [240, 160, 70]], [30, [222, 84, 60]],
    [40, [150, 30, 60]]], ticks: [-30, -20, -10, 0, 10, 20, 30, 40] },
  rain: { title: "Rain rate", unit: "mm/h", log: true, stops: [[0.1, [90, 150, 230]], [0.5, [60, 110, 220]], [1, [50, 170, 150]],
    [2, [110, 200, 80]], [5, [235, 210, 60]], [10, [240, 130, 50]], [20, [220, 50, 60]], [40, [190, 60, 190]]],
    ticks: [0.1, 0.5, 1, 2, 5, 10, 20, 40] },
  rh2: { title: "Relative humidity at 2 m", unit: "%", stops: [[0, [150, 100, 60]], [30, [200, 160, 100]], [50, [190, 200, 140]],
    [70, [90, 180, 150]], [85, [50, 140, 190]], [100, [40, 80, 170]]], ticks: [0, 20, 40, 60, 80, 100] },
  mslp: { title: "Pressure at sea level", unit: "hPa", stops: [[970, [110, 60, 160]], [990, [60, 110, 200]], [1005, [80, 170, 170]],
    [1015, [150, 190, 120]], [1025, [220, 180, 90]], [1040, [210, 90, 70]]], ticks: [970, 990, 1010, 1030] },
  cloud: { title: "Cloud cover (column maximum)", unit: "%", stops: [[0, [20, 30, 45]], [30, [80, 92, 110]], [70, [170, 178, 190]],
    [100, [235, 238, 242]]], ticks: [0, 25, 50, 75, 100] },
};
const LAYERS = [
  ["wind", "Wind", '<path d="M3 9h11a3 3 0 1 0-3-3M3 14h15a3 3 0 1 1-3 3M3 19h7"/>'],
  ["t2", "Temperature", '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>'],
  ["rain", "Rain", '<path d="M7 17a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 9a4 4 0 0 1 0 8M8 20l1-2M12 21l1-2M16 20l1-2"/>'],
  ["rh2", "Humidity", '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>'],
  ["mslp", "Pressure", '<circle cx="12" cy="12" r="8"/><path d="M12 12l4-3"/>'],
  ["cloud", "Clouds", '<path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 10a4 4 0 0 1 0 8z"/>'],
];
const FIELD_INDEX = { u10: 0, v10: 1, t2: 2, rain: 3, rh2: 4, mslp: 5, cloud: 6 };

function lut(scale) {  // 256 colours over the scale's range
  const s = scale.stops, lo = s[0][0], hi = s[s.length - 1][0], out = new Uint8ClampedArray(256 * 3);
  const f = scale.log ? Math.log : (x) => x;
  for (let n = 0; n < 256; ++n) {
    const v = scale.log ? Math.exp(f(lo) + (f(hi) - f(lo)) * n / 255) : lo + (hi - lo) * n / 255;
    let i = 0;
    while (i < s.length - 2 && v > s[i + 1][0]) ++i;
    const t = Math.max(0, Math.min(1, (f(v) - f(s[i][0])) / (f(s[i + 1][0]) - f(s[i][0]))));
    for (let c = 0; c < 3; ++c) out[3 * n + c] = s[i][1][c] + t * (s[i + 1][1][c] - s[i][1][c]);
  }
  scale.lut = out;
  scale.index = scale.log
    ? (v) => Math.round(255 * (Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)))
    : (v) => Math.round(255 * (v - lo) / (hi - lo));
}
Object.values(SCALES).forEach(lut);

// ---- the map: Web Mercator, world x, y in [0, 1]
const view = { cx: 0, cy: 0, s: 2400 };  // s: pixels per world width
const mx = (lon) => (lon + 180) / 360;
const my = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + lat * DEG / 2)) / Math.PI) / 2;
const lonOf = (x) => x * 360 - 180;
const latOf = (y) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) / DEG;
function centreOn(lat, lon, spanKm) {
  view.cx = mx(lon); view.cy = my(lat);
  const W = innerWidth;
  view.s = W / ((spanKm / (111.2 * Math.cos(lat * DEG))) / 360);
}
const toScreen = (lat, lon) => [(mx(lon) - view.cx) * view.s + innerWidth / 2, (my(lat) - view.cy) * view.s + innerHeight / 2];
const toLatLon = (px, py) => [latOf(view.cy + (py - innerHeight / 2) / view.s), lonOf(view.cx + (px - innerWidth / 2) / view.s)];

let BASE = null;  // {water, height} Uint8Array [2160][4320], south first, x from 180 W
const BW = 4320, BH = 2160;

const canvases = { base: $("base"), flow: $("flow"), over: $("over") };
function sizeCanvases() {
  const dpr = Math.min(2, devicePixelRatio || 1);
  for (const c of Object.values(canvases)) {
    c.width = Math.round(innerWidth * (c === canvases.base ? 1 : dpr));
    c.height = Math.round(innerHeight * (c === canvases.base ? 1 : dpr));
  }
  canvases.flow.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
  canvases.over.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
}

// ---- the selected run
const state = { layer: "wind", run: null, meta: null, stat: null, frames: [], t: 0, pick: null,
                backend: "gpu-fp32", suite: "CONUS" };

function fieldAt(k, lat, lon) {  // bilinear on the products grid; NaN outside
  const m = state.meta, fr = state.frames[state.t];
  if (!m || !fr) return NaN;
  const r = (lat - m.lat0) / m.dlat, c = (lon - m.lon0) / m.dlon;
  if (r < 0 || c < 0 || r > m.nlat - 1 || c > m.nlon - 1) return NaN;
  const i = Math.min(Math.floor(c), m.nlon - 2), j = Math.min(Math.floor(r), m.nlat - 2), a = c - i, b = r - j;
  const n = m.nlat * m.nlon, o = k * n + j * m.nlon + i;
  return (1 - b) * ((1 - a) * fr[o] + a * fr[o + 1]) + b * ((1 - a) * fr[o + m.nlon] + a * fr[o + m.nlon + 1]);
}
function layerValue(lat, lon) {
  if (state.layer === "wind") {
    const u = fieldAt(0, lat, lon), v = fieldAt(1, lat, lon);
    return Math.hypot(u, v);
  }
  return fieldAt(FIELD_INDEX[state.layer], lat, lon);
}

// ---- the base canvas: water, relief, coastlines, and the colour layer (one pixel per CSS pixel)
let baseQueued = false;
function drawBase() {
  if (baseQueued) return;
  baseQueued = true;
  requestAnimationFrame(() => { baseQueued = false; paintBase(); });
}
function paintBase() {
  const c = canvases.base, W = c.width, H = c.height, ctx = c.getContext("2d");
  const img = ctx.createImageData(W, H), d = img.data;
  const lats = new Float64Array(H), lons = new Float64Array(W);
  for (let y = 0; y < H; ++y) lats[y] = latOf(view.cy + (y - H / 2) / view.s);
  for (let x = 0; x < W; ++x) { let l = lonOf(view.cx + (x - W / 2) / view.s); l = ((l + 540) % 360) - 180; lons[x] = l; }
  const wet = new Uint8Array(W * H);
  const m = state.meta, fr = state.frames[state.t], sc = SCALES[state.layer];
  const n = m ? m.nlat * m.nlon : 0;
  for (let y = 0; y < H; ++y) {
    const lat = lats[y];
    if (lat < -89.9 || lat > 89.9) continue;
    const by = (lat + 90) * 12 - 0.5, j0 = Math.max(0, Math.min(BH - 2, Math.floor(by))), fb = by - j0;
    const rr = m ? (lat - m.lat0) / m.dlat : -1;
    for (let x = 0; x < W; ++x) {
      const lon = lons[x], bx = (lon + 180) * 12 - 0.5;
      const i0 = ((Math.floor(bx) % BW) + BW) % BW, i1 = (i0 + 1) % BW, fa = bx - Math.floor(bx);
      let water = 0, h = 0, hs = 0;
      if (BASE) {
        const o0 = j0 * BW, o1 = o0 + BW;
        water = (1 - fb) * ((1 - fa) * BASE.water[o0 + i0] + fa * BASE.water[o0 + i1]) +
                fb * ((1 - fa) * BASE.water[o1 + i0] + fa * BASE.water[o1 + i1]);
        h = (1 - fb) * ((1 - fa) * BASE.height[o0 + i0] + fa * BASE.height[o0 + i1]) +
            fb * ((1 - fa) * BASE.height[o1 + i0] + fa * BASE.height[o1 + i1]);
        hs = (1 - fb) * ((1 - fa) * BASE.shade[o0 + i0] + fa * BASE.shade[o0 + i1]) +
             fb * ((1 - fa) * BASE.shade[o1 + i0] + fa * BASE.shade[o1 + i1]);
      }
      const sea = water > 50;
      wet[y * W + x] = sea ? 1 : 0;
      // hillshade from the north-west
      const shade = hs / 127;
      let r, g, b;
      if (sea) { r = 11; g = 22; b = 36; }
      else { const e = Math.min(1, h / 120); r = 36 + 22 * e + 26 * shade; g = 41 + 18 * e + 26 * shade; b = 48 + 10 * e + 24 * shade; }
      // the colour layer
      if (m && fr && rr >= 0 && rr <= m.nlat - 1) {
        const cc = (lon - m.lon0) / m.dlon;
        if (cc >= 0 && cc <= m.nlon - 1) {
          const i = Math.min(Math.floor(cc), m.nlon - 2), j = Math.min(Math.floor(rr), m.nlat - 2), a = cc - i, bb = rr - j;
          const samp = (k) => { const o = k * n + j * m.nlon + i;
            return (1 - bb) * ((1 - a) * fr[o] + a * fr[o + 1]) + bb * ((1 - a) * fr[o + m.nlon] + a * fr[o + m.nlon + 1]); };
          let v = state.layer === "wind" ? Math.hypot(samp(0), samp(1)) : samp(FIELD_INDEX[state.layer]);
          const show = v === v && !(state.layer === "rain" && v < 0.1) && !(state.layer === "cloud" && v < 8);
          if (show) {
            const q = Math.max(0, Math.min(255, sc.index(v))), L = sc.lut;
            const alpha = state.layer === "cloud" ? Math.min(0.85, v / 100) : 0.86;
            const lit = sea ? 1 : 0.9 + 0.12 * shade;
            r = r * (1 - alpha) + L[3 * q] * alpha * lit;
            g = g * (1 - alpha) + L[3 * q + 1] * alpha * lit;
            b = b * (1 - alpha) + L[3 * q + 2] * alpha * lit;
          }
        }
      }
      const o = 4 * (y * W + x);
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  // coastlines: where the water mask changes
  for (let y = 0; y < H - 1; ++y)
    for (let x = 0; x < W - 1; ++x) {
      const k = y * W + x;
      if (wet[k] !== wet[k + 1] || wet[k] !== wet[k + W]) {
        const o = 4 * k;
        d[o] = d[o] * 0.45 + 200 * 0.55; d[o + 1] = d[o + 1] * 0.45 + 214 * 0.55; d[o + 2] = d[o + 2] * 0.45 + 230 * 0.55;
      }
    }
  ctx.putImageData(img, 0, 0);
  drawOver();
  resetParticles();
}

// ---- the overlay: graticule, the domain (the run's outline or the new domain), isobars
function newDomainCorners() {
  const p = state.pick;
  if (!p) return null;
  const dx = +$("dx").value, hx = +$("nx").value * dx / 2, hy = +$("ny").value * dx / 2;
  const dlat = hy / 111.2, dlon = hx / (111.2 * Math.cos(p.lat * DEG));
  const pts = [];
  for (let k = 0; k <= 16; ++k) pts.push([p.lat - dlat, p.lon - dlon + 2 * dlon * k / 16]);
  for (let k = 0; k <= 16; ++k) pts.push([p.lat - dlat + 2 * dlat * k / 16, p.lon + dlon]);
  for (let k = 0; k <= 16; ++k) pts.push([p.lat + dlat, p.lon + dlon - 2 * dlon * k / 16]);
  for (let k = 0; k <= 16; ++k) pts.push([p.lat + dlat - 2 * dlat * k / 16, p.lon - dlon]);
  return pts;
}
function path(ctx, pts) {
  ctx.beginPath();
  pts.forEach(([la, lo], k) => { const [x, y] = toScreen(la, lo); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
  ctx.closePath();
}
function drawOver() {
  const ctx = canvases.over.getContext("2d"), W = innerWidth, H = innerHeight;
  ctx.clearRect(0, 0, W, H);
  // graticule
  const [lat0, lon0] = toLatLon(0, H), [lat1, lon1] = toLatLon(W, 0);
  const span = lon1 - lon0, step = span > 120 ? 30 : span > 40 ? 10 : span > 15 ? 5 : span > 6 ? 2 : 1;
  ctx.strokeStyle = "rgba(255,255,255,0.06)";
  ctx.lineWidth = 1;
  ctx.fillStyle = "rgba(255,255,255,0.32)";
  ctx.font = "10.5px 'JetBrains Mono', monospace";
  for (let lo = Math.ceil(lon0 / step) * step; lo <= lon1; lo += step) {
    const [x] = toScreen(0, lo);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.fillText(`${Math.abs(lo)}°${lo < 0 ? "W" : lo > 0 ? "E" : ""}`, x + 4, H - 8);
  }
  for (let la = Math.ceil(Math.max(-85, lat0) / step) * step; la <= Math.min(85, lat1); la += step) {
    const [, y] = toScreen(la, 0);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.fillText(`${Math.abs(la)}°${la < 0 ? "S" : la > 0 ? "N" : ""}`, W - 44, y - 4);
  }
  // isobars of the pressure layer (every 2 hPa, marching squares on the products grid)
  if (state.layer === "mslp" && state.meta && state.frames[state.t]) drawIsobars(ctx);
  // the run's domain
  if (state.meta) {
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.setLineDash([]);
    ctx.lineWidth = 1.2;
    path(ctx, state.meta.outline);
    ctx.stroke();
  }
  // the new domain
  const pts = newDomainCorners();
  if (pts && activeTab === "new") {
    path(ctx, pts);
    ctx.fillStyle = "rgba(124,196,255,0.08)";
    ctx.fill();
    ctx.strokeStyle = "#7cc4ff";
    ctx.lineWidth = 1.6;
    ctx.setLineDash([6, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
    const [x, y] = toScreen(state.pick.lat, state.pick.lon);
    ctx.fillStyle = "#7cc4ff";
    ctx.beginPath(); ctx.arc(x, y, 4, 0, 2 * Math.PI); ctx.fill();
  }
}
function drawIsobars(ctx) {
  const m = state.meta, fr = state.frames[state.t], n = m.nlat * m.nlon, o = 5 * n;
  const v = (j, i) => fr[o + j * m.nlon + i];
  ctx.strokeStyle = "rgba(255,255,255,0.7)";
  ctx.lineWidth = 1;
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  const f = m.fields[5], lo = Math.ceil(f.min / 2) * 2, labelled = new Set();
  for (let level = lo; level <= f.max; level += 2) {
    ctx.beginPath();
    for (let j = 0; j < m.nlat - 1; ++j)
      for (let i = 0; i < m.nlon - 1; ++i) {
        const a = v(j, i), b = v(j, i + 1), c = v(j + 1, i + 1), d = v(j + 1, i);
        if (!(a === a && b === b && c === c && d === d)) continue;
        const pts = [];
        const edge = (p, q, x0, y0, x1, y1) => {
          if ((p - level) * (q - level) < 0) { const t = (level - p) / (q - p); pts.push([y0 + t * (y1 - y0), x0 + t * (x1 - x0)]); }
        };
        edge(a, b, i, j, i + 1, j); edge(b, c, i + 1, j, i + 1, j + 1); edge(d, c, i, j + 1, i + 1, j + 1); edge(a, d, i, j, i, j + 1);
        for (let k = 0; k + 1 < pts.length; k += 2) {
          const [x0, y0] = toScreen(m.lat0 + pts[k][0] * m.dlat, m.lon0 + pts[k][1] * m.dlon);
          const [x1, y1] = toScreen(m.lat0 + pts[k + 1][0] * m.dlat, m.lon0 + pts[k + 1][1] * m.dlon);
          ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
          if (!labelled.has(level) && i % 17 === 5) { labelled.add(level); ctx.fillText(String(level), x0 + 3, y0 - 3); }
        }
      }
    ctx.stroke();
  }
}

// ---- wind particles (screen space; on every layer, brightest on the wind layer)
let particles = [];
function resetParticles() {
  particles = [];
  const ctx = canvases.flow.getContext("2d");
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  if (!state.meta || !state.frames[state.t]) return;
  const xs = state.meta.outline.map(([la, lo]) => toScreen(la, lo));
  const x0 = Math.max(0, Math.min(...xs.map((p) => p[0]))), x1 = Math.min(innerWidth, Math.max(...xs.map((p) => p[0])));
  const y0 = Math.max(0, Math.min(...xs.map((p) => p[1]))), y1 = Math.min(innerHeight, Math.max(...xs.map((p) => p[1])));
  if (x1 <= x0 || y1 <= y0) return;
  const count = Math.min(5000, Math.round((x1 - x0) * (y1 - y0) / 150));
  state.box = [x0, y0, x1, y1];
  for (let k = 0; k < count; ++k) particles.push(spawn({}));
}
function spawn(p) {
  const [x0, y0, x1, y1] = state.box;
  p.x = x0 + Math.random() * (x1 - x0); p.y = y0 + Math.random() * (y1 - y0); p.age = Math.floor(Math.random() * 80);
  return p;
}
function animate() {
  const ctx = canvases.flow.getContext("2d");
  if (particles.length) {
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.9)";
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.globalCompositeOperation = "source-over";
    const wind = state.layer === "wind";
    ctx.strokeStyle = wind ? "rgba(255,255,255,0.82)" : "rgba(255,255,255,0.38)";
    ctx.lineWidth = wind ? 1.1 : 0.8;
    ctx.beginPath();
    for (const p of particles) {
      const [lat, lon] = toLatLon(p.x, p.y), u = fieldAt(0, lat, lon), v = fieldAt(1, lat, lon);
      if (!(u === u) || ++p.age > 90) { spawn(p); p.age = 0; continue; }
      const nx = p.x + u * 0.22, ny = p.y - v * 0.22;
      ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny);
      p.x = nx; p.y = ny;
    }
    ctx.stroke();
  }
  requestAnimationFrame(animate);
}

// ---- interaction: pan, zoom, pick, probe
let drag = null, activeTab = "new";
const mapEl = $("map");
mapEl.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, moved: false }; mapEl.setPointerCapture(e.pointerId); });
mapEl.addEventListener("pointermove", (e) => {
  if (drag) {
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) { drag.moved = true; mapEl.classList.add("dragging"); }
    if (drag.moved) { view.cx = drag.cx - dx / view.s; view.cy = drag.cy - dy / view.s; drawBase(); }
  }
  probe(e);
});
mapEl.addEventListener("pointerup", (e) => {
  mapEl.classList.remove("dragging");
  if (drag && !drag.moved && activeTab === "new" && !runningJob) {
    const [lat, lon] = toLatLon(e.clientX, e.clientY);
    state.pick = { lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 };
    formChanged();
  }
  drag = null;
});
mapEl.addEventListener("pointerleave", () => { $("probe").hidden = true; });
mapEl.addEventListener("wheel", (e) => {
  e.preventDefault();
  const k = Math.exp(-e.deltaY * 0.0015), [lat, lon] = toLatLon(e.clientX, e.clientY);
  view.s = Math.max(innerWidth, Math.min(2e6, view.s * k));
  // keep the point under the cursor
  view.cx = mx(lon) - (e.clientX - innerWidth / 2) / view.s;
  view.cy = my(lat) - (e.clientY - innerHeight / 2) / view.s;
  drawBase();
}, { passive: false });
addEventListener("resize", () => { sizeCanvases(); drawBase(); });

const compass = (u, v) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(((Math.atan2(-u, -v) / DEG + 360) % 360) / 45) % 8];
function probe(e) {
  const el = $("probe");
  if (!state.meta || !state.frames[state.t]) { el.hidden = true; return; }
  const [lat, lon] = toLatLon(e.clientX, e.clientY), u = fieldAt(0, lat, lon);
  if (!(u === u)) { el.hidden = true; return; }
  const v = fieldAt(1, lat, lon), sp = Math.hypot(u, v);
  const rows = [
    `${sp.toFixed(1)} m/s ${compass(u, v)}`,
    `${fieldAt(2, lat, lon).toFixed(1)} °C`,
    `${fieldAt(3, lat, lon).toFixed(1)} mm/h`,
    `${fieldAt(4, lat, lon).toFixed(0)} %`,
    `${fieldAt(5, lat, lon).toFixed(1)} hPa`,
  ];
  el.innerHTML = `<b>${lat.toFixed(2)}, ${lon.toFixed(2)}</b><br>` + rows.join(" · ");
  el.style.left = e.clientX + "px";
  el.style.top = e.clientY + "px";
  el.hidden = false;
}

// ---- layers, legend, time
function buildLayers() {
  $("layers").innerHTML = LAYERS.map(([k, label, icon]) =>
    `<button type="button" data-layer="${k}" aria-pressed="${k === state.layer}"><svg viewBox="0 0 24 24">${icon}</svg><span>${label}</span></button>`).join("");
  $("layers").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    state.layer = b.dataset.layer;
    $("layers").querySelectorAll("button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    legend();
    drawBase();
  }));
}
function legend() {
  const sc = SCALES[state.layer], L = sc.lut, stops = [];
  for (let n = 0; n <= 20; ++n) { const q = Math.round(n * 255 / 20); stops.push(`rgb(${L[3 * q]},${L[3 * q + 1]},${L[3 * q + 2]})`); }
  $("legend-title").textContent = `${sc.title} · ${sc.unit}`;
  $("legend-ramp").style.background = `linear-gradient(90deg,${stops.join(",")})`;
  $("legend-ticks").innerHTML = sc.ticks.map((t) => `<span>${t}</span>`).join("");
  $("legend").hidden = !state.meta;
}
const fmtLocal = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
function setTime(k) {
  state.t = k;
  $("time").value = String(k);
  const t = state.meta.times[k], t0 = state.meta.times[0];
  $("t-local").textContent = fmtLocal(t);
  $("t-lead").textContent = `+${Math.round((Date.parse(t) - Date.parse(t0)) / 36e5)} h · ${t.slice(11, 16)} UTC`;
  drawBase();
}
let playing = null;
$("play").addEventListener("click", () => {
  if (playing) { clearInterval(playing); playing = null; $("play-icon").setAttribute("d", "M8 5v14l11-7z"); return; }
  $("play-icon").setAttribute("d", "M7 5h4v14H7zM13 5h4v14h-4z");
  playing = setInterval(() => setTime((state.t + 1) % state.meta.times.length), 900);
});
$("time").addEventListener("input", (e) => setTime(+e.target.value));

async function loadRun(id) {
  const meta = await (await fetch(`/api/runs/${id}/meta.json`)).json();
  const frames = await Promise.all(meta.times.map((_, k) =>
    fetch(`/api/runs/${id}/frame_${String(k).padStart(3, "0")}.bin`).then((r) => r.arrayBuffer()).then((b) => new Float32Array(b))));
  state.run = id; state.meta = meta; state.frames = frames; state.t = 0;
  $("timebar").hidden = false;
  $("time").max = String(meta.times.length - 1);
  const step = Math.max(1, Math.ceil(meta.times.length / 8));
  $("time-ticks").innerHTML = meta.times.map((t, k) => k % step ? "" :
    `<span style="left:${(100 * k) / Math.max(1, meta.times.length - 1)}%">${new Date(t).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span>`).join("");
  $("dl").href = `/api/runs/${id}/wrfout`;
  const lat = meta.lat0 + meta.dlat * meta.nlat / 2, lon = meta.lon0 + meta.dlon * meta.nlon / 2;
  centreOn(lat, lon, meta.dlon * meta.nlon * 111.2 * Math.cos(lat * DEG) * 1.7);
  legend();
  setTime(0);
  refreshRuns();
}

// ---- the new-forecast form
const out = (id, v) => { $(id).textContent = v; };
let estTimer = null;
function formChanged() {
  const dx = +$("dx").value, nx = +$("nx").value, ny = +$("ny").value;
  out("o-dx", `${dx} km`); out("o-nx", nx); out("o-ny", ny); out("o-nz", $("nz").value); out("o-hours", `${$("hours").value} h`);
  out("o-centre", state.pick ? `${state.pick.lat.toFixed(2)}°, ${state.pick.lon.toFixed(2)}°` : "–");
  out("e-area", `${nx * dx} × ${ny * dx} km`);
  $("pick-hint").textContent = state.pick ? "Drag the map to look around; click to move the centre." : "Click the map to place the centre of the domain.";
  drawOver();
  clearTimeout(estTimer);
  estTimer = setTimeout(estimate, 250);
}
function body() {
  return JSON.stringify({ lat: state.pick.lat, lon: state.pick.lon, dx_km: +$("dx").value, nx: +$("nx").value,
    ny: +$("ny").value, nz: +$("nz").value, hours: +$("hours").value, backend: state.backend, suite: state.suite });
}
async function estimate() {
  if (!state.pick) { $("start").disabled = true; return; }
  const r = await (await fetch("/api/estimate", { method: "POST", body: body() })).json();
  out("e-gpu", state.backend === "gpu-fp32" ? `${r.gpu_gb.toFixed(1)} GB` : "CPU");
  out("e-disk", `${r.disk_gb.toFixed(2)} GB`);
  const msg = $("est-msg");
  msg.hidden = r.ok;
  msg.className = "msg";
  msg.textContent = r.ok ? "" : r.error + (r.suggestion ? `\n→ ${r.suggestion}` : "");
  $("start").disabled = !r.ok || !!runningJob;
}
["dx", "nx", "ny", "nz", "hours"].forEach((id) => $(id).addEventListener("input", formChanged));
document.querySelectorAll("[data-backend]").forEach((b) => b.addEventListener("click", () => {
  state.backend = b.dataset.backend;
  document.querySelectorAll("[data-backend]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  formChanged();
}));
document.querySelectorAll("[data-suite]").forEach((b) => b.addEventListener("click", () => {
  state.suite = b.dataset.suite;
  document.querySelectorAll("[data-suite]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  formChanged();
}));
$("start").addEventListener("click", async () => {
  $("start").disabled = true;
  const r = await fetch("/api/runs", { method: "POST", body: body() });
  const j = await r.json();
  if (!r.ok) {
    const msg = $("est-msg");
    msg.hidden = false; msg.className = "msg";
    msg.textContent = j.error + (j.suggestion ? `\n→ ${j.suggestion}` : "");
    $("start").disabled = false;
    return;
  }
  watch(j.id);
});

// tabs
document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => {
  activeTab = b.dataset.tab;
  document.querySelectorAll("[data-tab]").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
  document.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== activeTab));
  mapEl.classList.toggle("picking", activeTab === "new");
  drawOver();
}));

// ---- the running forecast
const STAGES = [["download", "GFS"], ["wps", "WPS"], ["real", "real"], ["model", "Model"], ["post", "Map"]];
let runningJob = null, pollTimer = null;
function parseState(s) {
  const p = s.split(" ");
  if (p[0] === "done") return { done: true };
  if (p[0] === "failed") return { failed: true, stage: p[1], text: p.slice(2).join(" ") };
  return { stage: p[1], pct: +p[2] || 0 };
}
function watch(id) {
  runningJob = id;
  $("job").hidden = false;
  $("start").disabled = true;
  clearInterval(pollTimer);
  pollTimer = setInterval(() => poll(id), 1500);
  poll(id);
}
async function poll(id) {
  const r = await fetch(`/api/runs/${id}`);
  if (!r.ok) return;
  const j = await r.json(), st = parseState(j.state), p = j.params;
  $("job-title").textContent = st.done ? "Forecast ready" : st.failed ? "Forecast stopped" : "Forecast running";
  $("job-sub").textContent = `${p.nx}×${p.ny}×${p.nz} · ${p.dx_km} km · ${p.hours} h · ${p.backend} · GFS ${p.cycle.slice(0, 8)} ${p.cycle.slice(8)}Z`;
  const k = st.done ? STAGES.length : Math.max(0, STAGES.findIndex(([s]) => s === st.stage));
  $("stages").innerHTML = STAGES.map(([s, label], i) => {
    const cls = st.done || i < k ? "done" : i === k ? (st.failed ? "fail" : "now") : "";
    const w = i === k && !st.failed && !st.done ? st.pct : 0;
    return `<li class="${cls}">${label}<div class="bar"><i style="width:${cls === "done" || cls === "fail" ? 100 : w}%"></i></div></li>`;
  }).join("");
  $("job-log").textContent = j.log || "";
  const msg = $("job-msg");
  if (st.failed) {
    msg.hidden = false;
    const tr = (j.translator || "").trim().split("\n"), errs = tr.filter((l) => l.includes("[ERROR]"));
    msg.textContent = st.text + (tr[0] ? `\n\nTranslator:\n${(errs.length ? errs : tr.slice(-8)).join("\n")}` : "");
  } else msg.hidden = true;
  $("cancel").textContent = st.done || st.failed ? "Close" : "Cancel";
  if (st.done || st.failed) {
    clearInterval(pollTimer);
    runningJob = null;
    formChanged();
    if (st.done) loadRun(id);
    refreshRuns();
  }
}
$("cancel").addEventListener("click", async () => {
  if (runningJob) await fetch(`/api/runs/${runningJob}/cancel`, { method: "POST" });
  else $("job").hidden = true;
});

// ---- runs list and the system line
async function refreshRuns() {
  const runs = await (await fetch("/api/runs")).json();
  $("runs-count").textContent = runs.length ? `(${runs.length})` : "";
  $("runs").innerHTML = runs.length ? runs.map((r) => {
    const st = parseState(r.state), p = r.params;
    const badge = st.done ? '<span class="badge ok">ready</span>' : st.failed ? '<span class="badge bad">failed</span>' : '<span class="badge run">running</span>';
    return `<div class="run${r.id === state.run ? " active" : ""}" data-id="${r.id}" data-ready="${r.products}">
      <b>${p.lat.toFixed(1)}°, ${p.lon.toFixed(1)}° · ${p.hours} h</b>${badge}
      <span class="meta">${r.id} · ${p.nx}×${p.ny} · ${p.dx_km} km · ${p.backend}</span>
      ${st.done || st.failed ? '<button class="del" type="button">delete</button>' : ""}</div>`;
  }).join("") : '<p class="empty">No forecasts yet.</p>';
  $("runs").querySelectorAll(".run").forEach((el) => {
    el.addEventListener("click", (e) => {
      if (e.target.classList.contains("del")) return;
      if (el.dataset.ready === "true") loadRun(el.dataset.id);
      else watch(el.dataset.id);
    });
    el.querySelector(".del")?.addEventListener("click", async () => {
      await fetch(`/api/runs/${el.dataset.id}/delete`, { method: "POST" });
      if (state.run === el.dataset.id) { state.meta = null; state.frames = []; $("timebar").hidden = true; legend(); drawBase(); }
      refreshRuns();
    });
  });
  const live = runs.find((r) => r.state.startsWith("running"));
  if (live && runningJob !== live.id) watch(live.id);
}
async function info() {
  try {
    const j = await (await fetch("/api/info")).json();
    $("sys").textContent = `${j.gpu.ok ? j.gpu.name.replace("NVIDIA GeForce ", "") + " · " + (j.gpu.free_mib / 1024).toFixed(1) + " GB free" : "no GPU"} · disk ${j.disk_free_gb} GB free`;
    out("e-cycle", j.cycle ? `${j.cycle.slice(0, 4)}-${j.cycle.slice(4, 6)}-${j.cycle.slice(6, 8)} ${j.cycle.slice(8)}Z` : "unavailable");
  } catch { $("sys").textContent = "server not reachable"; }
}

// ---- start
(async function main() {
  sizeCanvases();
  centreOn(39, 32, 3200);
  buildLayers();
  legend();
  formChanged();
  mapEl.classList.add("picking");
  drawBase();
  requestAnimationFrame(animate);
  info();
  setInterval(info, 15000);
  refreshRuns();
  const buf = await (await fetch("/api/basemap")).arrayBuffer();
  BASE = { water: new Uint8Array(buf, 0, BW * BH), height: new Uint8Array(buf, BW * BH, BW * BH) };
  // hillshade, lit from the north-west, once per cell (rows run south to north); interpolated when drawn
  const H = BASE.height, shade = new Int8Array(BW * BH);
  for (let j = 1; j < BH - 1; ++j)
    for (let i = 0; i < BW; ++i) {
      const e = H[j * BW + (i + 1) % BW] - H[j * BW + (i + BW - 1) % BW], n = H[(j + 1) * BW + i] - H[(j - 1) * BW + i];
      shade[j * BW + i] = Math.max(-127, Math.min(127, (n - e) * 6));
    }
  BASE.shade = shade;
  drawBase();
})();
