// SPDX-License-Identifier: GPL-3.0-or-later
// SHA-256 of every variable and output time of a NetCDF classic file (CDF-1, CDF-2, CDF-5), as tools/nc_hashes.py
// computes them: the values as stored (big-endian), without the padding to 4 bytes. Browser (worker) and node.

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 8 };

export function parseClassic(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x43 || bytes[1] !== 0x44 || bytes[2] !== 0x46 || ![1, 2, 5].includes(bytes[3]))
    throw new Error("not a NetCDF classic file");
  const version = bytes[3];
  let p = 4;
  const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
  const u64 = () => { const v = Number(dv.getBigUint64(p)); p += 8; return v; };
  const count = () => (version === 5 ? u64() : u32());
  const offset = () => (version === 1 ? u32() : u64());
  const name = () => {
    const n = count();
    const s = new TextDecoder().decode(bytes.subarray(p, p + n));
    p += (n + 3) & ~3;
    return s;
  };
  const skipAtts = () => {
    u32();
    const n = count();
    for (let a = 0; a < n; ++a) {
      name();
      const t = u32(), nv = count();
      p += (nv * TYPE_SIZE[t] + 3) & ~3;
    }
  };
  const numrecs = count();
  u32();
  const ndims = count();
  const dims = [];
  for (let d = 0; d < ndims; ++d) dims.push([name(), count()]);
  skipAtts();
  u32();
  const nvars = count();
  const vars = [];
  for (let v = 0; v < nvars; ++v) {
    const vname = name();
    const nd = count();
    const ids = [];
    for (let d = 0; d < nd; ++d) ids.push(count());
    skipAtts();
    const t = u32();
    const vsize = version === 5 ? u64() : u32();
    const begin = offset();
    const rec = nd > 0 && dims[ids[0]][1] === 0;
    let n = 1;
    ids.forEach((id, k) => { if (!(k === 0 && rec)) n *= dims[id][1]; });
    vars.push({ name: vname, rec, nbytes: n * TYPE_SIZE[t], vsize, begin });
  }
  const recs = vars.filter((v) => v.rec);
  const recsize = recs.length === 1 ? recs[0].nbytes : recs.reduce((s, v) => s + v.vsize, 0);
  return { version, numrecs, recsize, vars };
}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
const sha256 = async (u8) => hex(await crypto.subtle.digest("SHA-256", u8));

export async function hashes(bytes) {
  const { version, numrecs, recsize, vars } = parseClassic(bytes);
  const out = {};
  for (const v of vars) {
    const slices = v.rec
      ? Array.from({ length: numrecs }, (_, i) => v.begin + i * recsize)
      : [v.begin];
    out[v.name] = await Promise.all(slices.map((b) => sha256(bytes.subarray(b, b + v.nbytes))));
  }
  return { format: "CDF-" + version, times: numrecs, file_sha256: await sha256(bytes), file_bytes: bytes.length,
           vars: out };
}

// the comparison of tools/nc_hashes.py --check: a list of differences (empty: every hash equal)
export function compare(expected, got) {
  const bad = [];
  let n = 0;
  for (const [name, hs] of Object.entries(expected.vars)) {
    const g = got.vars[name];
    n += hs.length;
    if (!g) { bad.push(name + ": missing"); continue; }
    if (g.length !== hs.length) { bad.push(`${name}: ${g.length} times, expected ${hs.length}`); continue; }
    hs.forEach((h, i) => { if (h !== g[i]) bad.push(`${name} time ${i}`); });
  }
  for (const name of Object.keys(got.vars)) if (!(name in expected.vars)) bad.push(name + ": not expected");
  return { nvars: Object.keys(expected.vars).length, nhashes: n, bad,
           fileIdentical: expected.file_sha256 === got.file_sha256 };
}
