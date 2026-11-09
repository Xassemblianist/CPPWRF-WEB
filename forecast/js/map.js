// SPDX-License-Identifier: GPL-3.0-or-later
// The map: Web Mercator, drawn with WebGL2.
//   ocean and land (Natural Earth polygons, filled with the stencil buffer, even-odd), relief shading (WPS height),
//   lakes, the forecast field (an R32F texture on its latitude-longitude grid, coloured on the GPU through a 256-entry
//   lookup texture; the area outside the domain dimmed), rivers, coastlines, borders, isolines.
// Two 2-D canvases on top: wind particles (with fading trails) and the annotations (labels, outlines, barbs).

const VS_LL = `#version 300 es
in vec2 a_ll;
uniform vec2 u_center; uniform float u_scale; uniform vec2 u_view; uniform float u_off;
const float PI = 3.141592653589793;
void main() {
  float lat = clamp(a_ll.y, -85.05, 85.05);
  float x = (a_ll.x + 180.0) / 360.0 + u_off;
  float y = (1.0 - log(tan(PI / 4.0 + radians(lat) / 2.0)) / PI) / 2.0;
  vec2 p = (vec2(x, y) - u_center) * u_scale;
  gl_Position = vec4(p.x / u_view.x * 2.0, -p.y / u_view.y * 2.0, 0.0, 1.0);
}`;
const FS_COLOR = `#version 300 es
precision mediump float;
uniform vec4 u_color; out vec4 o;
void main() { o = u_color; }`;
const VS_FULL = `#version 300 es
in vec2 a_p; void main() { gl_Position = vec4(a_p, 0.0, 1.0); }`;
// screen pixel -> latitude, longitude
const GEO = `
uniform vec2 u_center; uniform float u_scale; uniform vec2 u_view; uniform float u_dpr;
const float PI = 3.141592653589793;
vec2 geo() {
  vec2 f = vec2(gl_FragCoord.x, u_view.y * u_dpr - gl_FragCoord.y) / u_dpr;
  vec2 w = u_center + (f - u_view * 0.5) / u_scale;
  float lon = fract(w.x) * 360.0 - 180.0;
  float lat = degrees(atan(sinh(PI * (1.0 - 2.0 * w.y))));
  return vec2(lat, lon);
}`;
const FS_FIELD = `#version 300 es
precision highp float;
${GEO}
uniform highp sampler2D u_data; uniform sampler2D u_lut;
uniform vec4 u_grid;      // lat0, lon0, dlat, dlon
uniform vec2 u_size;      // nlat, nlon
uniform vec3 u_range;     // lo, hi, log
uniform float u_alpha, u_dim;
out vec4 o;
float at(int r, int c) { return texelFetch(u_data, ivec2(c, r), 0).r; }
void main() {
  vec2 g = geo();
  float lon = g.y;
  float rr = (g.x - u_grid.x) / u_grid.z;
  float d = lon - u_grid.y; d -= 360.0 * floor(d / 360.0);
  float cc = d / u_grid.w;
  if (rr < 0.0 || cc < 0.0 || rr > u_size.x - 1.0 || cc > u_size.y - 1.0) { o = vec4(0.0, 0.0, 0.0, u_dim); return; }
  int r = min(int(rr), int(u_size.x) - 2), c = min(int(cc), int(u_size.y) - 2);
  float a = cc - float(c), b = rr - float(r);
  float v00 = at(r, c), v01 = at(r, c + 1), v10 = at(r + 1, c), v11 = at(r + 1, c + 1);
  if (isnan(v00) || isnan(v01) || isnan(v10) || isnan(v11)) {
    // the domain's edge: the nearest valid neighbour, else outside
    float v = isnan(v00) ? (isnan(v01) ? (isnan(v10) ? v11 : v10) : v01) : v00;
    if (isnan(v)) { o = vec4(0.0, 0.0, 0.0, u_dim); return; }
    v00 = v01 = v10 = v11 = v;
  }
  float v = mix(mix(v00, v01, a), mix(v10, v11, a), b);
  float t = u_range.z > 0.5 ? (log(max(v, 1e-6)) - log(u_range.x)) / (log(u_range.y) - log(u_range.x)) : (v - u_range.x) / (u_range.y - u_range.x);
  vec4 col = texture(u_lut, vec2(clamp(t, 0.0, 1.0) * (255.0 / 256.0) + 0.5 / 256.0, 0.5));
  o = vec4(col.rgb, col.a * u_alpha);
}`;
const FS_RELIEF = `#version 300 es
precision highp float;
${GEO}
uniform sampler2D u_relief; uniform vec2 u_rsize; uniform float u_light, u_dark;
out vec4 o;
void main() {
  vec2 g = geo();
  vec2 uv = vec2((g.y + 180.0) / 360.0, (90.0 - g.x) / 180.0);
  vec2 px = 1.0 / u_rsize;
  float h = texture(u_relief, uv).r;
  if (h <= 0.0) { o = vec4(0.0); return; }
  float e = texture(u_relief, uv + vec2(px.x, 0.0)).r - texture(u_relief, uv - vec2(px.x, 0.0)).r;
  float n = texture(u_relief, uv - vec2(0.0, px.y)).r - texture(u_relief, uv + vec2(0.0, px.y)).r;
  float s = clamp((n - e) * 9.0, -1.0, 1.0);  // lit from the north-west
  float hi = clamp(h * 1.6, 0.0, 1.0);
  o = s > 0.0 ? vec4(1.0, 1.0, 1.0, s * u_light + hi * 0.05) : vec4(0.0, 0.0, 0.0, -s * u_dark);
}`;

