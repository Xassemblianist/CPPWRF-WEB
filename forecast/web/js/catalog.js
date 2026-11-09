// SPDX-License-Identifier: GPL-3.0-or-later
// Colour scales and the layers of the map.
//
// Continuous fields use perceptually uniform, colour-blind-safe ramps (viridis-, cividis- and plasma-like stops, a
// blue-orange diverging ramp for temperatures); precipitation and reflectivity keep the colours meteorologists expect.
// Stops: [value, "#rrggbb", alpha]. log: interpolation in log10 of the value.

const V = ["#440154", "#482878", "#3e4989", "#31688e", "#26828e", "#1f9e89", "#35b779", "#6ece58", "#b5de2b", "#fde725"];
const C = ["#00224e", "#123570", "#3b496c", "#575d6d", "#707173", "#8a8678", "#a59c74", "#c3b369", "#e1cc55", "#fee838"];
const P = ["#0d0887", "#46039f", "#7201a8", "#9c179e", "#bd3786", "#d8576b", "#ed7953", "#fb9f3a", "#fdca26", "#f0f921"];
const ramp = (cols, lo, hi, alpha = 1) => cols.map((c, i) => [lo + (hi - lo) * i / (cols.length - 1), c, alpha]);

export const SCALES = {
  wind: { stops: ramp(V, 0, 36), ticks: [0, 5, 10, 15, 20, 25, 30, 35] },
  temp: {
    stops: [[-40, "#2a1a5e", 1], [-30, "#3b3f9e", 1], [-20, "#3f6fc4", 1], [-10, "#6aa6d8", 1], [-2, "#b8dcef", 1], [0, "#eef2f0", 1],
            [4, "#f6e7a6", 1], [12, "#f3c35b", 1], [20, "#ea8c3a", 1], [28, "#d4532b", 1], [36, "#a8231f", 1], [45, "#6b0f1a", 1]],
    ticks: [-40, -30, -20, -10, 0, 10, 20, 30, 40],
  },
  rh: { stops: [[0, "#6b3d1f", 1], [20, "#a8713a", 1], [40, "#d6b67a", 1], [60, "#9ccfa0", 1], [80, "#4aa6a8", 1], [100, "#1c5c8a", 1]], ticks: [0, 20, 40, 60, 80, 100] },
  mslp: { stops: ramp(C, 970, 1045), ticks: [970, 985, 1000, 1015, 1030, 1045] },
  rate: {
    log: true,
    stops: [[0.1, "#a5d4f0", 0], [0.2, "#a5d4f0", 0.75], [0.5, "#64aee0", 0.85], [1, "#3a7dc4", 0.9], [2, "#2f9f7a", 0.9], [4, "#7cc24a", 0.92],
            [8, "#f2d33a", 0.95], [16, "#f28b2b", 0.95], [32, "#d7302a", 0.95], [64, "#9b1f8f", 0.95]],
    ticks: [0.2, 0.5, 1, 2, 4, 8, 16, 32, 64],
  },
  acc: {
    log: true,
    stops: [[0.2, "#a5d4f0", 0], [0.5, "#a5d4f0", 0.75], [1, "#64aee0", 0.85], [2.5, "#3a7dc4", 0.9], [5, "#2f9f7a", 0.9], [10, "#7cc24a", 0.92],
            [20, "#f2d33a", 0.95], [40, "#f28b2b", 0.95], [80, "#d7302a", 0.95], [160, "#9b1f8f", 0.95], [300, "#4b0f55", 0.95]],
    ticks: [0.5, 1, 2.5, 5, 10, 20, 40, 80, 160, 300],
  },
  snow: {
    log: true,
    stops: [[0.05, "#d9e6f5", 0], [0.1, "#d9e6f5", 0.8], [1, "#a7c3e8", 0.88], [5, "#7d93d8", 0.92], [10, "#6c63c4", 0.95], [25, "#7a3fa6", 0.95], [60, "#5b1a74", 0.95]],
    ticks: [0.1, 1, 5, 10, 25, 60],
  },
  cloud: { stops: [[0, "#e9eef3", 0], [10, "#e9eef3", 0.05], [50, "#dfe5eb", 0.45], [100, "#f6f8fa", 0.85]], ticks: [0, 25, 50, 75, 100] },
  radar: {
    stops: [[5, "#9fd9ff", 0], [8, "#9fd9ff", 0.8], [15, "#2fa6f2", 0.9], [20, "#1f5fd1", 0.9], [25, "#23c23a", 0.92], [30, "#1a8f20", 0.92], [35, "#f5e43b", 0.95],
            [40, "#f0a12a", 0.95], [45, "#e8541e", 0.95], [50, "#c51b1b", 0.95], [55, "#b0158e", 0.95], [60, "#7a1fb8", 0.95], [70, "#f2f2f2", 0.95]],
    ticks: [10, 20, 30, 40, 50, 60, 70],
  },
  cape: { stops: [[0, P[0], 0], [50, P[0], 0.5], ...ramp(P.slice(1), 250, 4000, 0.85)], ticks: [0, 500, 1000, 2000, 3000, 4000] },
  cin: { stops: [[-400, "#08306b", 0.85], [-200, "#2171b5", 0.85], [-100, "#6baed6", 0.8], [-25, "#c6dbef", 0.7], [-5, "#eef3fa", 0]], ticks: [-400, -300, -200, -100, 0] },
  li: {
    stops: [[-10, "#6b0f1a", 1], [-6, "#c0392b", 1], [-3, "#ea8c3a", 1], [0, "#eeeeee", 1], [3, "#9ccbe8", 1], [6, "#4f86c6", 1], [12, "#2a3f8f", 1]],
    ticks: [-10, -6, -3, 0, 3, 6, 12],
  },
  shear: { stops: ramp(V, 0, 40), ticks: [0, 10, 20, 30, 40] },
  height: { stops: ramp(C, 0, 5000), ticks: [0, 1000, 2000, 3000, 4000, 5000] },
  z500: { stops: ramp(V, 4900, 6000), ticks: [4900, 5200, 5500, 5800] },
  snowh: { log: true, stops: [[0.5, "#dfe9f7", 0], [1, "#dfe9f7", 0.85], [5, "#b4c8ec", 0.9], [20, "#7d8fd6", 0.92], [50, "#6a4fb5", 0.95], [150, "#4b2a8f", 0.95]], ticks: [1, 5, 20, 50, 150] },
  soil: { stops: [[0, "#8c5a2b", 1], [0.15, "#d9c27a", 1], [0.3, "#6fbf73", 1], [0.5, "#1f7a6b", 1]], ticks: [0, 0.1, 0.2, 0.3, 0.4, 0.5] },
  pblh: { stops: ramp(V, 0, 3000), ticks: [0, 500, 1000, 1500, 2000, 2500, 3000] },
  diff: { stops: [[-1, "#2a3f8f", 1], [-0.5, "#6a9bd2", 1], [0, "#f2f2f2", 1], [0.5, "#ea8c3a", 1], [1, "#8f1d1d", 1]], ticks: [-1, -0.5, 0, 0.5, 1] },
};

