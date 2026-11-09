// SPDX-License-Identifier: GPL-3.0-or-later
// The page: starts the worker (worker.js), draws the x-z sections it sends on a height axis, keeps the frames for
// replay, and shows the check of the wrfout file against the native build.

const $ = (id) => document.getElementById(id);
const ZTOP_KM = 16, ZROWS = 320;  // display grid: 50 m in height

// the cases: what the page says about them and the colour ranges of their fields (min, max)
const CASES = {
  em_squall2d_x: {
    chips: [["201 × 80", "points"], ["Δx", "250 m"], ["Δt", "3 s · 1200 steps"], ["Kessler", "warm rain"],
            ["TKE", "diffusion"], ["60", "min"]],
    about: "WRF's 2-D squall line (em_squall2d_x): a warm bubble in a sheared, moist sounding grows into a " +
           "line of storms with a cold pool spreading at the ground.",
    where: "the x–z plane of the 2-D domain",
    est: "about one to three minutes on a laptop",
    xkm: 50.25, xtick: 10, scale: { t: [-6, 6], w: [-12, 12], qr: [0, 6] },
  },
  em_quarter_ss: {
    chips: [["41 × 41 × 40", "points"], ["Δx", "2 km"], ["Δt", "12 s · 300 steps"], ["Kessler", "warm rain"],
            ["TKE", "diffusion"], ["60", "min"]],
    about: "WRF's 3-D supercell (em_quarter_ss): a warm bubble in a quarter-circle hodograph grows into a rotating " +
           "storm that splits. The sections cut through the middle of the domain.",
    where: "the x–z plane through the middle row, y = 41 km",
    est: "about two to five minutes on a laptop",
    xkm: 82, xtick: 20, scale: { t: [-8, 8], w: [-30, 30], qr: [0, 8] },
  },
};
let caseName = "em_squall2d_x";

// colour maps (sRGB stops); "mid" is replaced by the theme's neutral colour
const MAPS = {
  rdbu: [[5, 48, 97], [33, 102, 172], [67, 147, 195], [146, 197, 222], "mid", [244, 165, 130], [214, 96, 77],
         [178, 24, 43], [103, 0, 31]],
  puor: [[45, 0, 75], [84, 39, 136], [128, 115, 172], [178, 171, 210], "mid", [253, 184, 99], [224, 130, 20],
         [179, 88, 6], [127, 59, 8]],
  rain: ["mid", [199, 233, 192], [116, 196, 118], [35, 139, 69], [0, 109, 120], [8, 64, 129], [37, 20, 90]],
};
const FIELDS = [
  { key: "t", sym: "θ′", name: "Potential temperature perturbation", unit: "K", map: "rdbu", k: 1, digits: 2 },
  { key: "w", sym: "w", name: "Vertical velocity", unit: "m s⁻¹", map: "puor", k: 1, digits: 2 },
  { key: "qr", sym: "q<sub>r</sub>", name: "Rain water mixing ratio", unit: "g kg⁻¹", map: "rain", k: 1000, digits: 2 },
];

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
function rgb(hex) {
  const h = hex.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}
let LUT = {};
function buildLuts() {
  const mid = rgb(css("--plot-mid"));
  for (const [name, stops0] of Object.entries(MAPS)) {
    const stops = stops0.map((s) => (s === "mid" ? mid : s));
    const lut = new Uint8ClampedArray(256 * 3);
    for (let n = 0; n < 256; ++n) {
      const x = (n / 255) * (stops.length - 1);
      const i = Math.min(stops.length - 2, Math.floor(x)), f = x - i;
      for (let c = 0; c < 3; ++c) lut[3 * n + c] = stops[i][c] + f * (stops[i + 1][c] - stops[i][c]);
    }
    LUT[name] = lut;
  }
}

