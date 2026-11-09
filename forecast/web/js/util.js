// SPDX-License-Identifier: GPL-3.0-or-later
// Shared helpers: DOM, settings kept in localStorage, translations, Turkish number / date formats, units, the API.

export const $ = (id) => document.getElementById(id);
export function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") e.className = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "html") e.innerHTML = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c.nodeType ? c : document.createTextNode(String(c)));
  return e;
}

// ---- per-viewer preferences (localStorage may be unavailable: private windows, blocked storage)
export const prefs = {
  get(k, d) { try { const v = localStorage.getItem("cppwrf." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cppwrf." + k, JSON.stringify(v)); } catch { /* not kept */ } },
};

// ---- translations
let dict = {}, lang = "tr";
export async function loadLang(l) {
  lang = l;
  const base = new URL("../i18n/", import.meta.url);
  dict = await (await fetch(new URL(`${l}.json`, base))).json();
  document.documentElement.lang = l;
  document.querySelectorAll("[data-i18n]").forEach((e) => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll("[data-i18n-title]").forEach((e) => { e.title = t(e.dataset.i18nTitle); e.setAttribute("aria-label", e.title); });
}
export const getLang = () => lang;
export function t(key, vars) {
  let s = dict[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, v);
  return s;
}

// ---- numbers and dates (decimal comma, 24-hour clock)
const locale = () => (lang === "tr" ? "tr-TR" : "en-GB");
export function num(v, digits = 1) {
  if (v == null || Number.isNaN(v)) return "–";
  return new Intl.NumberFormat(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
}
export function int(v) { return num(v, 0); }
export const TZ = {
  ist: { zone: "Europe/Istanbul", tag: { tr: "TSİ", en: "TRT" } },
  utc: { zone: "UTC", tag: { tr: "UTC", en: "UTC" } },
  local: { zone: undefined, tag: { tr: "", en: "" } },
};
export function tzKey() { return prefs.get("tz", "ist"); }
export function fmtTime(iso, { weekday = true, date = false } = {}) {
  const tz = TZ[tzKey()] || TZ.ist;
  const d = new Date(iso);
  const opts = { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz.zone };
  if (weekday) opts.weekday = "short";
  if (date) { opts.day = "numeric"; opts.month = "short"; }
  const s = new Intl.DateTimeFormat(locale(), opts).format(d).replace(",", "");
  const tag = tz.tag[lang];
  return tag ? `${s} (${tag})` : s;
}
export function fmtClock(date) {
  const tz = TZ[tzKey()] || TZ.ist;
  return new Intl.DateTimeFormat(locale(), { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: tz.zone }).format(date);
}
export function fmtDur(s) {
  if (s == null || !Number.isFinite(s)) return "–";
  s = Math.round(s);
  const tr = lang === "tr";
  if (s < 60) return `${s} ${tr ? "sn" : "s"}`;
  if (s < 3600) return `${Math.floor(s / 60)} ${tr ? "dk" : "min"}${s < 600 && s % 60 ? ` ${s % 60} ${tr ? "sn" : "s"}` : ""}`;
  const m = Math.round((s % 3600) / 60);
  return `${Math.floor(s / 3600)} ${tr ? "sa" : "h"}${m ? ` ${m} ${tr ? "dk" : "min"}` : ""}`;
}
export function fmtBytes(b) {
  if (!b) return "0";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1000; ++i; }
  return `${num(b, b < 10 && i ? 1 : 0)} ${u[i]}`;
}
export function fmtCycle(c) { return c ? `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(8)}Z` : "–"; }

// ---- units (the products are in SI-like units: °C, m/s, hPa, mm)
export const UNITS = {
  temp: { C: { label: "°C", f: (v) => v }, F: { label: "°F", f: (v) => v * 9 / 5 + 32 } },
  wind: {
    ms: { label: "m/s", f: (v) => v }, kmh: { label: "km/h", f: (v) => v * 3.6 }, kt: { label: "kt", f: (v) => v * 1.943844 },
    bft: { label: "Bft", f: (v) => Math.min(12, Math.round(Math.cbrt((v / 0.836) ** 2))) },
  },
  pres: { hPa: { label: "hPa", f: (v) => v }, mmHg: { label: "mmHg", f: (v) => v * 0.750062 } },
  precip: { mm: { label: "mm", f: (v) => v }, in: { label: "in", f: (v) => v / 25.4 } },
};
export function units() { return { temp: "C", wind: "ms", pres: "hPa", precip: "mm", ...prefs.get("units", {}) }; }
// the unit family of a product unit
export function family(unit) {
  if (unit === "°C") return "temp";
  if (unit === "m/s") return "wind";
  if (unit === "hPa") return "pres";
  if (unit === "mm" || unit === "mm/h") return "precip";
  return null;
}
export function conv(v, unit) {
  const fam = family(unit);
  if (!fam || v == null || Number.isNaN(v)) return { v, label: unit };
  const u = UNITS[fam][units()[fam]];
  const label = unit === "mm/h" ? `${u.label}/${lang === "tr" ? "sa" : "h"}` : u.label;
  return { v: u.f(v), label };
}
export function fmtValue(v, unit, digits) {
  const c = conv(v, unit);
  const d = digits ?? (c.label === "Bft" ? 0 : Math.abs(c.v) >= 100 ? 0 : 1);
  return `${num(c.v, d)} ${c.label}`;
}

// ---- the API: the local server (127.0.0.1) or, on GitHub Pages without it, the published samples
const LOCAL = "http://127.0.0.1:8090";
export const api = {
  base: "",
  online: false,
  samples: null,
  async detect() {
    const local = ["127.0.0.1", "localhost"].includes(location.hostname) && location.port === "8090";
    const candidates = local ? [""] : [LOCAL];
    for (const b of candidates) {
      try {
        const r = await fetch(`${b}/api/v1/system`, { signal: AbortSignal.timeout(2500) });
        if (r.ok) { this.base = b; this.online = true; return await r.json(); }
      } catch { /* not running */ }
    }
    this.online = false;
    try { this.samples = await (await fetch(new URL("../samples/index.json", import.meta.url))).json(); } catch { this.samples = []; }
    return null;
  },
  async get(path) {
    const r = await fetch(this.base + path);
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.json();
  },
  async send(method, path, body) {
    const r = await fetch(this.base + path, { method, body: body == null ? undefined : JSON.stringify(body), headers: { "Content-Type": "application/json" } });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok, status: r.status, json: j };
  },
  events(id, onmsg) {
    const es = new EventSource(`${this.base}/api/v1/runs/${id}/events`);
    es.onmessage = (e) => { const d = JSON.parse(e.data); onmsg(d); if (["done", "failed", "cancelled"].includes(d.status)) es.close(); };
    es.onerror = () => { /* the browser retries; a finished stream closes itself */ };
    return es;
  },
  // a run's products: on the server, or in samples/<id>/products
  url(run, path) {
    if (run.sample) return new URL(`../samples/${run.id}/products/${path}`, import.meta.url).href;
    return `${this.base}/api/v1/runs/${run.id}/products/${path}`;
  },
  async range(url, start, bytes) {
    const r = await fetch(url, { headers: { Range: `bytes=${start}-${start + bytes - 1}` } });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    const buf = await r.arrayBuffer();
    // a server that ignores Range sends the whole file
    return r.status === 206 ? buf : buf.slice(start, start + bytes);
  },
};

export function toast(msg, ms = 2600) {
  const el = $("toast");
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}