function rgb(hex) { return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); }
// 256 RGBA colours over the scale's range
export function lut(scale) {
  if (scale._lut) return scale._lut;
  const s = scale.stops, lo = s[0][0], hi = s[s.length - 1][0], out = new Uint8Array(256 * 4);
  const f = scale.log ? (x) => Math.log10(x) : (x) => x;
  for (let n = 0; n < 256; ++n) {
    const v = scale.log ? 10 ** (f(lo) + (f(hi) - f(lo)) * n / 255) : lo + (hi - lo) * n / 255;
    let i = 0;
    while (i < s.length - 2 && v > s[i + 1][0]) ++i;
    const a = rgb(s[i][1]), b = rgb(s[i + 1][1]);
    const w = Math.max(0, Math.min(1, (f(v) - f(s[i][0])) / (f(s[i + 1][0]) - f(s[i][0]))));
    for (let c = 0; c < 3; ++c) out[4 * n + c] = Math.round(a[c] + w * (b[c] - a[c]));
    out[4 * n + 3] = Math.round(255 * (s[i][2] + w * (s[i + 1][2] - s[i][2])));
  }
  scale._lut = out;
  scale.lo = lo;
  scale.hi = hi;
  return out;
}
export function cssGradient(scale) {
  const L = lut(scale), parts = [];
  for (let n = 0; n <= 16; ++n) {
    const q = Math.round(n * 255 / 16);
    parts.push(`rgba(${L[4 * q]},${L[4 * q + 1]},${L[4 * q + 2]},${Math.max(0.25, L[4 * q + 3] / 255).toFixed(2)})`);
  }
  return `linear-gradient(90deg,${parts.join(",")})`;
}
export function tickPos(scale, v) {
  lut(scale);
  if (scale.log) return (Math.log10(v) - Math.log10(scale.lo)) / (Math.log10(scale.hi) - Math.log10(scale.lo));
  return (v - scale.lo) / (scale.hi - scale.lo);
}

