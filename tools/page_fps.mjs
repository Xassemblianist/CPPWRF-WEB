// SPDX-License-Identifier: GPL-3.0-or-later
// The forecast page's frame rate in headless Chrome, over the DevTools protocol (node >= 22, no package):
//   node tools/page_fps.mjs URL [--gpu] [--seconds N]
// Prints JSON: the renderer, frames per second with the wind particles running, and while panning and zooming.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const url = process.argv[2];
const gpu = process.argv.includes("--gpu");
const secs = Number(process.argv[process.argv.indexOf("--seconds") + 1]) || 6;
const port = 9300 + Math.floor(Math.random() * 500);
const prof = mkdtempSync(join(process.env.FPS_TMP || tmpdir(), "cppwrf-fps-"));
const flags = gpu ? "--use-angle=gl-egl --use-gl=angle --ignore-gpu-blocklist --enable-gpu".split(" ")
                  : ["--enable-unsafe-swiftshader", "--use-angle=swiftshader"];
const chrome = spawn("google-chrome", ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, "--window-size=1440,900",
                                       "--disable-background-timer-throttling", "--disable-renderer-backgrounding", ...flags, "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let target;
for (let k = 0; k < 50 && !target; ++k) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page"); } catch { /* starting */ }
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { ws.onopen = r; });
let id = 0;
const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
const send = (method, params = {}) => new Promise((r) => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const evaluate = async (expr) => (await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;
await send("Page.navigate", { url });
await sleep(6000);
const count = (ms, during) => evaluate(`new Promise((res) => { let n = 0; const t0 = performance.now(); const f = (t) => { ++n; ${during || ""}
  if (t - t0 < ${ms}) requestAnimationFrame(f); else res(Math.round(1000 * n / (t - t0))); }; requestAnimationFrame(f); })`);
const out = {
  renderer: await evaluate(`(() => { const gl = cppwrf.map.gl; if (!gl) return "2d canvas"; const e = gl.getExtension("WEBGL_debug_renderer_info"); return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : "webgl2"; })()`),
  layer: await evaluate("cppwrf.layer.id"),
  grid: await evaluate("cppwrf.current && `${cppwrf.current.grid.nlat}x${cppwrf.current.grid.nlon}`"),
  particles: await evaluate("cppwrf.map.particles.length"),
  fps_idle: await count(secs * 1000),
  fps_panning: await count(secs * 1000, "cppwrf.map.panBy(2, 0); cppwrf.map.zoomBy(Math.sin(t / 500) * 0.01);"),
};
console.log(JSON.stringify(out));
ws.close();
chrome.kill();
await sleep(300);
rmSync(prof, { recursive: true, force: true });
