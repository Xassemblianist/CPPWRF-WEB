#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""SHA-256 of every variable and output time of a NetCDF classic file (CDF-1, CDF-2 or CDF-5).

No netCDF library: the file is parsed as the NetCDF classic format specification describes it. The hash of a
variable at one time is the SHA-256 of its values as stored in the file (big-endian, without the padding to 4
bytes); a variable without the record dimension has one hash. web/nchash.js computes the same in the browser.

  nc_hashes.py wrfout_d01_... [-o expected.json] [--label TEXT]
  nc_hashes.py --check expected.json wrfout_d01_...
"""
import argparse
import hashlib
import json
import struct
import sys

NC_DIMENSION, NC_VARIABLE, NC_ATTRIBUTE = 10, 11, 12
TYPE_SIZE = {1: 1, 2: 1, 3: 2, 4: 4, 5: 4, 6: 8, 7: 1, 8: 2, 9: 4, 10: 8, 11: 8}


class Reader:
    def __init__(self, data):
        self.d, self.p = data, 0
        if data[:3] != b"CDF" or data[3] not in (1, 2, 5):
            raise ValueError("not a NetCDF classic file")
        self.version = data[3]
        self.p = 4

    def u32(self):
        v = struct.unpack_from(">I", self.d, self.p)[0]
        self.p += 4
        return v

    def u64(self):
        v = struct.unpack_from(">Q", self.d, self.p)[0]
        self.p += 8
        return v

    def count(self):  # NON_NEG: 8 bytes in CDF-5
        return self.u64() if self.version == 5 else self.u32()

    def offset(self):  # OFFSET: 4 bytes in CDF-1
        return self.u32() if self.version == 1 else self.u64()

    def name(self):
        n = self.count()
        s = self.d[self.p:self.p + n].decode()
        self.p += (n + 3) & ~3
        return s

    def skip_atts(self):
        tag, n = self.u32(), self.count()
        if tag not in (0, NC_ATTRIBUTE):
            raise ValueError("bad attribute list")
        for _ in range(n):
            self.name()
            t, nv = self.u32(), self.count()
            self.p += (nv * TYPE_SIZE[t] + 3) & ~3


def parse(data):
    r = Reader(data)
    numrecs = r.count()
    tag, ndims = r.u32(), r.count()
    if tag not in (0, NC_DIMENSION):
        raise ValueError("bad dimension list")
    dims = []
    for _ in range(ndims):
        dims.append((r.name(), r.count()))
    r.skip_atts()
    tag, nvars = r.u32(), r.count()
    if tag not in (0, NC_VARIABLE):
        raise ValueError("bad variable list")
    vars_ = []
    for _ in range(nvars):
        name = r.name()
        nd = r.count()
        dimids = [r.count() for _ in range(nd)]
        r.skip_atts()
        t = r.u32()
        vsize = r.count() if r.version == 5 else r.u32()
        begin = r.offset()
        is_rec = nd > 0 and dims[dimids[0]][1] == 0
        n = 1
        for k, di in enumerate(dimids):
            if k == 0 and is_rec:
                continue
            n *= dims[di][1]
        vars_.append({"name": name, "rec": is_rec, "nbytes": n * TYPE_SIZE[t], "vsize": vsize, "begin": begin})
    recs = [v for v in vars_ if v["rec"]]
    # one record variable: no padding of its records (classic format specification)
    recsize = recs[0]["nbytes"] if len(recs) == 1 else sum(v["vsize"] for v in recs)
    return r.version, numrecs, recsize, vars_


def hashes(path):
    with open(path, "rb") as f:
        data = f.read()
    version, numrecs, recsize, vars_ = parse(data)
    out = {}
    for v in vars_:
        if v["rec"]:
            out[v["name"]] = [hashlib.sha256(data[v["begin"] + i * recsize:v["begin"] + i * recsize + v["nbytes"]])
                              .hexdigest() for i in range(numrecs)]
        else:
            out[v["name"]] = [hashlib.sha256(data[v["begin"]:v["begin"] + v["nbytes"]]).hexdigest()]
    return {"format": "CDF-%d" % version, "times": numrecs, "file_sha256": hashlib.sha256(data).hexdigest(),
            "file_bytes": len(data), "vars": out}


def check(expected, got):
    bad = []
    for name, hs in expected["vars"].items():
        g = got["vars"].get(name)
        if g is None:
            bad.append("%s: missing" % name)
            continue
        if len(g) != len(hs):
            bad.append("%s: %d times, expected %d" % (name, len(g), len(hs)))
            continue
        bad += ["%s time %d" % (name, i) for i, (a, b) in enumerate(zip(hs, g)) if a != b]
    bad += ["%s: not expected" % n for n in got["vars"] if n not in expected["vars"]]
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file")
    ap.add_argument("-o", "--output")
    ap.add_argument("--label", default="")
    ap.add_argument("--check", metavar="EXPECTED_JSON")
    a = ap.parse_args()
    got = hashes(a.file)
    if a.check:
        with open(a.check) as f:
            exp = json.load(f)
        bad = check(exp, got)
        n = sum(len(v) for v in exp["vars"].values())
        same_file = exp.get("file_sha256") == got["file_sha256"]
        print("%d variables, %d hashes: %s; file bytes %s" % (
            len(exp["vars"]), n, "all equal" if not bad else "%d differ" % len(bad),
            "identical" if same_file else "differ"))
        for b in bad[:50]:
            print("  " + b)
        return 1 if bad else 0
    if a.label:
        got = {"label": a.label, **got}
    text = json.dumps(got, indent=1, sort_keys=False) + "\n"
    if a.output:
        with open(a.output, "w") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
