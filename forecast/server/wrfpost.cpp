// SPDX-License-Identifier: GPL-3.0-or-later
// wrfpost: the map products of one forecast. Reads the wrfout file(s) of OUT_DIR and writes into PRODUCTS_DIR:
//   meta.json      the grid (a regular latitude-longitude grid over the domain), the times, the fields and their ranges,
//                  the outline of the domain
//   static.bin     float32 [nlat][nlon]: terrain height (m), land mask (0/1); NaN outside the domain
//   frame_<k>.bin  float32 [nlat][nlon] per field, in the order of meta.json "fields": u10, v10 (m/s), t2 (deg C),
//                  rain (mm/h over the last output interval), rh2 (%), mslp (hPa), cloud (column maximum, %)
// The model grid (WRF's Lambert conformal or Mercator projection) is sampled bilinearly at each latitude-longitude
// point: the projection is computed from the file's attributes and checked against XLAT / XLONG.
//
//   wrfpost OUT_DIR PRODUCTS_DIR
#include <netcdf.h>

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <string>
#include <vector>

namespace fs = std::filesystem;

namespace {

constexpr double kPi = 3.14159265358979323846, kRad = kPi / 180.0, kEarth = 6370000.0;
const float kNaN = std::numeric_limits<float>::quiet_NaN();

void ck(int st, const std::string& what) {
  if (st != NC_NOERR) throw std::runtime_error(what + ": " + nc_strerror(st));
}

struct Nc {
  int id = -1;
  explicit Nc(const std::string& path) { ck(nc_open(path.c_str(), NC_NOWRITE, &id), path); }
  ~Nc() { if (id >= 0) nc_close(id); }
  size_t dim(const char* name) const {
    int d;
    size_t n;
    ck(nc_inq_dimid(id, name, &d), name);
    ck(nc_inq_dimlen(id, d, &n), name);
    return n;
  }
  bool has(const char* name) const { int v; return nc_inq_varid(id, name, &v) == NC_NOERR; }
  // a 2-D field (Time, south_north, west_east) at time t
  std::vector<float> get2(const char* name, size_t t, size_t ny, size_t nx) const {
    int v;
    ck(nc_inq_varid(id, name, &v), name);
    std::vector<float> a(ny * nx);
    size_t start[3] = {t, 0, 0}, count[3] = {1, ny, nx};
    ck(nc_get_vara_float(id, v, start, count, a.data()), name);
    return a;
  }
  // the column maximum of a 3-D field (Time, bottom_top, south_north, west_east) at time t
  std::vector<float> colmax(const char* name, size_t t, size_t nz, size_t ny, size_t nx) const {
    int v;
    ck(nc_inq_varid(id, name, &v), name);
    std::vector<float> a(nz * ny * nx), m(ny * nx, 0.f);
    size_t start[4] = {t, 0, 0, 0}, count[4] = {1, nz, ny, nx};
    ck(nc_get_vara_float(id, v, start, count, a.data()), name);
    for (size_t k = 0; k < nz; ++k)
      for (size_t n = 0; n < ny * nx; ++n) m[n] = std::max(m[n], a[k * ny * nx + n]);
    return m;
  }
  float att(const char* name) const {
    float f;
    ck(nc_get_att_float(id, NC_GLOBAL, name, &f), name);
    return f;
  }
  int iatt(const char* name) const {
    int i;
    ck(nc_get_att_int(id, NC_GLOBAL, name, &i), name);
    return i;
  }
  std::vector<std::string> times() const {
    const size_t nt = dim("Time"), len = dim("DateStrLen");
    int v;
    ck(nc_inq_varid(id, "Times", &v), "Times");
    std::vector<char> c(nt * len);
    ck(nc_get_var_text(id, v, c.data()), "Times");
    std::vector<std::string> r;
    for (size_t t = 0; t < nt; ++t) r.emplace_back(c.data() + t * len, len);
    return r;
  }
};

// WRF's map projections (WPS / WRF module_llxy: Lambert conformal and Mercator): projected x, y in metres
struct Proj {
  int kind = 1;  // 1 Lambert conformal, 3 Mercator
  double tl1 = 0, tl2 = 0, stdlon = 0, cone = 1, hemi = 1, x0 = 0, y0 = 0, dx = 1, sx = 1, sy = 1;
  void xy(double lat, double lon, double& x, double& y) const {
    double dl = lon - stdlon;
    if (dl > 180) dl -= 360;
    if (dl < -180) dl += 360;
    if (kind == 3) {
      const double r = kEarth * std::cos(tl1 * kRad);
      x = r * dl * kRad;
      y = r * std::log(std::tan((45.0 + lat / 2.0) * kRad));
      return;
    }
    const double rm = kEarth * std::cos(tl1 * kRad) / cone *
                      std::pow(std::tan((90.0 * hemi - lat) * kRad / 2.0) / std::tan((90.0 * hemi - tl1) * kRad / 2.0),
                               cone);
    const double th = cone * dl * kRad;
    x = hemi * rm * std::sin(th);
    y = -rm * std::cos(th);
  }
  // fractional grid indices (0-based, mass points); sx, sy: the directions of the grid's axes in x, y
  void ij(double lat, double lon, double& i, double& j) const {
    double x, y;
    xy(lat, lon, x, y);
    i = sx * (x - x0) / dx;
    j = sy * (y - y0) / dx;
  }
};

Proj make_proj(const Nc& nc, const std::vector<float>& lat, const std::vector<float>& lon, size_t ny, size_t nx) {
  Proj p;
  p.kind = nc.iatt("MAP_PROJ");
  if (p.kind != 1 && p.kind != 3) throw std::runtime_error("MAP_PROJ " + std::to_string(p.kind) + " not supported");
  p.tl1 = nc.att("TRUELAT1");
  p.tl2 = nc.att("TRUELAT2");
  p.stdlon = nc.att("STAND_LON");
  p.dx = nc.att("DX");
  p.hemi = p.tl1 < 0 ? -1.0 : 1.0;
  if (std::fabs(p.tl1 - p.tl2) > 0.1)
    p.cone = (std::log(std::cos(p.tl1 * kRad)) - std::log(std::cos(p.tl2 * kRad))) /
             (std::log(std::tan((90.0 - std::fabs(p.tl1)) * kRad / 2.0)) -
              std::log(std::tan((90.0 - std::fabs(p.tl2)) * kRad / 2.0)));
  else
    p.cone = std::sin(std::fabs(p.tl1) * kRad);
  // the origin from the grid's first point; the axis directions that match XLAT / XLONG (they depend on the
  // hemisphere)
  double x, y;
  p.xy(lat[0], lon[0], x, y);
  p.x0 = x;
  p.y0 = y;
  double worst = 1e30;
  Proj best = p;
  for (double sx : {1.0, -1.0})
    for (double sy : {1.0, -1.0}) {
      Proj q = p;
      q.sx = sx;
      q.sy = sy;
      double w = 0;
      for (size_t j = 0; j < ny; ++j)
        for (size_t i = 0; i < nx; ++i) {
          double fi, fj;
          q.ij(lat[j * nx + i], lon[j * nx + i], fi, fj);
          w = std::max({w, std::fabs(fi - double(i)), std::fabs(fj - double(j))});
        }
      if (w < worst) { worst = w; best = q; }
    }
  if (worst > 0.05) throw std::runtime_error("projection check failed: " + std::to_string(worst) + " grid lengths");
  p = best;
  std::fprintf(stderr, "wrfpost: MAP_PROJ %d, the projection matches XLAT/XLONG within %.4f grid lengths\n", p.kind,
               worst);
  return p;
}

std::string iso(const std::string& wrf) {  // 2026-11-08_18:00:00 -> 2026-11-08T18:00:00Z
  std::string s = wrf;
  if (s.size() > 10) s[10] = 'T';
  return s + "Z";
}

struct Field {
  const char* name;
  const char* unit;
  float lo = std::numeric_limits<float>::max(), hi = std::numeric_limits<float>::lowest();
};

}  // namespace

