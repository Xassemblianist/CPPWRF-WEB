// SPDX-License-Identifier: GPL-3.0-or-later
// The model runs here, off the page's thread: the case files go into the module's MEMFS, the model steps in chunks
// (web_step), and after every chunk the x-z sections go to the page. At the end the worker checks the wrfout file
// against the expected hashes (nchash.js) and hands the file to the page.
//
// Messages to the page: {type: "status" | "meta" | "frame" | "done" | "error", ...}. The page never calls the module
// itself, so a later pthreads build (a module whose model loop runs on its own worker pool, with SharedArrayBuffer
// and the COOP/COEP headers) can replace cppwrf_web.mjs behind the same messages.
import factory from "./cppwrf_web.mjs";
import { hashes, compare } from "./nchash.js";

const CASE_FILES = ["run.ini", "namelist.input", "input_sounding"];
const FIELDS = [["t", 0], ["w", 1], ["qr", 2], ["z", 3]];  // z: height of the mass levels [m]

let M = null;

function section(which) {
  const p = M._malloc(8);
  const ptr = M.ccall("web_field", "number", ["number", "number", "number"], [which, p, p + 4]);
  const nx = M.HEAP32[p >> 2], nz = M.HEAP32[(p + 4) >> 2];
  M._free(p);
  return { nx, nz, data: new Float64Array(M.HEAPF64.buffer, ptr, nx * nz).slice() };
}

function frame(step, dt) {
  const f = {};
  const transfer = [];
  for (const [k, w] of FIELDS) {
    f[k] = section(w);
    transfer.push(f[k].data.buffer);
  }
  postMessage({ type: "frame", step, time_s: step * dt, fields: f }, transfer);
}

const fail = (what) => { throw new Error(what + ": " + M.UTF8ToString(M.ccall("web_error", "number", [], []))); };

async function run({ caseName, chunk }) {
  const t0 = performance.now();
  postMessage({ type: "status", text: "loading the model" });
  M = await factory({
    print: (s) => postMessage({ type: "status", text: s }),
    printErr: (s) => postMessage({ type: "status", text: s }),
  });
  const base = new URL(`cases/${caseName}/`, self.location.href);
  M.FS.mkdir("/work");
  for (const f of CASE_FILES) {
    const r = await fetch(new URL(f, base));
    if (!r.ok) throw new Error(`${f}: HTTP ${r.status}`);
    M.FS.writeFile("/work/" + f, new Uint8Array(await r.arrayBuffer()));
  }
  const expected = await (await fetch(new URL(`expected/${caseName}.json`, self.location.href))).json();
  M.FS.chdir("/work");

  postMessage({ type: "status", text: "initialising (ideal.exe)" });
  const nsteps = M.ccall("web_init", "number", ["string", "string"], ["run.ini", "out"]);
  if (nsteps < 0) fail("init");
  const dt = Number((M.FS.readFile("/work/run.ini", { encoding: "utf8" }).match(/^dt\s*=\s*([0-9.]+)/m) || [])[1] || 0);
  const t1 = performance.now();
  postMessage({ type: "meta", nsteps, dt, loadSeconds: (t1 - t0) / 1000 });
  frame(0, dt);

  let n = 0;
  while (n < nsteps) {
    n = M.ccall("web_step", "number", ["number"], [chunk]);
    if (n < 0) fail("step");
    frame(n, dt);
  }
  const t2 = performance.now();
  if (M.ccall("web_finish", "number", [], []) < 0) fail("finish");

  postMessage({ type: "status", text: "checking wrfout against the native hashes" });
  const name = M.FS.readdir("/work/out").find((f) => f.startsWith("wrfout_"));
  const bytes = M.FS.readFile("/work/out/" + name);
  const got = await hashes(bytes);
  const check = compare(expected, got);
  const peakBytes = M.ccall("web_peak_bytes", "number", [], []);
  const file = bytes.slice().buffer;
  postMessage({ type: "done", name, file, check, expectedLabel: expected.label, nsteps,
                varNames: Object.keys(expected.vars), times: expected.times,
                steppingSeconds: (t2 - t1) / 1000, wallSeconds: (performance.now() - t0) / 1000,
                peakMB: peakBytes / 2 ** 20 }, [file]);
}

self.onmessage = (e) => {
  if (e.data.cmd === "run")
    run(e.data).catch((err) => postMessage({ type: "error", text: String(err && err.message || err) }));
};