function compile(gl, vs, fs) {
  const p = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
  for (let i = 0; i < n; ++i) { const a = gl.getActiveUniform(p, i); u[a.name] = gl.getUniformLocation(p, a.name); }
  return { p, u };
}

// Natural Earth parts -> GL_LINES vertices (lines) or fan triangles (polygon rings, for the stencil fill)
export function parseNE(buf, kind) {
  const dv = new DataView(buf);
  const n = dv.getUint32(0, true);
  const offs = new Uint32Array(buf, 4, n + 1);
  const pts = new Float32Array(buf, 4 + 4 * (n + 1));
  let count = 0;
  for (let i = 0; i < n; ++i) {
    const m = offs[i + 1] - offs[i];
    count += kind === "line" ? 2 * (m - 1) : 3 * Math.max(0, m - 2);
  }
  const out = new Float32Array(2 * count);
  let o = 0;
  for (let i = 0; i < n; ++i) {
    const a = offs[i], b = offs[i + 1];
    if (kind === "line") {
      for (let k = a; k + 1 < b; ++k) { out[o++] = pts[2 * k]; out[o++] = pts[2 * k + 1]; out[o++] = pts[2 * k + 2]; out[o++] = pts[2 * k + 3]; }
    } else {
      for (let k = a + 1; k + 1 < b; ++k) {
        out[o++] = pts[2 * a]; out[o++] = pts[2 * a + 1];
        out[o++] = pts[2 * k]; out[o++] = pts[2 * k + 1];
        out[o++] = pts[2 * k + 2]; out[o++] = pts[2 * k + 3];
      }
    }
  }
  return out;
}

export const THEMES = {
  dark: { ocean: [0.043, 0.075, 0.118], land: [0.118, 0.137, 0.161], lake: [0.055, 0.094, 0.145], coast: [0.78, 0.84, 0.9, 0.55],
          border: [0.85, 0.88, 0.92, 0.32], river: [0.35, 0.55, 0.78, 0.35], iso: [1, 1, 1, 0.78], light: 0.16, dark: 0.45, dim: 0.38 },
  light: { ocean: [0.80, 0.86, 0.91], land: [0.95, 0.94, 0.91], lake: [0.80, 0.86, 0.91], coast: [0.25, 0.32, 0.4, 0.6],
           border: [0.3, 0.3, 0.35, 0.45], river: [0.35, 0.55, 0.78, 0.5], iso: [0.1, 0.12, 0.16, 0.8], light: 0.25, dark: 0.22, dim: 0.22 },
};

