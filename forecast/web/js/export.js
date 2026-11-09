// SPDX-License-Identifier: GPL-3.0-or-later
// Export: the map as PNG, the animation as WebM (MediaRecorder), the current layer as a GeoTIFF (float32, EPSG:4326),
// and links to the run's wrfout files.
import { h, t, api } from "./util.js";

export function download(blob, name) {
  const a = h("a", { href: URL.createObjectURL(blob), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// the map with the legend and the time stamp drawn in
export function composite(app) {
  const c = app.map.snapshot();
  const ctx = c.getContext("2d");
  const dpr = app.map.dpr;
  ctx.save();
  ctx.scale(dpr, dpr);
  const W = c.width / dpr, H = c.height / dpr;
  ctx.fillStyle = "rgba(10,16,24,0.78)";
  ctx.fillRect(10, H - 54, 330, 44);
  ctx.fillStyle = "#e6ebf1";
  ctx.font = "600 13px sans-serif";
  ctx.fillText(app.caption(), 18, H - 36);
  ctx.font = "11px sans-serif";
  ctx.fillText(`CPPWRF ${app.run?.info?.cppwrf_commit || ""} · GFS ${app.run?.info?.settings?.time?.cycle || ""}Z`, 18, H - 18);
  const g = app.legendGradient;
  if (g) {
    const lg = ctx.createLinearGradient(W - 230, 0, W - 20, 0);
    g.forEach((col, i) => lg.addColorStop(i / (g.length - 1), col));
    ctx.fillStyle = "rgba(10,16,24,0.78)";
    ctx.fillRect(W - 240, H - 40, 230, 30);
    ctx.fillStyle = lg;
    ctx.fillRect(W - 230, H - 33, 210, 10);
    ctx.fillStyle = "#e6ebf1";
    ctx.fillText(app.legendUnit || "", W - 230, H - 13);
  }
  ctx.restore();
  return c;
}

export async function png(app) {
  const c = composite(app);
  c.toBlob((b) => download(b, `cppwrf-${app.run?.id || "map"}-${app.frame}.png`), "image/png");
}

// every ready frame, a fixed number of video frames each
export async function webm(app, onProgress) {
  if (!("MediaRecorder" in window)) throw new Error("MediaRecorder");
  const meta = app.run.meta;
  const frames = meta.ready;
  const first = composite(app);
  const canvas = h("canvas", { width: first.width, height: first.height });
  const ctx = canvas.getContext("2d");
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const type = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((x) => MediaRecorder.isTypeSupported(x));
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 6e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  const done = new Promise((r) => { rec.onstop = r; });
  rec.start();
  const keep = app.frame;
  for (let k = 0; k < frames.length; ++k) {
    await app.setFrame(frames[k], { wait: true });
    // let the particles run a little so the trails show
    for (let q = 0; q < 12; ++q) await new Promise((r) => requestAnimationFrame(r));
    ctx.drawImage(composite(app), 0, 0);
    for (let q = 0; q < 6; ++q) { track.requestFrame?.(); await new Promise((r) => setTimeout(r, 70)); }
    onProgress?.(k + 1, frames.length);
  }
  rec.stop();
  await done;
  await app.setFrame(keep);
  download(new Blob(chunks, { type: "video/webm" }), `cppwrf-${app.run.id}.webm`);
}

// a minimal GeoTIFF: one float32 band, north up, pixel-is-area, WGS 84 geographic
export function geotiff(data, g, name, nodata = "nan") {
  const W = g.nlon, H = g.nlat;
  const pix = new Float32Array(W * H);
  for (let r = 0; r < H; ++r) pix.set(data.subarray((H - 1 - r) * W, (H - r) * W), r * W);
  const entries = [];
  const extra = [];
  let extraOff = 0;
  const add = (tag, type, count, value) => entries.push({ tag, type, count, value });
  const blob = (bytes) => { const o = extraOff; extra.push(bytes); extraOff += bytes.byteLength + (bytes.byteLength & 1); return o; };
  const f64 = (a) => new Uint8Array(new Float64Array(a).buffer);
  const u16 = (a) => new Uint8Array(new Uint16Array(a).buffer);
  const ascii = (s) => new TextEncoder().encode(`${s}\0`);
  const ntag = 15, ifdSize = 2 + 12 * ntag + 4, header = 8;
  const base = header + ifdSize;
  const scale = blob(f64([g.dlon, g.dlat, 0]));
  const tie = blob(f64([0, 0, 0, g.lon0 - g.dlon / 2, g.lat0 + (H - 1) * g.dlat + g.dlat / 2, 0]));
  const keys = blob(u16([1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]));
  const ndBytes = ascii(nodata);  // 4 bytes or fewer: stored in the entry itself (TIFF 6.0)
  const nd = ndBytes.byteLength > 4 ? blob(ndBytes) : null;
  const desc = blob(ascii(name));
  const dataOff = base + extraOff;
  add(256, 4, 1, W); add(257, 4, 1, H); add(258, 3, 1, 32); add(259, 3, 1, 1); add(262, 3, 1, 1);
  add(270, 2, name.length + 1, base + desc);
  add(273, 4, 1, dataOff); add(277, 3, 1, 1); add(278, 4, 1, H); add(279, 4, 1, W * H * 4); add(339, 3, 1, 3);
  add(33550, 12, 3, base + scale); add(33922, 12, 6, base + tie); add(34735, 3, 16, base + keys);
  entries.push({ tag: 42113, type: 2, count: ndBytes.byteLength, value: nd == null ? 0 : base + nd, inline: nd == null ? ndBytes : null });
  entries.sort((a, b) => a.tag - b.tag);
  const buf = new ArrayBuffer(dataOff + W * H * 4);
  const dv = new DataView(buf);
  dv.setUint16(0, 0x4949); dv.setUint16(2, 42, true); dv.setUint32(4, 8, true);
  dv.setUint16(8, entries.length, true);
  entries.forEach((e, i) => {
    const o = 10 + 12 * i;
    dv.setUint16(o, e.tag, true); dv.setUint16(o + 2, e.type, true); dv.setUint32(o + 4, e.count, true);
    if (e.inline) e.inline.forEach((b, k) => dv.setUint8(o + 8 + k, b));
    else if (e.type === 3 && e.count === 1) dv.setUint16(o + 8, e.value, true);
    else dv.setUint32(o + 8, e.value, true);
  });
  dv.setUint32(10 + 12 * entries.length, 0, true);
  let o = base;
  const u8 = new Uint8Array(buf);
  for (const b of extra) { u8.set(b, o); o += b.byteLength + (b.byteLength & 1); }
  u8.set(new Uint8Array(pix.buffer), dataOff);
  return new Blob([buf], { type: "image/tiff" });
}

export async function menu(app) {
  const run = app.run;
  const body = h("div", {}, h("h3", { style: "margin-top:0" }, t("export.title")));
  const list = h("div", { style: "display:flex;flex-direction:column;gap:6px" });
  const btn = (label, fn, dis) => h("button", { class: "btn", disabled: dis, type: "button", onclick: async (e) => { const b = e.currentTarget; b.disabled = true; try { await fn(b); } catch (err) { app.toast(t("err.generic", { e: err.message })); } b.disabled = false; } }, label);
  list.append(btn(t("export.png"), () => png(app), !run));
  list.append(btn(t("export.webm"), (b) => webm(app, (k, n) => { b.textContent = `${t("export.recording")} ${k}/${n}`; }).finally(() => { b.textContent = t("export.webm"); }), !run || !("MediaRecorder" in window)));
  list.append(btn(t("export.geotiff"), async () => {
    const f = app.current;
    if (!f) return;
    download(geotiff(f.data, f.grid, f.name), `cppwrf-${run.id}-${f.name}-${String(app.frame).padStart(3, "0")}.tif`);
  }, !run));
  if (run && !run.sample && api.online) {
    try {
      const outs = (await api.get(`/api/v1/runs/${run.id}/files`)).sort((a, b) => a.path.localeCompare(b.path));
      if (outs.length) {
        list.append(h("b", { style: "margin-top:8px" }, t("export.wrfout")));
        for (const x of outs) list.append(h("a", { href: `${api.base}/api/v1/runs/${run.id}/out/${x.path}`, download: x.path.split("/").pop() }, `${x.path} (${(x.bytes / 1e6).toFixed(1)} MB)`));
      }
    } catch { /* no files listed */ }
  }
  body.append(list);
  await app.dialog(body, [[t("ui.close"), true]]);
}