int main(int argc, char** argv) {
  if (argc != 3) {
    std::fprintf(stderr, "usage: wrfpost OUT_DIR PRODUCTS_DIR\n");
    return 2;
  }
  try {
    std::vector<fs::path> files;
    for (const auto& e : fs::directory_iterator(argv[1]))
      if (e.path().filename().string().rfind("wrfout_d01_", 0) == 0) files.push_back(e.path());
    std::sort(files.begin(), files.end());
    if (files.empty()) throw std::runtime_error(std::string("no wrfout_d01_* in ") + argv[1]);
    const fs::path out = argv[2];
    fs::create_directories(out);

    Nc first(files[0].string());
    const size_t nx = first.dim("west_east"), ny = first.dim("south_north"), nz = first.dim("bottom_top");
    const auto xlat = first.get2("XLAT", 0, ny, nx), xlon = first.get2("XLONG", 0, ny, nx);
    const Proj pr = make_proj(first, xlat, xlon, ny, nx);

    // the latitude-longitude grid: the domain's bounding box at about the model's resolution
    double la0 = 90, la1 = -90, lo0 = 360, lo1 = -360;
    for (size_t n = 0; n < nx * ny; ++n) {
      la0 = std::min(la0, double(xlat[n])); la1 = std::max(la1, double(xlat[n]));
      lo0 = std::min(lo0, double(xlon[n])); lo1 = std::max(lo1, double(xlon[n]));
    }
    const double clat = std::cos(0.5 * (la0 + la1) * kRad);
    const double dlat = pr.dx / 111200.0 / 1.5, dlon = dlat / std::max(0.2, clat);
    const size_t nlat = size_t(std::ceil((la1 - la0) / dlat)) + 1, nlon = size_t(std::ceil((lo1 - lo0) / dlon)) + 1;

    // sampling weights of every latitude-longitude point (or none outside the domain)
    struct W { int i, j; float a, b; bool in; };
    std::vector<W> w(nlat * nlon);
    for (size_t r = 0; r < nlat; ++r)
      for (size_t c = 0; c < nlon; ++c) {
        double fi, fj;
        pr.ij(la0 + r * dlat, lo0 + c * dlon, fi, fj);
        W& x = w[r * nlon + c];
        x.in = fi >= 0 && fj >= 0 && fi <= double(nx - 1) && fj <= double(ny - 1);
        x.i = std::min(int(fi), int(nx) - 2);
        x.j = std::min(int(fj), int(ny) - 2);
        x.a = float(fi - x.i);
        x.b = float(fj - x.j);
      }
    auto sample = [&](const std::vector<float>& f) {
      std::vector<float> g(nlat * nlon, kNaN);
      for (size_t n = 0; n < g.size(); ++n) {
        const W& x = w[n];
        if (!x.in) continue;
        const size_t p = size_t(x.j) * nx + x.i;
        g[n] = (1 - x.b) * ((1 - x.a) * f[p] + x.a * f[p + 1]) + x.b * ((1 - x.a) * f[p + nx] + x.a * f[p + nx + 1]);
      }
      return g;
    };
    auto put = [](std::ofstream& o, const std::vector<float>& g) {
      o.write(reinterpret_cast<const char*>(g.data()), std::streamsize(g.size() * sizeof(float)));
    };

    {  // static fields
      std::ofstream o(out / "static.bin", std::ios::binary);
      put(o, sample(first.get2("HGT", 0, ny, nx)));
      put(o, sample(first.get2("LANDMASK", 0, ny, nx)));
    }

    Field fields[] = {{"u10", "m/s"}, {"v10", "m/s"}, {"t2", "°C"}, {"rain", "mm/h"},
                      {"rh2", "%"}, {"mslp", "hPa"}, {"cloud", "%"}};
    std::vector<std::string> times;
    std::vector<float> acc_prev;
    double t_prev = 0;
    int k = 0;
    for (const auto& f : files) {
      Nc nc(f.string());
      const auto ts = nc.times();
      for (size_t t = 0; t < ts.size(); ++t, ++k) {
        times.push_back(iso(ts[t]));
        const auto ug = nc.get2("U10", t, ny, nx), vg = nc.get2("V10", t, ny, nx), t2 = nc.get2("T2", t, ny, nx);
        // U10, V10 are along the model grid; turn them to east and north (WRF's COSALPHA, SINALPHA)
        std::vector<float> u = ug, v = vg;
        if (nc.has("COSALPHA") && nc.has("SINALPHA")) {
          const auto ca = nc.get2("COSALPHA", t, ny, nx), sa = nc.get2("SINALPHA", t, ny, nx);
          for (size_t n = 0; n < u.size(); ++n) {
            u[n] = ug[n] * ca[n] - vg[n] * sa[n];
            v[n] = vg[n] * ca[n] + ug[n] * sa[n];
          }
        }
        const auto q2 = nc.get2("Q2", t, ny, nx), ps = nc.get2("PSFC", t, ny, nx), hgt = nc.get2("HGT", t, ny, nx);
        std::vector<float> acc = nc.get2("RAINNC", t, ny, nx);
        for (const char* r : {"RAINC", "RAINSH"})
          if (nc.has(r)) {
            const auto a = nc.get2(r, t, ny, nx);
            for (size_t n = 0; n < acc.size(); ++n) acc[n] += a[n];
          }
        // the time of this frame in hours from the first (for the rain rate)
        struct tm tmv = {};
        strptime(ts[t].c_str(), "%Y-%m-%d_%H:%M:%S", &tmv);
        const double th = double(timegm(&tmv)) / 3600.0;
        std::vector<float> rain(acc.size(), 0.f), tc(acc.size()), rh(acc.size()), slp(acc.size());
        if (!acc_prev.empty() && th > t_prev)
          for (size_t n = 0; n < acc.size(); ++n) rain[n] = std::max(0.f, float((acc[n] - acc_prev[n]) / (th - t_prev)));
        for (size_t n = 0; n < acc.size(); ++n) {
          tc[n] = t2[n] - 273.15f;
          const double p = ps[n] / 100.0, q = q2[n], e = q * p / (0.622 + q);
          const double es = 6.112 * std::exp(17.67 * tc[n] / (tc[n] + 243.5));
          rh[n] = float(std::clamp(100.0 * e / es, 0.0, 100.0));
          const double tv = (t2[n] + 0.0065 * hgt[n] / 2.0) * (1.0 + 0.61 * q);
          slp[n] = float(p * std::exp(9.80665 * hgt[n] / (287.05 * tv)));
        }
        std::vector<float> cl = nc.has("CLDFRA") ? nc.colmax("CLDFRA", t, nz, ny, nx) : std::vector<float>(acc.size(), 0.f);
        for (auto& c : cl) c *= 100.f;
        acc_prev = acc;
        t_prev = th;
        const std::vector<float>* src[] = {&u, &v, &tc, &rain, &rh, &slp, &cl};
        char name[32];
        std::snprintf(name, sizeof name, "frame_%03d.bin", k);
        std::ofstream o(out / name, std::ios::binary);
        for (int fi = 0; fi < 7; ++fi) {
          const auto g = sample(*src[fi]);
          for (float x : g)
            if (!std::isnan(x)) { fields[fi].lo = std::min(fields[fi].lo, x); fields[fi].hi = std::max(fields[fi].hi, x); }
          put(o, g);
        }
      }
    }

    // the outline of the domain (its edge points, every 4th), for the map
    std::string outline;
    auto pt = [&](size_t i, size_t j) {
      char b[64];
      std::snprintf(b, sizeof b, "%s[%.4f,%.4f]", outline.empty() ? "" : ",", xlat[j * nx + i], xlon[j * nx + i]);
      outline += b;
    };
    for (size_t i = 0; i < nx; i += 4) pt(i, 0);
    for (size_t j = 0; j < ny; j += 4) pt(nx - 1, j);
    for (size_t i = nx; i-- > 0;) if (i % 4 == 0 || i == nx - 1) pt(i, ny - 1);
    for (size_t j = ny; j-- > 0;) if (j % 4 == 0) pt(0, j);

    std::ofstream m(out / "meta.json");
    m << "{\"nlat\":" << nlat << ",\"nlon\":" << nlon << ",\"lat0\":" << la0 << ",\"lon0\":" << lo0
      << ",\"dlat\":" << dlat << ",\"dlon\":" << dlon << ",\"model\":{\"nx\":" << nx << ",\"ny\":" << ny
      << ",\"nz\":" << nz << ",\"dx\":" << pr.dx << ",\"map_proj\":" << pr.kind << "},\"times\":[";
    for (size_t t = 0; t < times.size(); ++t) m << (t ? "," : "") << '"' << times[t] << '"';
    m << "],\"fields\":[";
    for (int fi = 0; fi < 7; ++fi)
      m << (fi ? "," : "") << "{\"name\":\"" << fields[fi].name << "\",\"unit\":\"" << fields[fi].unit
        << "\",\"min\":" << fields[fi].lo << ",\"max\":" << fields[fi].hi << "}";
    m << "],\"outline\":[" << outline << "]}\n";
    std::fprintf(stderr, "wrfpost: %zu frames on a %zu x %zu latitude-longitude grid\n", times.size(), nlat, nlon);
    return 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "wrfpost: error: %s\n", e.what());
    return 1;
  }
}
