// SPDX-License-Identifier: GPL-3.0-or-later
// Headless run of the wasm model under node, through the same calls as the browser worker (web/worker.js):
// the case files go into the module's MEMFS, the model runs, the wrfout file comes back to disk.
//
//   node tests/run_node.mjs <module.mjs> <case dir> <out dir> [steps per call]
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modPath, caseDir, outDir, chunkArg] = process.argv.slice(2);
if (!modPath || !caseDir || !outDir) {
  console.error("usage: node run_node.mjs <cppwrf_web.mjs> <case dir> <out dir> [steps per call]");
  process.exit(2);
}
const chunk = Number(chunkArg || 50);
const t0 = performance.now();
const factory = (await import(pathToFileURL(path.resolve(modPath)).href)).default;
const M = await factory({ print: (s) => console.log(s), printErr: (s) => console.error(s) });

M.FS.mkdir("/work");
for (const f of fs.readdirSync(caseDir)) {
  const p = path.join(caseDir, f);
  if (fs.statSync(p).isFile()) M.FS.writeFile("/work/" + f, fs.readFileSync(p));
}
M.FS.chdir("/work");

const nsteps = M.ccall("web_init", "number", ["string", "string"], ["run.ini", "out"]);
if (nsteps < 0) throw new Error(M.UTF8ToString(M.ccall("web_error", "number", [], [])));
const t1 = performance.now();
let n = 0;
while (n < nsteps) {
  n = M.ccall("web_step", "number", ["number"], [chunk]);
  if (n < 0) throw new Error(M.UTF8ToString(M.ccall("web_error", "number", [], [])));
}
const t2 = performance.now();
if (M.ccall("web_finish", "number", [], []) < 0) throw new Error("finish failed");
const t3 = performance.now();

fs.mkdirSync(outDir, { recursive: true });
for (const f of M.FS.readdir("/work/out")) {
  if (f === "." || f === "..") continue;
  fs.writeFileSync(path.join(outDir, f), M.FS.readFile("/work/out/" + f));
}
const peak = M.ccall("web_peak_bytes", "number", [], []);
const r = { steps: nsteps, load_s: (t1 - t0) / 1000, stepping_s: (t2 - t1) / 1000, finish_s: (t3 - t2) / 1000,
            wall_s: (performance.now() - t0) / 1000, wasm_heap_peak_mb: peak / 2 ** 20,
            node_rss_peak_mb: process.resourceUsage().maxRSS / 1024 };
console.log(JSON.stringify(r));