export class MapView {
  constructor(root) {
    this.root = root;
    this.gl_canvas = root.querySelector("canvas.gl");
    this.flow = root.querySelector("canvas.flow");
    this.ovl = root.querySelector("canvas.ovl");
    const gl = this.gl_canvas.getContext("webgl2", { stencil: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
    this.gl = gl;
    if (!gl) {
      // no WebGL2 (blocked, or an old GPU): a slower 2-D canvas drawing of the same map
      this.c2d = this.gl_canvas.getContext("2d");
      this.layers = {};
      this.fields = {};
      this._common();
      return;
    }
    this.prog = {
      line: compile(gl, VS_LL, FS_COLOR),
      full: compile(gl, VS_FULL, FS_COLOR),
      field: compile(gl, VS_FULL, FS_FIELD),
      relief: compile(gl, VS_FULL, FS_RELIEF),
    };
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    this.vao = gl.createVertexArray();
    this.layers = {};       // name -> {buf, count}
    this.fields = {};       // slot -> {tex, lut, grid, size, range, alpha}
    this._common();
  }
  _common() {
    this.center = [0.5, 0.4];
    this.zoom = 3;          // pixels per world = 256 * 2^zoom
    this.theme = THEMES.dark;
    this.split = null;      // a fraction of the width for side-by-side comparison
    this.dim = true;
    this.handlers = {};
    this.drawOverlay = null;
    this.wind = null;       // (lat, lon) -> [u, v] in m/s, or null
    this.particles = [];
    this.showParticles = true;
    this._dirty = true;
    this.resize();
    addEventListener("resize", () => this.resize());
    this._interact();
    requestAnimationFrame((t) => this._frame(t));
  }

  on(ev, fn) { this.handlers[ev] = fn; }
  emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }
  get scale() { return 256 * 2 ** this.zoom; }
  setTheme(name) { this.theme = THEMES[name] || THEMES.dark; this.request(); }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.W = this.root.clientWidth;
    this.H = this.root.clientHeight;
    for (const c of [this.gl_canvas, this.flow, this.ovl]) {
      c.width = Math.round(this.W * dpr);
      c.height = Math.round(this.H * dpr);
    }
    this.flow.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ovl.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    this.request(true);
  }
  request(resetParticles = false) { this._dirty = true; if (resetParticles) this._resetParticles = true; }

  // ---- projection
  static wx(lon) { return (lon + 180) / 360; }
  static wy(lat) { const l = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180; return (1 - Math.log(Math.tan(Math.PI / 4 + l / 2)) / Math.PI) / 2; }
  project(lat, lon) {
    let x = MapView.wx(lon) - this.center[0];
    x -= Math.round(x);  // the copy of the world nearest the centre
    return [x * this.scale + this.W / 2, (MapView.wy(lat) - this.center[1]) * this.scale + this.H / 2];
  }
  // the same, keeping the longitude continuous from a reference longitude (outlines across 180)
  projectNear(lat, lon, refLon) {
    let d = lon - refLon;
    d -= 360 * Math.round(d / 360);
    const [x0, y] = this.project(lat, refLon);
    return [x0 + d / 360 * this.scale, y];
  }
  unproject(px, py) {
    const x = this.center[0] + (px - this.W / 2) / this.scale, y = this.center[1] + (py - this.H / 2) / this.scale;
    const lon = (((x % 1) + 1) % 1) * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI;
    return [lat, lon];
  }
  setView(lat, lon, zoom) {
    this.center = [MapView.wx(lon), MapView.wy(lat)];
    if (zoom != null) this.zoom = Math.max(1, Math.min(12, zoom));
    this.request(true);
    this.emit("view");
  }
  fit(lat0, lon0, lat1, lon1, pad = 0.12) {
    const x0 = MapView.wx(lon0), x1 = MapView.wx(lon1 < lon0 ? lon1 + 360 : lon1), y0 = MapView.wy(lat1), y1 = MapView.wy(lat0);
    const w = Math.max(1e-6, x1 - x0), hgt = Math.max(1e-6, y1 - y0);
    const z = Math.log2(Math.min(this.W * (1 - 2 * pad) / w, this.H * (1 - 2 * pad) / hgt) / 256);
    this.center = [(x0 + x1) / 2, (y0 + y1) / 2];
    this.zoom = Math.max(1, Math.min(12, z));
    this.request(true);
    this.emit("view");
  }
  view() { const [lat, lon] = this.unproject(this.W / 2, this.H / 2); return { lat, lon, zoom: this.zoom }; }

