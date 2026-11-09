// SPDX-License-Identifier: GPL-3.0-or-later
// A forecast's products (written by wrfpost, see forecast/server/wrfpost.cpp for the layouts):
//   meta.json, static.f32 [height, land][nlat][nlon], native.f32 [XLAT, XLONG][ny][nx],
//   f/NNN.f32 plane-major [field][nlat][nlon] (one Range request per plane),
//   n/NNN.f32 point-major [ny][nx][surface field], s/NNN.f32 point-major [nlat][nlon][level][t, td, u, v, z],
//   ts.f32 point-major [nlat][nlon][series][frame] once the run is done.
import { api } from "./util.js";

const pad = (n) => String(n).padStart(3, "0");

export class Product {
  constructor(run, dom = "") {
    this.run = run;
    this.dom = dom;          // "" for d01, "d02/" or "d03/" for nests
    this.cache = new Map();  // "frame:index" -> Promise<Float32Array>
    this.order = [];
  }
  url(path) { return api.url(this.run, this.dom + path); }
  async load() {
    const r = await fetch(this.url("meta.json"), { cache: "no-store" });
    if (!r.ok) throw new Error(`meta.json ${r.status}`);
    this.meta = await r.json();
    const g = this.meta.grid;
    this.plane = g.nlat * g.nlon;
    this.index = new Map(this.meta.fields.map((f, i) => [`${f.name}@${f.level}`, i]));
    this.surface = this.meta.fields.filter((f) => f.native);
    if (!this.static) {
      try {
        const buf = await (await fetch(this.url("static.f32"))).arrayBuffer();
        this.static = { hgt: new Float32Array(buf, 0, this.plane), land: new Float32Array(buf, 4 * this.plane, this.plane) };
      } catch { this.static = null; }
    }
    return this.meta;
  }
  // the frames ready so far (a running forecast grows)
  async refresh() {
    const before = this.meta?.ready?.length || 0;
    await this.load();
    return this.meta.ready.length !== before;
  }
  has(name, level = 0) { return this.index.has(`${name}@${level}`); }
  field(name, level = 0) { return this.meta.fields[this.index.get(`${name}@${level}`)]; }
  async get(frame, name, level = 0) {
    const i = this.index.get(`${name}@${level}`);
    if (i == null) return null;
    const key = `${frame}:${i}`;
    let p = this.cache.get(key);
    if (!p) {
      p = api.range(this.url(`f/${pad(frame)}.f32`), 4 * i * this.plane, 4 * this.plane).then((b) => new Float32Array(b));
      p.catch(() => this.cache.delete(key));
      this.cache.set(key, p);
      this.order.push(key);
      // keep about 160 planes (a few hundred MB at most for big grids)
      const limit = Math.max(24, Math.floor(160e6 / (4 * this.plane)));
      while (this.order.length > limit) this.cache.delete(this.order.shift());
    }
    return p;
  }
  // wind speed from two components
  async speed(frame, u, v, level) {
    const [a, b] = await Promise.all([this.get(frame, u, level), this.get(frame, v, level)]);
    if (!a || !b) return null;
    const s = new Float32Array(a.length);
    for (let k = 0; k < a.length; ++k) s[k] = Math.hypot(a[k], b[k]);
    return { s, u: a, v: b };
  }
  // the lat-lon grid cell of a point (null outside)
  cell(lat, lon) {
    const g = this.meta.grid;
    const r = Math.round((lat - g.lat0) / g.dlat);
    let d = lon - g.lon0;
    d -= 360 * Math.floor(d / 360);
    const c = Math.round(d / g.dlon);
    if (r < 0 || c < 0 || r >= g.nlat || c >= g.nlon) return null;
    if (this.static && Number.isNaN(this.static.hgt[r * g.nlon + c])) return null;
    return { r, c, lat: g.lat0 + r * g.dlat, lon: g.lon0 + c * g.dlon };
  }
  // bilinear value of a plane at a point
  sample(data, lat, lon) {
    const g = this.meta.grid;
    const rr = (lat - g.lat0) / g.dlat;
    let d = lon - g.lon0;
    d -= 360 * Math.floor(d / 360);
    const cc = d / g.dlon;
    if (rr < 0 || cc < 0 || rr > g.nlat - 1 || cc > g.nlon - 1) return NaN;
    const r = Math.min(Math.floor(rr), g.nlat - 2), c = Math.min(Math.floor(cc), g.nlon - 2), a = cc - c, b = rr - r;
    const v = (i, j) => data[i * g.nlon + j];
    const q = [v(r, c), v(r, c + 1), v(r + 1, c), v(r + 1, c + 1)];
    if (q.some(Number.isNaN)) { const n = v(Math.round(rr), Math.round(cc)); return n; }
    return (q[0] * (1 - a) + q[1] * a) * (1 - b) + (q[2] * (1 - a) + q[3] * a) * b;
  }
  // the model's own grid point nearest a point: exact values, not interpolated
  async native(frame, lat, lon) {
    if (!this.nat) {
      const buf = await (await fetch(this.url("native.f32"))).arrayBuffer();
      const { nx, ny } = this.meta.model;
      this.nat = { lat: new Float32Array(buf, 0, nx * ny), lon: new Float32Array(buf, 4 * nx * ny, nx * ny) };
    }
    const { nx, ny } = this.meta.model;
    const cl = Math.cos(lat * Math.PI / 180);
    let best = -1, bd = Infinity;
    for (let k = 0; k < nx * ny; ++k) {
      let dl = this.nat.lon[k] - lon;
      dl -= 360 * Math.round(dl / 360);
      const d = (this.nat.lat[k] - lat) ** 2 + (dl * cl) ** 2;
      if (d < bd) { bd = d; best = k; }
    }
    const km = Math.sqrt(bd) * 111.2;
    if (km > 1.5 * this.meta.model.dx / 1000) return null;
    const n = this.surface.length;
    const buf = await api.range(this.url(`n/${pad(frame)}.f32`), 4 * best * n, 4 * n);
    const vals = new Float32Array(buf);
    const out = {};
    this.surface.forEach((f, i) => { out[f.name] = vals[i]; });
    return { values: out, km, i: best % nx, j: Math.floor(best / nx), lat: this.nat.lat[best], lon: this.nat.lon[best] };
  }
  async sounding(frame, cell) {
    const s = this.meta.sounding, nl = s.levels.length, nv = s.vars.length;
    const off = ((cell.r * this.meta.grid.nlon + cell.c) * nl * nv) * 4;
    const v = new Float32Array(await api.range(this.url(`s/${pad(frame)}.f32`), off, nl * nv * 4));
    return s.levels.map((p, k) => ({ p, t: v[k * nv], td: v[k * nv + 1], u: v[k * nv + 2], v: v[k * nv + 3], z: v[k * nv + 4] }));
  }
  // the time series of a point: ts.f32 once the run is done, else the ready frames from n/ files
  async series(cell, lat, lon) {
    const m = this.meta, nf = m.times.length, ns = m.series.length;
    if (m.done) {
      try {
        const off = ((cell.r * m.grid.nlon + cell.c) * ns * nf) * 4;
        const v = new Float32Array(await api.range(this.url("ts.f32"), off, ns * nf * 4));
        const out = { times: m.times, partial: false };
        m.series.forEach((n, i) => { out[n] = v.subarray(i * nf, (i + 1) * nf); });
        return out;
      } catch { /* an older run without ts.f32: fall through */ }
    }
    const frames = m.ready;
    const vals = await Promise.all(frames.map((f) => this.native(f, lat, lon)));
    const out = { times: frames.map((f) => m.times[f]), partial: !m.done };
    for (const n of m.series) out[n] = Float32Array.from(vals.map((x) => (x ? x.values[n] : NaN)));
    return out;
  }
}

// a run: the run record (from the server or samples/index.json) and its domains' products
export class Run {
  constructor(info) {
    this.info = info;
    this.id = info.id;
    this.sample = !!info.sample;
    this.domains = [new Product(this, "")];
    const nest = info.settings?.nest;
    if (nest) this.domains.push(new Product(this, "d02/"));
  }
  async load() {
    await this.domains[0].load();
    for (const d of this.domains.slice(1)) { try { await d.load(); } catch { this.domains = this.domains.filter((x) => x !== d); } }
    return this;
  }
  get main() { return this.domains[0]; }
  get meta() { return this.domains[0].meta; }
  // the finest domain covering a point
  at(lat, lon) {
    for (let k = this.domains.length - 1; k > 0; --k) if (this.domains[k].meta && this.domains[k].cell(lat, lon)) return this.domains[k];
    return this.domains[0];
  }
}
