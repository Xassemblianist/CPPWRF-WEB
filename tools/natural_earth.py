#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
"""Natural Earth (public domain, naturalearthdata.com; GeoJSON of nvkelso/natural-earth-vector v5.1.2) for the
offline base map, converted to the compact files of forecast/web/data/ne/:

  <layer>.bin   little-endian: uint32 count of parts, uint32 offsets[count + 1] (in points), then float32 lon, lat
                pairs. Lines (coastlines, borders, rivers) are line strips; polygons (land, lakes) are rings, every
                ring of every polygon one part (the viewer fills them with the stencil buffer, even-odd).
  places.json   [[lon, lat, scalerank, name], ...] of the populated places with scalerank <= 7

  tools/natural_earth.py SRC_DIR OUT_DIR       (SRC_DIR: the downloaded .geojson files)
"""
import json
import os
import struct
import sys

LAYERS = {
    "coast10": ("ne_10m_coastline", "line"), "coast50": ("ne_50m_coastline", "line"), "coast110": ("ne_110m_coastline", "line"),
    "border10": ("ne_10m_admin_0_boundary_lines_land", "line"), "border50": ("ne_50m_admin_0_boundary_lines_land", "line"),
    "lakes10": ("ne_10m_lakes", "poly"), "lakes50": ("ne_50m_lakes", "poly"),
    "rivers10": ("ne_10m_rivers_lake_centerlines", "line"), "rivers50": ("ne_50m_rivers_lake_centerlines", "line"),
    "land10": ("ne_10m_land", "poly"), "land50": ("ne_50m_land", "poly"),
}


def parts(geom):
    t, c = geom["type"], geom["coordinates"]
    if t == "LineString":
        yield c
    elif t == "MultiLineString":
        yield from c
    elif t == "Polygon":
        yield from c
    elif t == "MultiPolygon":
        for poly in c:
            yield from poly


def convert(src, out, name, kind):
    with open(src) as f:
        gj = json.load(f)
    offs, pts = [0], []
    for feat in gj["features"]:
        if not feat.get("geometry"):
            continue
        for p in parts(feat["geometry"]):
            # drop repeated points; rounding to 1e-5 degrees (about 1 m) keeps float32 exact enough
            q = []
            for lon, lat in ((pt[0], pt[1]) for pt in p):
                if not q or (lon, lat) != q[-1]:
                    q.append((lon, lat))
            if len(q) < 2:
                continue
            pts.extend(q)
            offs.append(len(pts))
    with open(out, "wb") as f:
        f.write(struct.pack("<I", len(offs) - 1))
        f.write(struct.pack(f"<{len(offs)}I", *offs))
        f.write(struct.pack(f"<{2 * len(pts)}f", *[v for pt in pts for v in pt]))
    return len(offs) - 1, len(pts)


def main():
    src, out = sys.argv[1], sys.argv[2]
    os.makedirs(out, exist_ok=True)
    for name, (base, kind) in LAYERS.items():
        n, p = convert(os.path.join(src, base + ".geojson"), os.path.join(out, name + ".bin"), name, kind)
        print(f"{name}: {n} parts, {p} points, {os.path.getsize(os.path.join(out, name + '.bin'))} bytes")
    with open(os.path.join(src, "ne_10m_populated_places_simple.geojson")) as f:
        gj = json.load(f)
    places = []
    for feat in gj["features"]:
        pr = feat["properties"]
        rank = int(pr.get("scalerank", 10))
        if rank <= 7:
            lon, lat = feat["geometry"]["coordinates"][:2]
            places.append([round(lon, 3), round(lat, 3), rank, pr.get("name") or pr.get("nameascii")])
    places.sort(key=lambda x: x[2])
    with open(os.path.join(out, "places.json"), "w") as f:
        json.dump(places, f, ensure_ascii=False, separators=(",", ":"))
    print(f"places: {len(places)}")


if __name__ == "__main__":
    main()