  // ---- data
  setLayer(name, verts) {
    const gl = this.gl;
    if (!gl) { this.layers[name] = { verts, count: verts.length / 2 }; this.request(); return; }
    let L = this.layers[name];
    if (!L) { L = this.layers[name] = { buf: gl.createBuffer(), count: 0 }; }
    gl.bindBuffer(gl.ARRAY_BUFFER, L.buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    L.count = verts.length / 2;
    this.request();
  }
  setRelief(bytes, w, h) {
    const gl = this.gl;
    if (!gl) return;
    this.relief = { tex: gl.createTexture(), w, h };
    gl.bindTexture(gl.TEXTURE_2D, this.relief.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.request();
  }
  // slot "a" (or "b" for the right half of a comparison); data Float32Array [nlat][nlon]; scale with lut(), lo, hi, log
  setField(slot, f) {
    const gl = this.gl;
    if (!f) { delete this.fields[slot]; this.request(); return; }
    if (!gl) { this.fields[slot] = { ...f, range: [f.lo, f.hi, f.log ? 1 : 0], alpha: f.alpha ?? 1 }; this.request(); return; }
    let F = this.fields[slot];
    if (!F) {
      F = this.fields[slot] = { tex: gl.createTexture(), lut: gl.createTexture() };
      for (const t of [F.tex, F.lut]) {
        gl.bindTexture(gl.TEXTURE_2D, t);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, t === F.lut ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, t === F.lut ? gl.LINEAR : gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
    }
    const g = f.grid;
    gl.bindTexture(gl.TEXTURE_2D, F.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, g.nlon, g.nlat, 0, gl.RED, gl.FLOAT, f.data);
    if (F.lutData !== f.lut) {
      gl.bindTexture(gl.TEXTURE_2D, F.lut);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, f.lut);
      F.lutData = f.lut;
    }
    Object.assign(F, { grid: g, range: [f.lo, f.hi, f.log ? 1 : 0], alpha: f.alpha ?? 1 });
    this.request();
  }
  setIsolines(verts) {
    if (!verts) { delete this.layers.iso; this.request(); return; }
    this.setLayer("iso", verts);
  }

  // ---- rendering
  _uniforms(P) {
    const gl = this.gl;
    gl.uniform2f(P.u.u_center, this.center[0], this.center[1]);
    gl.uniform1f(P.u.u_scale, this.scale);
    gl.uniform2f(P.u.u_view, this.W, this.H);
    if (P.u.u_dpr) gl.uniform1f(P.u.u_dpr, this.dpr);
  }
  _drawLL(name, mode, color) {
    const gl = this.gl, L = this.layers[name];
    if (!L || !L.count) return;
    const P = this.prog.line;
    gl.useProgram(P.p);
    this._uniforms(P);
    gl.uniform4fv(P.u.u_color, color);
    gl.bindBuffer(gl.ARRAY_BUFFER, L.buf);
    const loc = gl.getAttribLocation(P.p, "a_ll");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    // every copy of the world on the screen
    const half = this.W / 2 / this.scale;
    for (let off = Math.floor(this.center[0] - half) - 0; off <= Math.ceil(this.center[0] + half); ++off) {
      gl.uniform1f(P.u.u_off, off);
      gl.drawArrays(mode, 0, L.count);
    }
  }
  _fill(name, rgb) {
    const gl = this.gl;
    if (!this.layers[name]) return;
    gl.enable(gl.STENCIL_TEST);
    gl.colorMask(false, false, false, false);
    gl.stencilFunc(gl.ALWAYS, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
    this._drawLL(name, gl.TRIANGLES, [0, 0, 0, 0]);
    gl.colorMask(true, true, true, true);
    gl.stencilFunc(gl.NOTEQUAL, 0, 0xff);
    gl.stencilOp(gl.ZERO, gl.ZERO, gl.ZERO);
    const P = this.prog.full;
    gl.useProgram(P.p);
    gl.uniform4f(P.u.u_color, rgb[0], rgb[1], rgb[2], 1);
    this._fullscreen(P);
    gl.disable(gl.STENCIL_TEST);
  }
  _fullscreen(P) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const loc = gl.getAttribLocation(P.p, "a_p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  _field(F) {
    const gl = this.gl, P = this.prog.field;
    gl.useProgram(P.p);
    this._uniforms(P);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, F.tex);
    gl.uniform1i(P.u.u_data, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, F.lut);
    gl.uniform1i(P.u.u_lut, 1);
    const g = F.grid;
    gl.uniform4f(P.u.u_grid, g.lat0, g.lon0, g.dlat, g.dlon);
    gl.uniform2f(P.u.u_size, g.nlat, g.nlon);
    gl.uniform3f(P.u.u_range, F.range[0], F.range[1], F.range[2]);
    gl.uniform1f(P.u.u_alpha, F.alpha);
    gl.uniform1f(P.u.u_dim, this.dim ? this.theme.dim : 0);
    this._fullscreen(P);
    gl.activeTexture(gl.TEXTURE0);
  }
  render() {
    if (!this.gl) { this._render2d(); return; }
    const gl = this.gl, th = this.theme;
    gl.viewport(0, 0, this.gl_canvas.width, this.gl_canvas.height);
    gl.clearColor(th.ocean[0], th.ocean[1], th.ocean[2], 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const fine = this.zoom >= 4.5;
    this._fill(fine ? "land10" : "land50", th.land);
    if (this.relief) {
      const P = this.prog.relief;
      gl.useProgram(P.p);
      this._uniforms(P);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.relief.tex);
      gl.uniform1i(P.u.u_relief, 0);
      gl.uniform2f(P.u.u_rsize, this.relief.w, this.relief.h);
      gl.uniform1f(P.u.u_light, th.light);
      gl.uniform1f(P.u.u_dark, th.dark);
      this._fullscreen(P);
    }
    this._fill(fine ? "lakes10" : "lakes50", th.lake);
    // the field(s): one, or two halves of a comparison
    if (this.fields.a) {
      if (this.split != null && this.fields.b) {
        const xs = Math.round(this.split * this.gl_canvas.width);
        gl.enable(gl.SCISSOR_TEST);
        gl.scissor(0, 0, xs, this.gl_canvas.height);
        this._field(this.fields.a);
        gl.scissor(xs, 0, this.gl_canvas.width - xs, this.gl_canvas.height);
        this._field(this.fields.b);
        gl.disable(gl.SCISSOR_TEST);
      } else {
        this._field(this.fields.a);
      }
    }
    if (this.zoom >= 3.5) this._drawLL(fine ? "rivers10" : "rivers50", gl.LINES, th.river);
    this._drawLL(this.zoom >= 4.5 ? "coast10" : this.zoom >= 2.2 ? "coast50" : "coast110", gl.LINES, th.coast);
    this._drawLL(fine ? "border10" : "border50", gl.LINES, th.border);
    if (this.layers.iso) this._drawLL("iso", gl.LINES, th.iso);
    // the annotations
    const ctx = this.ovl.getContext("2d");
    ctx.clearRect(0, 0, this.W, this.H);
    if (this.drawOverlay) this.drawOverlay(ctx, this);
  }

  // ---- the 2-D canvas drawing (no WebGL2): the field at a third of the resolution, the lines, the annotations
  _render2d() {
    const ctx = this.c2d, th = this.theme, dpr = this.dpr;
    const rgb = (c, a = 1) => `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${c[3] ?? a})`;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = rgb(th.land);
    ctx.fillRect(0, 0, this.gl_canvas.width, this.gl_canvas.height);
    const F = this.fields.a;
    if (F) {
      const k = 3, w = Math.ceil(this.W / k), hh = Math.ceil(this.H / k);
      const img = new ImageData(w, hh), px = img.data, g = F.grid, L = F.lut;
      const [lo, hi, lg] = F.range;
      const dimA = Math.round(255 * (this.dim ? th.dim : 0));
      for (let y = 0; y < hh; ++y) {
        const lat = this.unproject(0, y * k + k / 2)[0];
        const rr = (lat - g.lat0) / g.dlat;
        for (let x = 0; x < w; ++x) {
          const o = 4 * (y * w + x);
          let d = this.unproject(x * k + k / 2, 0)[1] - g.lon0;
          d -= 360 * Math.floor(d / 360);
          const cc = d / g.dlon;
          let v = NaN;
          if (rr >= 0 && cc >= 0 && rr <= g.nlat - 1 && cc <= g.nlon - 1) {
            const r = Math.min(Math.floor(rr), g.nlat - 2), c = Math.min(Math.floor(cc), g.nlon - 2), a = cc - c, b = rr - r;
            const q = (i, j) => F.data[i * g.nlon + j];
            v = (q(r, c) * (1 - a) + q(r, c + 1) * a) * (1 - b) + (q(r + 1, c) * (1 - a) + q(r + 1, c + 1) * a) * b;
            if (Number.isNaN(v)) v = q(Math.round(rr), Math.round(cc));
          }
          if (Number.isNaN(v)) { px[o + 3] = dimA; continue; }
          const tt = lg ? (Math.log(Math.max(v, 1e-6)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) : (v - lo) / (hi - lo);
          const n = 4 * Math.round(255 * Math.max(0, Math.min(1, tt)));
          px[o] = L[n]; px[o + 1] = L[n + 1]; px[o + 2] = L[n + 2]; px[o + 3] = Math.round(L[n + 3] * F.alpha);
        }
      }
      const off = this._off || (this._off = document.createElement("canvas"));
      off.width = w; off.height = hh;
      off.getContext("2d").putImageData(img, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(off, 0, 0, w * k * dpr, hh * k * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const lines = (name, color, width = 1) => {
      const Ly = this.layers[name];
      if (!Ly) return;
      const v = Ly.verts;
      ctx.strokeStyle = rgb(color); ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < v.length; i += 4) {
        const [x0, y0] = this.project(v[i + 1], v[i]);
        const [x1, y1] = this.project(v[i + 3], v[i + 2]);
        if (Math.abs(x1 - x0) > this.W / 2) continue;
        if ((x0 < 0 && x1 < 0) || (y0 < 0 && y1 < 0) || (x0 > this.W && x1 > this.W) || (y0 > this.H && y1 > this.H)) continue;
        ctx.moveTo(x0, y0); ctx.lineTo(x1, y1);
      }
      ctx.stroke();
    };
    lines(this.zoom >= 2.2 ? "coast50" : "coast110", th.coast, 1.1);
    lines("border50", th.border);
    if (this.layers.iso) lines("iso", th.iso, 1.2);
    const o = this.ovl.getContext("2d");
    o.clearRect(0, 0, this.W, this.H);
    if (this.drawOverlay) this.drawOverlay(o, this);
  }

  // ---- wind particles: screen space, a short life each, faded trails
  _particles() {
    const ctx = this.flow.getContext("2d");
    if (this._resetParticles) {
      ctx.clearRect(0, 0, this.W, this.H);
      this.particles = [];
      this._resetParticles = false;
    }
    if (!this.wind || !this.showParticles) {
      if (this.particles.length) { ctx.clearRect(0, 0, this.W, this.H); this.particles = []; }
      return;
    }
    const want = Math.min(9000, Math.round(this.W * this.H / 170));
    while (this.particles.length < want) this.particles.push(this._spawn({}));
    if (this.particles.length > want) this.particles.length = want;
    ctx.globalCompositeOperation = "destination-in";
    ctx.fillStyle = "rgba(0,0,0,0.92)";
    ctx.fillRect(0, 0, this.W, this.H);
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = this.particleColor || "rgba(255,255,255,0.8)";
    ctx.lineWidth = 1.1;
    ctx.beginPath();
    const k = 0.18 * Math.min(1.6, Math.max(0.7, (this.zoom - 2) / 4));
    for (const p of this.particles) {
      if (++p.age > p.life) { this._spawn(p); continue; }
      const [lat, lon] = this.unproject(p.x, p.y);
      const w = this.wind(lat, lon);
      if (!w) { this._spawn(p); continue; }
      const nx = p.x + w[0] * k, ny = p.y - w[1] * k;
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(nx, ny);
      p.x = nx;
      p.y = ny;
    }
    ctx.stroke();
  }
  _spawn(p) {
    p.x = Math.random() * this.W;
    p.y = Math.random() * this.H;
    p.age = 0;
    p.life = 40 + Math.random() * 60;
    return p;
  }
  _frame() {
    if (this._dirty) { this._dirty = false; this.render(); }
    this._particles();
    requestAnimationFrame((t) => this._frame(t));
  }

  // ---- pan, zoom (wheel, pinch, keys), click, Shift-drag rectangles, hover
  _interact() {
    const el = this.ovl;
    el.style.touchAction = "none";
    const pts = new Map();
    let drag = null, rect = null, pinch = null;
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), zoom: this.zoom };
        drag = null;
        return;
      }
      if (e.shiftKey) { rect = { x0: e.offsetX, y0: e.offsetY, x1: e.offsetX, y1: e.offsetY }; return; }
      drag = { x: e.offsetX, y: e.offsetY, c: [...this.center], moved: false };
    });
    el.addEventListener("pointermove", (e) => {
      if (pts.has(e.pointerId)) pts.set(e.pointerId, [e.offsetX, e.offsetY]);
      if (pinch && pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        this._zoomAt((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, pinch.zoom + Math.log2(d / pinch.d));
        return;
      }
      if (rect) { rect.x1 = e.offsetX; rect.y1 = e.offsetY; this.rect = rect; this.request(); return; }
      if (drag) {
        const dx = e.offsetX - drag.x, dy = e.offsetY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          this.center = [drag.c[0] - dx / this.scale, Math.max(0, Math.min(1, drag.c[1] - dy / this.scale))];
          el.classList.add("dragging");
          this.request(true);
          this.emit("view");
        }
        return;
      }
      const [lat, lon] = this.unproject(e.offsetX, e.offsetY);
      this.emit("hover", lat, lon, e);
    });
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      el.classList.remove("dragging");
      if (rect) {
        const r = rect;
        rect = null;
        this.rect = null;
        this.request();
        if (Math.abs(r.x1 - r.x0) > 8 && Math.abs(r.y1 - r.y0) > 8) {
          const a = this.unproject(Math.min(r.x0, r.x1), Math.max(r.y0, r.y1)), b = this.unproject(Math.max(r.x0, r.x1), Math.min(r.y0, r.y1));
          this.emit("rect", a[0], a[1], b[0], b[1]);
        }
        return;
      }
      if (drag && !drag.moved && e.type === "pointerup") {
        const [lat, lon] = this.unproject(e.offsetX, e.offsetY);
        this.emit("click", lat, lon, e);
      }
      drag = null;
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    el.addEventListener("pointerleave", () => this.emit("leave"));
    el.addEventListener("wheel", (e) => {
      e.preventDefault();
      this._zoomAt(e.offsetX, e.offsetY, this.zoom - e.deltaY * (e.deltaMode ? 0.05 : 0.0018));
    }, { passive: false });
    el.addEventListener("dblclick", (e) => this._zoomAt(e.offsetX, e.offsetY, this.zoom + 1));
  }
  _zoomAt(px, py, z) {
    z = Math.max(1, Math.min(12, z));
    const [lat, lon] = this.unproject(px, py);
    const wx = MapView.wx(lon), wy = MapView.wy(lat);
    let cx = this.center[0];
    const before = cx + (px - this.W / 2) / this.scale;
    const shift = Math.round(before - wx);  // stay on the same copy of the world
    this.zoom = z;
    this.center = [wx + shift - (px - this.W / 2) / this.scale, wy - (py - this.H / 2) / this.scale];
    this.request(true);
    this.emit("view");
  }
  zoomBy(dz) { this._zoomAt(this.W / 2, this.H / 2, this.zoom + dz); }
  panBy(dx, dy) { this.center = [this.center[0] + dx / this.scale, this.center[1] + dy / this.scale]; this.request(true); this.emit("view"); }