// ---- the layers. field(variant, level) -> the product field ({name, level}); speed: |(u, v)|
const lv = (name, sfc) => (variant, level) => (level ? { name, level } : { name: sfc, level: 0 });
export const LAYERS = [
  { id: "wind", key: "layer.wind", scale: "wind", levels: true, particles: true, field: (v, l) => (l ? { speed: ["u", "v"], level: l } : { speed: ["u10", "v10"], level: 0 }), unit: "m/s" },
  { id: "gust", key: "layer.gust", scale: "wind", particles: true, field: () => ({ name: "gust", level: 0 }) },
  { id: "temp", key: "layer.temp", scale: "temp", levels: true, field: lv("t", "t2") },
  { id: "dew", key: "layer.dew", scale: "temp", levels: true, field: lv("td", "td2") },
  { id: "rh", key: "layer.rh", scale: "rh", levels: true, field: lv("rh", "rh2") },
  { id: "mslp", key: "layer.mslp", scale: "mslp", contour: { step: 2 }, field: () => ({ name: "mslp", level: 0 }) },
  {
    id: "precip", key: "layer.precip", scale: "rate",
    variants: [["rate", "var.rate", "precip_rate", "rate"], ["acc", "var.acc", "precip_acc", "acc"], ["rain", "var.rain", "rain_acc", "acc"],
               ["conv", "var.conv", "conv_acc", "acc"], ["grid", "var.grid", "grid_acc", "acc"]],
  },
  { id: "snow", key: "layer.snow", scale: "snow", variants: [["acc", "var.snow_acc", "snow_acc", "snow"], ["rate", "var.snow_rate", "snow_rate", "snow"], ["graupel", "var.graupel", "graupel_acc", "snow"]] },
  { id: "cloud", key: "layer.cloud", scale: "cloud", variants: [["total", "var.total", "cloud_total"], ["low", "var.low", "cloud_low"], ["mid", "var.mid", "cloud_mid"], ["high", "var.high", "cloud_high"]] },
  { id: "radar", key: "layer.radar", scale: "radar", field: () => ({ name: "refl", level: 0 }) },
  { id: "cape", key: "layer.cape", scale: "cape", variants: [["sb", "var.sb", "cape_sb"], ["mu", "var.mu", "cape_mu"]] },
  { id: "cin", key: "layer.cin", scale: "cin", variants: [["sb", "var.sb", "cin_sb"], ["mu", "var.mu", "cin_mu"]] },
  { id: "li", key: "layer.li", scale: "li", field: () => ({ name: "li", level: 0 }) },
  { id: "shear", key: "layer.shear", scale: "shear", field: () => ({ name: "shear06", level: 0 }) },
  { id: "freezing", key: "layer.freezing", scale: "height", field: () => ({ name: "freezing_lvl", level: 0 }) },
  { id: "z", key: "layer.z", scale: "z500", levels: "only", defaultLevel: 500, contour: { step: 60 }, field: (v, l) => ({ name: "z", level: l || 500 }) },
  { id: "snowh", key: "layer.snowh", scale: "snowh", field: () => ({ name: "snowh", level: 0 }) },
  { id: "soil", key: "layer.soil", scale: "soil", field: () => ({ name: "smois", level: 0 }) },
  { id: "sst", key: "layer.sst", scale: "temp", field: () => ({ name: "sst", level: 0 }) },
  { id: "tsk", key: "layer.tsk", scale: "temp", field: () => ({ name: "tsk", level: 0 }) },
  { id: "pblh", key: "layer.pblh", scale: "pblh", field: () => ({ name: "pblh", level: 0 }) },
];
for (const L of LAYERS) {
  if (L.variants) {
    L.field = (variant) => {
      const v = L.variants.find((x) => x[0] === variant) || L.variants[0];
      return { name: v[2], level: 0, scale: v[3] };
    };
  }
}
// the scale of a layer for a variant / level (z: by level)
export function scaleFor(L, variant, level) {
  const f = L.field(variant, level);
  if (L.id === "z") {
    const lv = level || 500;
    const ranges = { 925: [500, 1000], 850: [1150, 1650], 700: [2700, 3250], 500: [4900, 6000], 300: [8400, 9800], 250: [9600, 11000] };
    const [lo, hi] = ranges[lv] || [0, 12000];
    const key = `z${lv}`;
    if (!SCALES[key]) SCALES[key] = { stops: ramp(V, lo, hi), ticks: [lo, Math.round((lo + hi) / 2), hi] };
    return SCALES[key];
  }
  return SCALES[f.scale || L.scale];
}
export const ICONS = {
  wind: '<path d="M3 9h11a3 3 0 1 0-3-3M3 14h15a3 3 0 1 1-3 3M3 19h7"/>',
  gust: '<path d="M3 8h9a3 3 0 1 0-3-3M3 12h15M3 16h9a3 3 0 1 1-3 3"/>',
  temp: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>',
  dew: '<path d="M12 3s5 5.5 5 9.5a5 5 0 0 1-10 0C7 8.5 12 3 12 3zM9.5 13.5a2.5 2.5 0 0 0 2.5 2.5"/>',
  rh: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
  mslp: '<circle cx="12" cy="12" r="8"/><path d="M12 12l4-3"/>',
  precip: '<path d="M7 16a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 8a4 4 0 0 1 0 8M8 20l1-2M12 21l1-2M16 20l1-2"/>',
  snow: '<path d="M12 3v18M4.2 7.5l15.6 9M4.2 16.5l15.6-9"/>',
  cloud: '<path d="M7 18a4.5 4.5 0 0 1-.4-9A6 6 0 0 1 18 10a4 4 0 0 1 0 8z"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12l6-6"/>',
  cape: '<path d="M4 20c3-10 5-14 8-14s5 4 8 14"/><path d="M12 6V2"/>',
  cin: '<path d="M4 6h16M7 10h10M10 14h4M12 18v3"/>',
  li: '<path d="M12 21V3M7 8l5-5 5 5"/>',
  shear: '<path d="M4 20h4M4 14h8M4 8h12M4 2h16"/>',
  freezing: '<path d="M3 12h18M12 3v18M6 6l12 12M18 6L6 18"/>',
  z: '<path d="M3 17c3-4 6-6 9-6s6 2 9 6M3 11c3-4 6-6 9-6s6 2 9 6"/>',
  snowh: '<path d="M3 18h18M5 14h14M12 4v6M9 7h6"/>',
  soil: '<path d="M3 14h18M6 18h2M11 18h2M16 18h2M8 10c0-3 2-6 4-6s4 3 4 6"/>',
  sst: '<path d="M2 16c2 0 2-2 4-2s2 2 4 2 2-2 4-2 2 2 4 2 2-2 4-2M12 3v8"/>',
  tsk: '<circle cx="12" cy="9" r="4"/><path d="M3 20h18"/>',
  pblh: '<path d="M3 20h18M6 20V12M12 20V8M18 20v-6"/>',
};