// ---- panels
const panels = [];
function makePanels() {
  const root = $("panels");
  for (const f of FIELDS) {
    const el = document.createElement("figure");
    el.className = "panel";
    el.innerHTML = `
      <figcaption>
        <span class="sym">${f.sym}</span>
        <span class="pname">${f.name}</span>
        <span class="unit">${f.unit}</span>
        <span class="range mono" data-range></span>
      </figcaption>
      <div class="plot"><canvas aria-label="${f.name}, x-z section"></canvas></div>
      <div class="cbar"><div class="cbar-ramp"></div><div class="cbar-ticks"></div></div>`;
    root.appendChild(el);
    const p = { f, el, canvas: el.querySelector("canvas"), range: el.querySelector("[data-range]"),
                ramp: el.querySelector(".cbar-ramp"), ticks: el.querySelector(".cbar-ticks"),
                off: new OffscreenCanvas(1, ZROWS) };
    panels.push(p);
    new ResizeObserver(() => { sizeCanvas(p); draw(p, frames[shown]); }).observe(el.querySelector(".plot"));
  }
}
// the case's colour ranges: 7 ticks from min to max
function applyCase() {
  const c = CASES[caseName];
  for (const p of panels) {
    [p.f.min, p.f.max] = c.scale[p.f.key];
    const ticks = Array.from({ length: 7 }, (_, n) => p.f.min + ((p.f.max - p.f.min) * n) / 6);
    p.ticks.innerHTML = ticks.map((t, n) => `<span style="left:${(100 * n) / 6}%">${+t.toFixed(1)}</span>`).join("");
  }
  $("chips").innerHTML = c.chips.map(([b, t]) => `<li><b>${b}</b> ${t}</li>`).join("");
  $("case-about").textContent = c.about;
  $("where").textContent = c.where;
  if (!meta) $("status").textContent = `Ready · ${c.est} · nothing leaves this tab`;
  document.querySelectorAll("[data-case]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.case === caseName)));
  for (const p of panels) draw(p, frames[shown]);
}
function paintRamps() {
  for (const p of panels) {
    const lut = LUT[p.f.map], stops = [];
    for (let n = 0; n <= 16; ++n) {
      const j = Math.round((n / 16) * 255);
      stops.push(`rgb(${lut[3 * j]},${lut[3 * j + 1]},${lut[3 * j + 2]})`);
    }
    p.ramp.style.background = `linear-gradient(to right, ${stops.join(",")})`;
  }
}
function sizeCanvas(p) {
  const dpr = window.devicePixelRatio || 1, w = p.canvas.clientWidth;
  p.canvas.width = Math.round(w * dpr);
  p.canvas.height = Math.round(p.canvas.clientHeight * dpr);
}

// one column of the field interpolated to the display rows (linear in height; below the first level: its value)
function render(p, fr) {
  const f = p.f, d = fr[f.key], z = fr.z, nx = d.nx, nz = d.nz;
  if (p.off.width !== nx) p.off = new OffscreenCanvas(nx, ZROWS);
  const ctx = p.off.getContext("2d"), img = ctx.createImageData(nx, ZROWS), lut = LUT[f.map];
  let lo = Infinity, hi = -Infinity;
  for (let n = 0; n < d.data.length; ++n) {
    const v = d.data[n] * f.k;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const stagW = nz === z.nz + 1;  // w: on the w levels, half a level below each mass level
  for (let i = 0; i < nx; ++i) {
    const zc = (k) => (stagW ? (k === 0 ? 0 : k >= z.nz ? 2 * z.data[(z.nz - 1) * nx + i] - z.data[(z.nz - 2) * nx + i]
      : 0.5 * (z.data[(k - 1) * nx + i] + z.data[k * nx + i])) : z.data[k * nx + i]);
    let k = 0;
    for (let r = 0; r < ZROWS; ++r) {
      const zr = ((r + 0.5) / ZROWS) * ZTOP_KM * 1000;
      while (k < nz - 2 && zc(k + 1) < zr) ++k;
      const z0 = zc(k), z1 = zc(k + 1);
      let v;
      if (zr <= z0) v = d.data[k * nx + i];
      else {
        const t = Math.min(1, (zr - z0) / (z1 - z0));
        v = d.data[k * nx + i] * (1 - t) + d.data[(k + 1) * nx + i] * t;
      }
      const x = Math.round(((v * f.k - f.min) / (f.max - f.min)) * 255);
      const n = Math.max(0, Math.min(255, x)), o = 4 * ((ZROWS - 1 - r) * nx + i);
      img.data[o] = lut[3 * n]; img.data[o + 1] = lut[3 * n + 1]; img.data[o + 2] = lut[3 * n + 2]; img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return [lo, hi];
}

const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.round(s % 60)).padStart(2, "0")}`;

function draw(p, fr) {
  const c = p.canvas, ctx = c.getContext("2d"), dpr = window.devicePixelRatio || 1;
  if (!c.width || !c.height) return;
  const L = 40 * dpr, R = 8 * dpr, T = 8 * dpr, B = 26 * dpr, pw = c.width - L - R, ph = c.height - T - B;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = css("--plot-mid");
  ctx.fillRect(L, T, pw, ph);
  if (fr) {
    const [lo, hi] = render(p, fr);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(p.off, L, T, pw, ph);
    p.range.textContent = `${lo.toFixed(p.f.digits)} … ${hi.toFixed(p.f.digits)}`;
  } else {
    ctx.fillStyle = css("--muted");
    ctx.font = `${13 * dpr}px Inter, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Run the model to see this field", L + pw / 2, T + ph / 2);
    p.range.textContent = "";
  }
  // axes: x 0..50 km, z 0..16 km
  const cs = CASES[caseName], xmax = cs.xkm;
  ctx.strokeStyle = css("--grid");
  ctx.lineWidth = dpr;
  ctx.fillStyle = css("--muted");
  ctx.font = `${11 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  for (let x = 0; x <= xmax + 1e-6; x += cs.xtick) {
    const px = L + (x / xmax) * pw, last = x + cs.xtick > xmax + 1e-6;
    ctx.beginPath(); ctx.moveTo(px, T + ph); ctx.lineTo(px, T + ph + 4 * dpr); ctx.stroke();
    ctx.fillText(last ? `${x} km` : String(x), Math.min(px, L + pw - 18 * dpr), T + ph + 7 * dpr);
  }
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  for (let z = 0; z <= ZTOP_KM; z += 4) {
    const py = T + ph - (z / ZTOP_KM) * ph;
    ctx.beginPath(); ctx.moveTo(L - 4 * dpr, py); ctx.lineTo(L, py); ctx.stroke();
    ctx.fillText(z === ZTOP_KM ? `${z}` : String(z), L - 7 * dpr, Math.max(py, T + 6 * dpr));
  }
  ctx.save();
  ctx.translate(11 * dpr, T + ph / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textAlign = "center";
  ctx.fillText("z km", 0, 0);
  ctx.restore();
  ctx.strokeStyle = css("--line");
  ctx.strokeRect(L + 0.5 * dpr, T + 0.5 * dpr, pw - dpr, ph - dpr);
  if (fr) {  // time stamp
    const txt = `t = ${fmtTime(fr.time_s)}`;
    ctx.font = `500 ${11.5 * dpr}px "JetBrains Mono", ui-monospace, monospace`;
    const w = ctx.measureText(txt).width + 14 * dpr;
    ctx.fillStyle = css("--stamp-bg");
    ctx.beginPath();
    ctx.roundRect(L + 8 * dpr, T + 8 * dpr, w, 22 * dpr, 6 * dpr);
    ctx.fill();
    ctx.fillStyle = css("--stamp-fg");
    ctx.textAlign = "left";
    ctx.fillText(txt, L + 15 * dpr, T + 19.5 * dpr);
  }
}

// ---- frames and the timeline
let frames = [], shown = -1, follow = true, playing = null;
function showFrame(n) {
  shown = n;
  for (const p of panels) draw(p, frames[n]);
  $("scrub").value = String(n);
  $("scrub-label").textContent = frames[n] ? fmtTime(frames[n].time_s) : "00:00";
}
function setPlayIcon(on) {
  $("play-icon").setAttribute("d", on ? "M7 5h4v14H7zM13 5h4v14h-4z" : "M8 5v14l11-7z");
  $("play").setAttribute("aria-label", on ? "Pause" : "Play");
}
function togglePlay() {
  if (playing) { clearInterval(playing); playing = null; setPlayIcon(false); return; }
  follow = false;
  if (shown >= frames.length - 1) showFrame(0);
  setPlayIcon(true);
  playing = setInterval(() => {
    if (shown >= frames.length - 1) { togglePlay(); return; }
    showFrame(shown + 1);
  }, 70);
}
const f32 = (d) => ({ nx: d.nx, nz: d.nz, data: Float32Array.from(d.data) });

// ---- run
let meta = null, tStart = 0;
function onMessage(e) {
  const m = e.data;
  if (m.type === "status") {
    if (!meta) $("status").textContent = m.text.replace(/^cppwrf: /, "");
  } else if (m.type === "meta") {
    meta = m;
    tStart = performance.now();
    $("status").textContent = "Running";
  } else if (m.type === "frame") {
    frames.push({ step: m.step, time_s: m.time_s, t: f32(m.fields.t), w: f32(m.fields.w), qr: f32(m.fields.qr),
                  z: f32(m.fields.z) });
    $("scrub").max = String(frames.length - 1);
    $("scrub").disabled = $("play").disabled = frames.length < 2;
    if (follow && !playing) showFrame(frames.length - 1);
    if (meta) {
      const el = (performance.now() - tStart) / 1000, pct = (100 * m.step) / meta.nsteps;
      $("bar-fill").style.width = `${pct}%`;
      $("pct").textContent = `${pct.toFixed(0)}%`;
      $("l-step").textContent = `${m.step} / ${meta.nsteps}`;
      $("l-time").textContent = `${fmtTime(m.time_s)} / ${fmtTime(meta.nsteps * meta.dt)}`;
      $("l-speed").textContent = m.step ? `${(m.time_s / el).toFixed(0)}× real time` : "–";
      $("l-el").textContent = `${el.toFixed(1)} s`;
    }
  } else if (m.type === "done") {
    showResult(m);
  } else if (m.type === "error") {
    $("status").textContent = "Error: " + m.text;
    $("run").disabled = false;
    document.querySelectorAll("[data-case]").forEach((b) => (b.disabled = false));
  }
}

function showResult(m) {
  const c = m.check, ok = c.bad.length === 0;
  const badVars = new Set(c.bad.map((b) => b.split(/[: ]/)[0]));
  $("verify").hidden = false;
  $("verify").classList.toggle("is-bad", !ok);
  $("seal-icon").setAttribute("d", ok ? "M5 12.5l4.5 4.5L19 7.5" : "M7 7l10 10M17 7L7 17");
  $("verdict").textContent = ok ? "Bit-identical to the native build" : `${c.bad.length} of ${c.nhashes} hashes differ`;
  $("verdict-sub").textContent = ok
      ? `All ${c.nhashes} hashes equal: ${c.nvars} variables × ${m.times} output times` +
      (c.fileIdentical ? ". The wrfout file is the same byte for byte." : ". The file bytes differ (metadata).")
    : c.bad.slice(0, 6).join(" · ") + (c.bad.length > 6 ? " …" : "");
  $("vargrid").innerHTML = m.varNames.map((v) =>
    `<span role="listitem" class="${badVars.has(v) ? "bad" : "ok"}" title="${v}: ${badVars.has(v) ? "differs" : `${m.times} of ${m.times} equal`}"></span>`).join("");
  const simS = meta.nsteps * meta.dt;
  const tiles = [
    [`${m.steppingSeconds.toFixed(1)} s`, `${m.nsteps} time steps`],
    [`${(simS / m.steppingSeconds).toFixed(0)}×`, "faster than real time"],
    [`${m.peakMB.toFixed(0)} MB`, "peak wasm memory"],
    [`${(m.file.byteLength / 2 ** 20).toFixed(1)} MB`, "wrfout, NetCDF classic"],
  ];
  $("tiles").innerHTML = tiles.map(([v, k]) => `<div class="tile"><b class="mono">${v}</b><span>${k}</span></div>`).join("");
  $("label").textContent = m.expectedLabel;
  const a = $("download");
  a.href = URL.createObjectURL(new Blob([m.file], { type: "application/x-netcdf" }));
  a.download = m.name.replaceAll(":", "_");
  $("status").textContent = ok ? "Done · bit-identical" : "Done · differences found";
  $("bar-fill").style.width = "100%";
  $("run").disabled = false;
  document.querySelectorAll("[data-case]").forEach((b) => (b.disabled = false));
  $("run").querySelector("span").textContent = "Run again";
  $("verify").scrollIntoView({ behavior: "smooth", block: "nearest" });
  window.cppwrfResult = { ok, ...c, steppingSeconds: m.steppingSeconds, wallSeconds: m.wallSeconds, peakMB: m.peakMB };
}

function start() {
  $("run").disabled = true;
  $("verify").hidden = true;
  if (playing) togglePlay();
  frames = []; shown = -1; follow = true; meta = null;
  $("bar-fill").style.width = "0";
  $("pct").textContent = "";
  for (const id of ["l-step", "l-time", "l-speed", "l-el"]) $(id).textContent = "–";
  $("status").textContent = "Loading the model";
  const w = new Worker("worker.js", { type: "module" });
  w.onmessage = onMessage;
  w.onerror = (e) => { $("status").textContent = "Worker error: " + e.message; $("run").disabled = false; };
  document.querySelectorAll("[data-case]").forEach((b) => (b.disabled = true));
  w.postMessage({ cmd: "run", caseName, chunk: caseName === "em_quarter_ss" ? 3 : 10 });
}

// ---- theme
function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  buildLuts();
  paintRamps();
  for (const p of panels) draw(p, frames[shown]);
}
$("theme").addEventListener("click", () => {
  const dark = document.documentElement.dataset.theme
    ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  const t = dark ? "light" : "dark";
  try { localStorage.setItem("theme", t); } catch {}
  applyTheme(t);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => applyTheme());

let saved = null;
try { saved = localStorage.getItem("theme"); } catch {}
if (saved) document.documentElement.dataset.theme = saved;
buildLuts();
makePanels();
paintRamps();
const q = new URLSearchParams(location.search);
if (CASES[q.get("case")]) caseName = q.get("case");
applyCase();
document.querySelectorAll("[data-case]").forEach((b) => b.addEventListener("click", () => {
  if (b.dataset.case === caseName) return;
  caseName = b.dataset.case;
  frames = []; shown = -1; meta = null;
  $("verify").hidden = true;
  $("scrub").max = "0"; $("scrub").disabled = $("play").disabled = true;
  $("scrub-label").textContent = "00:00";
  $("bar-fill").style.width = "0"; $("pct").textContent = "";
  for (const id of ["l-step", "l-time", "l-speed", "l-el"]) $(id).textContent = "–";
  $("run").querySelector("span").textContent = "Run the model";
  applyCase();
}));
$("run").addEventListener("click", start);
$("play").addEventListener("click", togglePlay);
$("scrub").addEventListener("input", (e) => {
  follow = Number(e.target.value) === frames.length - 1;
  if (playing) togglePlay();
  showFrame(Number(e.target.value));
});
document.fonts?.ready.then(() => panels.forEach((p) => draw(p, frames[shown])));
if (q.has("autorun")) start();