  // a PNG of what is on the screen (the map, the particles, the annotations)
  snapshot() {
    this.render();  // (2-D or WebGL; the WebGL canvas keeps its drawing buffer)
    const c = document.createElement("canvas");
    c.width = this.gl_canvas.width;
    c.height = this.gl_canvas.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(this.gl_canvas, 0, 0);
    ctx.drawImage(this.flow, 0, 0);
    ctx.drawImage(this.ovl, 0, 0);
    return c;
  }
}

// marching squares on a latitude-longitude grid: GL_LINES vertices (lon, lat) and label positions
export function isolines(data, g, step, lo, hi) {
  const out = [], labels = [];
  const { nlat, nlon, lat0, lon0, dlat, dlon } = g;
  const v = (r, c) => data[r * nlon + c];
  const first = Math.ceil(lo / step) * step;
  for (let level = first; level <= hi; level += step) {
    let n = 0;
    for (let r = 0; r + 1 < nlat; ++r)
      for (let c = 0; c + 1 < nlon; ++c) {
        const a = v(r, c), b = v(r, c + 1), cc = v(r + 1, c + 1), d = v(r + 1, c);
        if (Number.isNaN(a + b + cc + d)) continue;
        const pts = [];
        const edge = (p, q, r0, c0, r1, c1) => {
          if ((p - level) * (q - level) < 0) { const t = (level - p) / (q - p); pts.push(lon0 + (c0 + t * (c1 - c0)) * dlon, lat0 + (r0 + t * (r1 - r0)) * dlat); }
        };
        edge(a, b, r, c, r, c + 1);
        edge(b, cc, r, c + 1, r + 1, c + 1);
        edge(d, cc, r + 1, c, r + 1, c + 1);
        edge(a, d, r, c, r + 1, c);
        for (let k = 0; k + 3 < pts.length; k += 4) {
          out.push(pts[k], pts[k + 1], pts[k + 2], pts[k + 3]);
          if (n++ % 40 === 12) labels.push([pts[k + 1], pts[k], level]);
        }
      }
  }
  return { verts: new Float32Array(out), labels };
}
