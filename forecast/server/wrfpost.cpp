// SPDX-License-Identifier: GPL-3.0-or-later
// wrfpost: the map products of one forecast, from its wrfout files (one output time per file, frames_per_outfile 1).
//
//   wrfpost [--follow] [--threads N] OUT_DIR PRODUCTS_DIR
//
// OUT_DIR holds wrfout_d01_* (or d0N/wrfout_d0N_* for a nested run: each domain gets PRODUCTS_DIR/d0N). With
// --follow the files are processed as the model writes them (a file is complete once the next one exists, or once
// OUT_DIR/.done exists), in N threads (default 4), and meta.json is rewritten after every frame, so the page can
// show the frames that are ready.
//
// PRODUCTS_DIR (per domain):
//   meta.json       the regular latitude-longitude grid, the model grid and its projection, the times, which frames
//                   are ready, the fields of each file (name, level, unit, range) and the methods
//   static.f32      float32 [2][nlat][nlon]: terrain height (m), land mask (0 / 1); NaN outside the domain
//   native.f32      float32 [2][ny][nx]: XLAT, XLONG of the model grid (for exact values under the cursor)
//   f/NNN.f32       frame NNN on the latitude-longitude grid: the "fields" planes, float32 [nlat][nlon] each
//   n/NNN.f32       frame NNN on the model grid: the same surface planes, float32 [ny][nx] each
//   s/NNN.f32       frame NNN, the sounding levels on the latitude-longitude grid: t, td, u, v, z per level
// Methods: forecast/server/postcore.hpp.
#include <netcdf.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cstdio>
#include <cstring>
#include <deque>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

#include "postcore.hpp"

namespace fs = std::filesystem;
using post::kNaN;

namespace {

constexpr double kPi = 3.14159265358979323846, kRad = kPi / 180.0, kEarth = 6370000.0;
std::mutex g_nc;  // the NetCDF-C library is not thread-safe

void ck(int st, const std::string& what) {
  if (st != NC_NOERR) throw std::runtime_error(what + ": " + nc_strerror(st));
}

struct Nc {
  int id = -1;
  explicit Nc(const std::string& path) { std::lock_guard<std::mutex> lk(g_nc); ck(nc_open(path.c_str(), NC_NOWRITE, &id), path); }
  ~Nc() { std::lock_guard<std::mutex> lk(g_nc); if (id >= 0) nc_close(id); }
  size_t dim(const char* name) const {
    std::lock_guard<std::mutex> lk(g_nc);
    int d;
    size_t n;
    ck(nc_inq_dimid(id, name, &d), name);
    ck(nc_inq_dimlen(id, d, &n), name);
    return n;
  }
  bool has(const char* name) const { std::lock_guard<std::mutex> lk(g_nc); int v; return nc_inq_varid(id, name, &v) == NC_NOERR; }
  // a variable at time 0: (Time, [k,] j, i)
  std::vector<float> get(const char* name, size_t nz, size_t ny, size_t nx) const {
    std::lock_guard<std::mutex> lk(g_nc);
    int v, nd;
    ck(nc_inq_varid(id, name, &v), name);
    ck(nc_inq_varndims(id, v, &nd), name);
    std::vector<float> a(nz * ny * nx);
    size_t start[4] = {0, 0, 0, 0}, count[4] = {1, nz, ny, nx};
    if (nd == 3) { count[1] = ny; count[2] = nx; }
    ck(nc_get_vara_float(id, v, start, count, a.data()), name);
    return a;
  }
  std::vector<float> get2(const char* name, size_t ny, size_t nx) const { return get(name, 1, ny, nx); }
  float att(const char* name) const {
    std::lock_guard<std::mutex> lk(g_nc);
    float f;
    ck(nc_get_att_float(id, NC_GLOBAL, name, &f), name);
    return f;
  }
  int iatt(const char* name) const {
    std::lock_guard<std::mutex> lk(g_nc);
    int i;
    ck(nc_get_att_int(id, NC_GLOBAL, name, &i), name);
    return i;
  }
  std::string time() const {
    std::lock_guard<std::mutex> lk(g_nc);
    int v, d[2];
    ck(nc_inq_varid(id, "Times", &v), "Times");
    ck(nc_inq_vardimid(id, v, d), "Times");
    size_t len;
    ck(nc_inq_dimlen(id, d[1], &len), "DateStrLen");
    std::vector<char> c(len);
    size_t start[2] = {0, 0}, count[2] = {1, len};
    ck(nc_get_vara_text(id, v, start, count, c.data()), "Times");
    return std::string(c.data(), len);
  }
};

// WRF's map projections (module_llxy): Lambert conformal (1), polar stereographic (2), Mercator (3); x, y in metres
struct Proj {
  int kind = 1;
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
    if (kind == 2) {
      const double rm = kEarth * std::cos(lat * kRad) * (1.0 + hemi * std::sin(tl1 * kRad)) / (1.0 + hemi * std::sin(lat * kRad));
      x = rm * std::sin(dl * kRad);
      y = -hemi * rm * std::cos(dl * kRad);
      return;
    }
    const double rm = kEarth * std::cos(tl1 * kRad) / cone *
                      std::pow(std::tan((90.0 * hemi - lat) * kRad / 2.0) / std::tan((90.0 * hemi - tl1) * kRad / 2.0), cone);
    const double th = cone * dl * kRad;
    x = hemi * rm * std::sin(th);
    y = -rm * std::cos(th);
  }
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
  if (p.kind < 1 || p.kind > 3) throw std::runtime_error("MAP_PROJ " + std::to_string(p.kind) + " not supported");
  p.tl1 = nc.att("TRUELAT1");
  p.tl2 = nc.att("TRUELAT2");
  p.stdlon = nc.att("STAND_LON");
  p.dx = nc.att("DX");
  p.hemi = p.tl1 < 0 ? -1.0 : 1.0;
  if (std::fabs(p.tl1 - p.tl2) > 0.1)
    p.cone = (std::log(std::cos(p.tl1 * kRad)) - std::log(std::cos(p.tl2 * kRad))) /
             (std::log(std::tan((90.0 - std::fabs(p.tl1)) * kRad / 2.0)) - std::log(std::tan((90.0 - std::fabs(p.tl2)) * kRad / 2.0)));
  else
    p.cone = std::sin(std::fabs(p.tl1) * kRad);
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
      for (size_t j = 0; j < ny; j += std::max<size_t>(1, ny / 40))
        for (size_t i = 0; i < nx; i += std::max<size_t>(1, nx / 40)) {
          double fi, fj;
          q.ij(lat[j * nx + i], lon[j * nx + i], fi, fj);
          w = std::max({w, std::fabs(fi - double(i)), std::fabs(fj - double(j))});
        }
      if (w < worst) { worst = w; best = q; }
    }
  if (worst > 0.05) throw std::runtime_error("projection check failed: " + std::to_string(worst) + " grid lengths");
  std::fprintf(stderr, "wrfpost: MAP_PROJ %d matches XLAT/XLONG within %.4f grid lengths\n", p.kind, worst);
  return best;
}

std::string iso(const std::string& wrf) {  // 2026-11-08_18:00:00 -> 2026-11-08T18:00:00Z
  std::string s = wrf;
  if (s.size() > 10) s[10] = 'T';
  return s + "Z";
}

// ---- the fields
const std::vector<int> kLevels = {925, 850, 700, 500, 300, 250};
const std::vector<int> kSounding = {1000, 975, 950, 925, 900, 850, 800, 750, 700, 650, 600, 550, 500, 450, 400, 350, 300, 250, 200, 150, 100};
struct FieldDef { std::string name, unit; int level; };
std::vector<FieldDef> surface_fields(bool refl) {
  std::vector<FieldDef> f = {
      {"u10", "m/s", 0}, {"v10", "m/s", 0}, {"gust", "m/s", 0}, {"t2", "°C", 0}, {"td2", "°C", 0}, {"rh2", "%", 0},
      {"mslp", "hPa", 0}, {"psfc", "hPa", 0}, {"precip_rate", "mm/h", 0}, {"precip_acc", "mm", 0}, {"conv_acc", "mm", 0},
      {"grid_acc", "mm", 0}, {"rain_acc", "mm", 0}, {"snow_rate", "mm/h", 0}, {"snow_acc", "mm", 0}, {"graupel_acc", "mm", 0},
      {"cloud_low", "%", 0}, {"cloud_mid", "%", 0}, {"cloud_high", "%", 0}, {"cloud_total", "%", 0},
      {"cape_sb", "J/kg", 0}, {"cin_sb", "J/kg", 0}, {"cape_mu", "J/kg", 0}, {"cin_mu", "J/kg", 0}, {"li", "K", 0},
      {"shear06", "m/s", 0}, {"snowh", "cm", 0}, {"smois", "m³/m³", 0}, {"tsk", "°C", 0}, {"sst", "°C", 0},
      {"freezing_lvl", "m", 0}, {"pblh", "m", 0}};
  if (refl) f.push_back({"refl", "dBZ", 0});
  for (int l : kLevels)
    for (const char* v : {"u", "v", "t", "td", "rh", "z"})
      f.push_back({v, std::string(v) == "z" ? "m" : std::string(v) == "rh" ? "%" : (v[0] == 't' ? "°C" : "m/s"), l});
  return f;
}
size_t n_surface(const std::vector<FieldDef>& f) {
  size_t n = 0;
  while (n < f.size() && f[n].level == 0) ++n;
  return n;
}

struct Domain {
  fs::path in, out;
  std::string dom;  // d01, d02
  size_t nx = 0, ny = 0, nz = 0, nsoil = 0;
  std::vector<float> xlat, xlon;
  Proj pr;
  bool refl = false;
  std::vector<FieldDef> fields;
  // the latitude-longitude grid and, per cell, the model grid point and weights (i < 0: outside)
  size_t nlat = 0, nlon = 0;
  double lat0 = 0, lon0 = 0, dlat = 0, dlon = 0;
  std::vector<int> si, sj;
  std::vector<float> sa, sb;
  std::vector<std::string> times;  // per frame index
  std::set<int> ready;
  std::vector<float> lo, hi;
  std::mutex mu;
};

std::vector<float> resample(const Domain& d, const std::vector<float>& f) {
  std::vector<float> g(d.nlat * d.nlon, kNaN);
  for (size_t n = 0; n < g.size(); ++n) {
    const int i = d.si[n], j = d.sj[n];
    if (i < 0) continue;
    const float a = d.sa[n], b = d.sb[n];
    const size_t o = size_t(j) * d.nx + size_t(i);
    g[n] = (1 - b) * ((1 - a) * f[o] + a * f[o + 1]) + b * ((1 - a) * f[o + d.nx] + a * f[o + d.nx + 1]);
  }
  return g;
}

void put(std::ofstream& o, const std::vector<float>& g) { o.write(reinterpret_cast<const char*>(g.data()), std::streamsize(g.size() * 4)); }
void write_atomic(const fs::path& p, const std::string& s) {
  const fs::path tmp = p.string() + ".tmp";
  { std::ofstream(tmp, std::ios::binary) << s; }
  fs::rename(tmp, p);
}

double parse_time(const std::string& t) {
  std::tm u{};
  strptime(t.c_str(), "%Y-%m-%d_%H:%M:%S", &u);
  return double(timegm(&u));
}

void setup(Domain& d, const fs::path& first) {
  Nc nc(first.string());
  d.nx = nc.dim("west_east");
  d.ny = nc.dim("south_north");
  d.nz = nc.dim("bottom_top");
  d.nsoil = nc.has("SMOIS") ? nc.dim("soil_layers_stag") : 0;
  d.xlat = nc.get2("XLAT", d.ny, d.nx);
  d.xlon = nc.get2("XLONG", d.ny, d.nx);
  d.pr = make_proj(nc, d.xlat, d.xlon, d.ny, d.nx);
  d.refl = nc.has("REFL_10CM");
  d.fields = surface_fields(d.refl);
  d.lo.assign(d.fields.size(), std::numeric_limits<float>::max());
  d.hi.assign(d.fields.size(), std::numeric_limits<float>::lowest());
  double la0 = 90, la1 = -90, lo0 = 1e9, lo1 = -1e9;
  // longitudes continuous across 180 (a domain over the date line keeps lon > 180)
  const double ref = d.xlon[(d.ny / 2) * d.nx + d.nx / 2];
  for (size_t n = 0; n < d.nx * d.ny; ++n) {
    double lo = d.xlon[n];
    while (lo - ref > 180) lo -= 360;
    while (lo - ref < -180) lo += 360;
    la0 = std::min(la0, double(d.xlat[n])); la1 = std::max(la1, double(d.xlat[n]));
    lo0 = std::min(lo0, lo); lo1 = std::max(lo1, lo);
  }
  const double clat = std::cos(std::clamp(0.5 * (la0 + la1), -80.0, 80.0) * kRad);
  const double step = d.pr.dx / 111200.0;
  d.dlat = step;
  d.dlon = std::min(step / clat, 360.0 / 2000);
  d.lat0 = la0;
  d.lon0 = lo0;
  d.nlat = size_t(std::ceil((la1 - la0) / d.dlat)) + 1;
  d.nlon = size_t(std::ceil((lo1 - lo0) / d.dlon)) + 1;
  d.si.assign(d.nlat * d.nlon, -1);
  d.sj.assign(d.nlat * d.nlon, -1);
  d.sa.assign(d.nlat * d.nlon, 0);
  d.sb.assign(d.nlat * d.nlon, 0);
  for (size_t r = 0; r < d.nlat; ++r)
    for (size_t c = 0; c < d.nlon; ++c) {
      double fi, fj;
      d.pr.ij(d.lat0 + r * d.dlat, d.lon0 + c * d.dlon, fi, fj);
      if (fi < 0 || fj < 0 || fi > double(d.nx - 1) || fj > double(d.ny - 1)) continue;
      const int i = std::min(int(fi), int(d.nx) - 2), j = std::min(int(fj), int(d.ny) - 2);
      const size_t n = r * d.nlon + c;
      d.si[n] = i;
      d.sj[n] = j;
      d.sa[n] = float(fi - i);
      d.sb[n] = float(fj - j);
    }
  fs::create_directories(d.out / "f");
  fs::create_directories(d.out / "n");
  fs::create_directories(d.out / "s");
  std::ofstream st(d.out / "static.f32", std::ios::binary);
  put(st, resample(d, nc.get2("HGT", d.ny, d.nx)));
  put(st, resample(d, nc.get2("LANDMASK", d.ny, d.nx)));
  std::ofstream na(d.out / "native.f32", std::ios::binary);
  put(na, d.xlat);
  put(na, d.xlon);
}

// one output time: every product, on both grids
void frame(Domain& d, const fs::path& file, const fs::path* prev, int k) {
  Nc nc(file.string());
  const size_t nx = d.nx, ny = d.ny, nz = d.nz, n2 = nx * ny;
  const std::string t = nc.time();
  auto g2 = [&](const char* v) { return nc.get2(v, ny, nx); };
  auto g3 = [&](const char* v) { return nc.get(v, nz, ny, nx); };
  const auto P = g3("P"), PB = g3("PB"), T = g3("T"), QV = g3("QVAPOR");
  const auto PH = nc.get("PH", nz + 1, ny, nx), PHB = nc.get("PHB", nz + 1, ny, nx);
  const auto U = nc.get("U", nz, ny, nx + 1), V = nc.get("V", nz, ny + 1, nx);
  const auto hgt = g2("HGT"), psfc = g2("PSFC"), t2 = g2("T2"), q2 = g2("Q2"), u10g = g2("U10"), v10g = g2("V10");
  std::vector<float> ca(n2, 1.f), sa(n2, 0.f);
  if (nc.has("COSALPHA")) { ca = g2("COSALPHA"); sa = g2("SINALPHA"); }
  const std::vector<float> cld = nc.has("CLDFRA") ? g3("CLDFRA") : std::vector<float>();
  const std::vector<float> refl = d.refl ? g3("REFL_10CM") : std::vector<float>();
  auto opt2 = [&](const char* v) { return nc.has(v) ? g2(v) : std::vector<float>(n2, 0.f); };
  const auto pblh = opt2("PBLH"), snowh = opt2("SNOWH"), tsk = opt2("TSK"), land = opt2("LANDMASK");
  const std::vector<float> smois = d.nsoil ? nc.get("SMOIS", d.nsoil, ny, nx) : std::vector<float>(n2, kNaN);
  // accumulations now and at the previous output time
  const char* accs[] = {"RAINC", "RAINNC", "RAINSH", "SNOWNC", "GRAUPELNC", "HAILNC"};
  std::map<std::string, std::vector<float>> acc, acc0;
  for (const char* a : accs) acc[a] = opt2(a);
  double dt_h = 0;
  if (prev) {
    Nc pn(prev->string());
    for (const char* a : accs) acc0[a] = pn.has(a) ? pn.get2(a, ny, nx) : std::vector<float>(n2, 0.f);
    dt_h = (parse_time(t) - parse_time(pn.time())) / 3600.0;
  }

  std::vector<std::vector<float>> S(n_surface(d.fields), std::vector<float>(n2, kNaN));
  auto idx = [&](const char* name) {
    for (size_t i = 0; i < d.fields.size(); ++i) if (d.fields[i].name == name && d.fields[i].level == 0) return i;
    throw std::runtime_error(std::string("no field ") + name);
  };
  std::vector<std::vector<float>> L(kLevels.size() * 6, std::vector<float>(n2, kNaN));
  std::vector<std::vector<float>> SD(kSounding.size() * 5, std::vector<float>(n2, kNaN));
  const size_t iu = idx("u10"), iv = idx("v10"), ig = idx("gust"), it2 = idx("t2"), itd = idx("td2"), irh = idx("rh2"),
               isl = idx("mslp"), ips = idx("psfc"), ipr = idx("precip_rate"), ipa = idx("precip_acc"), ica = idx("conv_acc"),
               iga = idx("grid_acc"), ira = idx("rain_acc"), isr = idx("snow_rate"), isa = idx("snow_acc"), igr = idx("graupel_acc"),
               icl = idx("cloud_low"), icm = idx("cloud_mid"), ich = idx("cloud_high"), ict = idx("cloud_total"),
               icsb = idx("cape_sb"), icnsb = idx("cin_sb"), icmu = idx("cape_mu"), icnmu = idx("cin_mu"), ili = idx("li"),
               ish = idx("shear06"), isn = idx("snowh"), ism = idx("smois"), itk = idx("tsk"), iss = idx("sst"),
               ifz = idx("freezing_lvl"), ipb = idx("pblh");
  const size_t irf = d.refl ? idx("refl") : 0;

  std::vector<double> p(nz), tk(nz), q(nz), z(nz), u(nz), v(nz), phpa(nz);
  std::vector<float> pf(nz), col(nz);
  for (size_t j = 0; j < ny; ++j)
    for (size_t i = 0; i < nx; ++i) {
      const size_t n = j * nx + i;
      for (size_t kk = 0; kk < nz; ++kk) {
        const size_t o = kk * n2 + n;
        p[kk] = P[o] + PB[o];
        phpa[kk] = p[kk] / 100.0;
        pf[kk] = float(p[kk]);
        tk[kk] = (T[o] + 300.0) * std::pow(p[kk] / 1.0e5, post::kRd / post::kCp);
        q[kk] = std::max(0.0f, QV[o]);
        z[kk] = 0.5 * (PH[o] + PHB[o] + PH[o + n2] + PHB[o + n2]) / post::kG;
        // mass-point winds, turned to east and north
        const double ug = 0.5 * (U[kk * ny * (nx + 1) + j * (nx + 1) + i] + U[kk * ny * (nx + 1) + j * (nx + 1) + i + 1]);
        const double vg = 0.5 * (V[kk * (ny + 1) * nx + j * nx + i] + V[kk * (ny + 1) * nx + (j + 1) * nx + i]);
        u[kk] = ug * ca[n] - vg * sa[n];
        v[kk] = vg * ca[n] + ug * sa[n];
      }
      const double ps = psfc[n] / 100.0;
      const double u10 = u10g[n] * ca[n] - v10g[n] * sa[n], v10 = v10g[n] * ca[n] + u10g[n] * sa[n];
      S[iu][n] = float(u10);
      S[iv][n] = float(v10);
      S[it2][n] = t2[n] - 273.15f;
      S[itd][n] = float(post::dewpoint_k(q2[n], ps) - 273.15);
      S[irh][n] = float(post::rh_pct(t2[n], q2[n], ps));
      S[isl][n] = float(post::mslp(p.data(), tk.data(), q.data(), z.data(), int(nz)) / 100.0);
      S[ips][n] = float(ps);
      S[ipb][n] = pblh[n];
      // the wind at the PBL top (height above ground), for the gusts
      double spbl = std::hypot(u[0], v[0]);
      const double ztop = hgt[n] + pblh[n];
      for (size_t kk = 0; kk + 1 < nz; ++kk)
        if (z[kk] <= ztop && z[kk + 1] > ztop) {
          const double w = (ztop - z[kk]) / (z[kk + 1] - z[kk]);
          spbl = std::hypot(u[kk] + w * (u[kk + 1] - u[kk]), v[kk] + w * (v[kk + 1] - v[kk]));
          break;
        }
      S[ig][n] = float(post::gust(std::hypot(u10, v10), spbl, pblh[n]));
      // precipitation (mm): total, convective, grid-scale, and the solid parts of the grid-scale
      auto A = [&](const char* a) { return double(acc[a][n]); };
      auto A0 = [&](const char* a) { return prev ? double(acc0[a][n]) : 0.0; };
      const double tot = A("RAINC") + A("RAINNC") + A("RAINSH"), tot0 = A0("RAINC") + A0("RAINNC") + A0("RAINSH");
      const double snow = A("SNOWNC"), graup = A("GRAUPELNC") + A("HAILNC");
      S[ipa][n] = float(tot);
      S[ica][n] = float(A("RAINC") + A("RAINSH"));
      S[iga][n] = float(A("RAINNC"));
      S[ira][n] = float(std::max(0.0, A("RAINNC") - snow - graup) + A("RAINC") + A("RAINSH"));
      S[isa][n] = float(snow);
      S[igr][n] = float(graup);
      S[ipr][n] = dt_h > 0 ? float(std::max(0.0, (tot - tot0) / dt_h)) : 0.f;
      S[isr][n] = dt_h > 0 ? float(std::max(0.0, (snow - A0("SNOWNC")) / dt_h)) : 0.f;
      // clouds by pressure band
      double lowc = 0, midc = 0, highc = 0;
      for (size_t kk = 0; kk < nz; ++kk) {
        const double c = cld.empty() ? 0.0 : cld[kk * n2 + n];
        if (phpa[kk] > 680) lowc = std::max(lowc, c);
        else if (phpa[kk] > 440) midc = std::max(midc, c);
        else highc = std::max(highc, c);
      }
      S[icl][n] = float(100 * lowc);
      S[icm][n] = float(100 * midc);
      S[ich][n] = float(100 * highc);
      S[ict][n] = float(100 * (1 - (1 - lowc) * (1 - midc) * (1 - highc)));
      if (d.refl) {
        double m = -30;
        for (size_t kk = 0; kk < nz; ++kk) m = std::max(m, double(refl[kk * n2 + n]));
        S[irf][n] = float(m);
      }
      // CAPE / CIN: surface-based, most unstable (lowest 300 hPa)
      const post::Parcel sb = post::lift(ps, t2[n], q2[n], phpa.data(), tk.data(), q.data(), int(nz), 0);
      S[icsb][n] = float(sb.cape);
      S[icnsb][n] = float(sb.cin);
      S[ili][n] = float(post::interp_logp(pf.data(), [&] { for (size_t kk = 0; kk < nz; ++kk) col[kk] = float(tk[kk]); return col.data(); }(), int(nz), 50000.0) - sb.t500);
      size_t kmu = 0;
      double best = -1;
      for (size_t kk = 0; kk < nz && phpa[kk] > ps - 300; ++kk) {
        const double the = post::theta_e(tk[kk], q[kk], phpa[kk], post::t_lcl(tk[kk], q[kk], phpa[kk]));
        if (the > best) { best = the; kmu = kk; }
      }
      const post::Parcel mu = post::lift(phpa[kmu], tk[kmu], q[kmu], phpa.data(), tk.data(), q.data(), int(nz), int(kmu) + 1);
      S[icmu][n] = float(std::max(mu.cape, sb.cape));
      S[icnmu][n] = float(mu.cape >= sb.cape ? mu.cin : sb.cin);
      // 0-6 km shear (vector difference to the 10 m wind)
      const double z6 = hgt[n] + 6000.0;
      for (size_t kk = 0; kk + 1 < nz; ++kk)
        if (z[kk] <= z6 && z[kk + 1] > z6) {
          const double w = (z6 - z[kk]) / (z[kk + 1] - z[kk]);
          S[ish][n] = float(std::hypot(u[kk] + w * (u[kk + 1] - u[kk]) - u10, v[kk] + w * (v[kk + 1] - v[kk]) - v10));
          break;
        }
      S[isn][n] = snowh[n] * 100.f;
      S[ism][n] = d.nsoil ? smois[n] : kNaN;
      S[itk][n] = tsk[n] - 273.15f;
      S[iss][n] = land[n] < 0.5f ? tsk[n] - 273.15f : kNaN;
      // the freezing level: the lowest height (m above sea level) where T falls through 0 C going up
      S[ifz][n] = tk[0] <= 273.15 ? float(hgt[n]) : kNaN;
      for (size_t kk = 0; kk + 1 < nz && tk[0] > 273.15; ++kk)
        if (tk[kk] > 273.15 && tk[kk + 1] <= 273.15) {
          S[ifz][n] = float(z[kk] + (tk[kk] - 273.15) / (tk[kk] - tk[kk + 1]) * (z[kk + 1] - z[kk]));
          break;
        }
      // pressure levels: u, v, t, td, rh, z (linear in ln p; NaN below the ground)
      std::vector<float> fu(nz), fv(nz), ft(nz), fq(nz), fz(nz);
      for (size_t kk = 0; kk < nz; ++kk) { fu[kk] = float(u[kk]); fv[kk] = float(v[kk]); ft[kk] = float(tk[kk]); fq[kk] = float(q[kk]); fz[kk] = float(z[kk]); }
      auto level = [&](int hpa, float& ou, float& ov, float& ot, float& otd, float& orh, float& oz) {
        const double pt = hpa * 100.0;
        if (pt > psfc[n]) { ou = ov = ot = otd = orh = oz = kNaN; return; }
        ou = post::interp_logp(pf.data(), fu.data(), int(nz), pt);
        ov = post::interp_logp(pf.data(), fv.data(), int(nz), pt);
        const float tt = post::interp_logp(pf.data(), ft.data(), int(nz), pt);
        const float qq = post::interp_logp(pf.data(), fq.data(), int(nz), pt);
        ot = tt - 273.15f;
        const bool ok = !std::isnan(tt) && !std::isnan(qq);
        otd = ok ? float(post::dewpoint_k(qq, hpa) - 273.15) : kNaN;
        orh = ok ? float(post::rh_pct(tt, qq, hpa)) : kNaN;
        oz = post::interp_logp(pf.data(), fz.data(), int(nz), pt);
      };
      for (size_t l = 0; l < kLevels.size(); ++l) {
        float a, b, c, e, f, g;
        level(kLevels[l], a, b, c, e, f, g);
        L[l * 6 + 0][n] = a; L[l * 6 + 1][n] = b; L[l * 6 + 2][n] = c; L[l * 6 + 3][n] = e; L[l * 6 + 4][n] = f; L[l * 6 + 5][n] = g;
      }
      for (size_t l = 0; l < kSounding.size(); ++l) {
        float a, b, c, e, f, g;
        level(kSounding[l], a, b, c, e, f, g);
        SD[l * 5 + 0][n] = c; SD[l * 5 + 1][n] = e; SD[l * 5 + 2][n] = a; SD[l * 5 + 3][n] = b; SD[l * 5 + 4][n] = g;
      }
    }

  char name[16];
  std::snprintf(name, sizeof name, "%03d.f32", k);
  std::vector<std::vector<float>> all = S;
  all.insert(all.end(), L.begin(), L.end());
  std::vector<float> lo(all.size(), std::numeric_limits<float>::max()), hi(all.size(), std::numeric_limits<float>::lowest());
  {
    std::ofstream f(d.out / "f" / (std::string(name) + ".tmp"), std::ios::binary);
    for (size_t i = 0; i < all.size(); ++i) {
      const auto g = resample(d, all[i]);
      for (float x : g) if (!std::isnan(x)) { lo[i] = std::min(lo[i], x); hi[i] = std::max(hi[i], x); }
      put(f, g);
    }
  }
  {
    // point-major [ny][nx][planes]: one point's values are contiguous (one Range request)
    std::vector<float> pm(n2 * S.size());
    for (size_t n = 0; n < n2; ++n)
      for (size_t i = 0; i < S.size(); ++i) pm[n * S.size() + i] = S[i][n];
    std::ofstream f(d.out / "n" / (std::string(name) + ".tmp"), std::ios::binary);
    put(f, pm);
  }
  {
    // point-major [nlat][nlon][levels * 5] on the latitude-longitude grid
    std::vector<std::vector<float>> rs;
    for (const auto& s : SD) rs.push_back(resample(d, s));
    const size_t ng = d.nlat * d.nlon;
    std::vector<float> pm(ng * rs.size());
    for (size_t n = 0; n < ng; ++n)
      for (size_t i = 0; i < rs.size(); ++i) pm[n * rs.size() + i] = rs[i][n];
    std::ofstream f(d.out / "s" / (std::string(name) + ".tmp"), std::ios::binary);
    put(f, pm);
  }
  for (const char* sub : {"f", "n", "s"}) fs::rename(d.out / sub / (std::string(name) + ".tmp"), d.out / sub / name);
  std::lock_guard<std::mutex> lk(d.mu);
  if (d.times.size() <= size_t(k)) d.times.resize(k + 1);
  d.times[k] = iso(t);
  d.ready.insert(k);
  for (size_t i = 0; i < all.size(); ++i) { d.lo[i] = std::min(d.lo[i], lo[i]); d.hi[i] = std::max(d.hi[i], hi[i]); }
}

// ts.f32: the meteogram fields over all frames, point-major [nlat][nlon][field][frame]
const std::vector<std::string> kSeries = {"t2", "td2", "u10", "v10", "gust", "precip_rate", "precip_acc", "snow_rate",
                                          "mslp", "cloud_low", "cloud_mid", "cloud_high", "cloud_total", "rh2", "cape_sb"};
void write_series(Domain& d) {
  const size_t ng = d.nlat * d.nlon, nf = d.times.size(), plane = ng * 4;
  std::vector<size_t> idx;
  for (const auto& name : kSeries)
    for (size_t i = 0; i < d.fields.size(); ++i)
      if (d.fields[i].name == name && d.fields[i].level == 0) idx.push_back(i);
  std::vector<float> ts(ng * idx.size() * nf, kNaN);
  std::vector<float> buf(ng);
  for (size_t k = 0; k < nf; ++k) {
    char name[16];
    std::snprintf(name, sizeof name, "%03zu.f32", k);
    std::ifstream f(d.out / "f" / name, std::ios::binary);
    if (!f) continue;
    for (size_t q = 0; q < idx.size(); ++q) {
      f.seekg(std::streamoff(idx[q] * plane));
      f.read(reinterpret_cast<char*>(buf.data()), std::streamsize(plane));
      for (size_t n = 0; n < ng; ++n) ts[(n * idx.size() + q) * nf + k] = buf[n];
    }
  }
  std::ofstream o(d.out / "ts.f32.tmp", std::ios::binary);
  put(o, ts);
  o.close();
  fs::rename(d.out / "ts.f32.tmp", d.out / "ts.f32");
}

void jstr(std::string& o, const std::string& s) {
  o += '"';
  for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; }
  o += '"';
}

void write_meta(Domain& d, int total, bool done) {
  std::lock_guard<std::mutex> lk(d.mu);
  char b[512];
  std::string o = "{\"version\":2,\"domain\":";
  jstr(o, d.dom);
  std::snprintf(b, sizeof b, ",\"grid\":{\"nlat\":%zu,\"nlon\":%zu,\"lat0\":%.6f,\"lon0\":%.6f,\"dlat\":%.8f,\"dlon\":%.8f}", d.nlat,
                d.nlon, d.lat0, d.lon0, d.dlat, d.dlon);
  o += b;
  std::snprintf(b, sizeof b,
                ",\"model\":{\"nx\":%zu,\"ny\":%zu,\"nz\":%zu,\"dx\":%.1f,\"proj\":{\"kind\":%d,\"tl1\":%.6f,\"tl2\":%.6f,\"stdlon\":%.6f,"
                "\"cone\":%.10f,\"hemi\":%.0f,\"x0\":%.4f,\"y0\":%.4f,\"sx\":%.0f,\"sy\":%.0f,\"r\":%.1f}}",
                d.nx, d.ny, d.nz, d.pr.dx, d.pr.kind, d.pr.tl1, d.pr.tl2, d.pr.stdlon, d.pr.cone, d.pr.hemi, d.pr.x0, d.pr.y0,
                d.pr.sx, d.pr.sy, kEarth);
  o += b;
  o += ",\"times\":[";
  for (size_t i = 0; i < d.times.size(); ++i) { if (i) o += ','; jstr(o, d.times[i]); }
  o += "],\"ready\":[";
  bool first = true;
  for (int k : d.ready) { if (!first) o += ','; first = false; o += std::to_string(k); }
  std::snprintf(b, sizeof b, "],\"expected\":%d,\"done\":%s", total, done ? "true" : "false");
  o += b;
  o += ",\"fields\":[";
  for (size_t i = 0; i < d.fields.size(); ++i) {
    if (i) o += ',';
    o += "{\"name\":";
    jstr(o, d.fields[i].name);
    o += ",\"unit\":";
    jstr(o, d.fields[i].unit);
    const bool ok = d.lo[i] <= d.hi[i];
    std::snprintf(b, sizeof b, ",\"level\":%d,\"min\":%.4g,\"max\":%.4g,\"native\":%s}", d.fields[i].level, ok ? d.lo[i] : 0.0,
                  ok ? d.hi[i] : 0.0, d.fields[i].level == 0 ? "true" : "false");
    o += b;
  }
  o += "],\"levels\":[";
  for (size_t i = 0; i < kLevels.size(); ++i) { if (i) o += ','; o += std::to_string(kLevels[i]); }
  o += "],\"sounding\":{\"levels\":[";
  for (size_t i = 0; i < kSounding.size(); ++i) { if (i) o += ','; o += std::to_string(kSounding[i]); }
  o += "],\"vars\":[\"t\",\"td\",\"u\",\"v\",\"z\"]}";
  o += ",\"series\":[";
  for (size_t i = 0; i < kSeries.size(); ++i) { if (i) o += ','; jstr(o, kSeries[i]); }
  o += "],\"layout\":{\"f\":\"plane-major [field][nlat][nlon]\",\"n\":\"point-major [ny][nx][surface field]\","
       "\"s\":\"point-major [nlat][nlon][level][t,td,u,v,z]\",\"ts\":\"point-major [nlat][nlon][series field][frame], when done\"}";
  o += ",\"outline\":[";
  first = true;
  auto pt = [&](size_t i, size_t j) {
    std::snprintf(b, sizeof b, "%s[%.4f,%.4f]", first ? "" : ",", d.xlat[j * d.nx + i], d.xlon[j * d.nx + i]);
    first = false;
    o += b;
  };
  const size_t si = std::max<size_t>(1, d.nx / 50), sj = std::max<size_t>(1, d.ny / 50);
  for (size_t i = 0; i < d.nx - 1; i += si) pt(i, 0);
  for (size_t j = 0; j < d.ny - 1; j += sj) pt(d.nx - 1, j);
  for (size_t i = d.nx - 1; i > 0; i -= std::min(si, i)) pt(i, d.ny - 1);
  for (size_t j = d.ny - 1; j > 0; j -= std::min(sj, j)) pt(0, j);
  o += "],\"methods\":{\"levels\":\"linear in ln p (UPP)\",\"mslp\":\"wrf-python slp (NCL DCOMPUTESEAPRS)\","
       "\"cape\":\"pseudoadiabatic parcel, virtual temperature correction; SB: 2 m parcel, MU: max theta-e in the lowest 300 hPa\","
       "\"gust\":\"UPP CALGUST\",\"clouds\":\"max CLDFRA per band: low > 680 hPa, mid 680-440 hPa, high < 440 hPa; total random overlap\"}}";
  write_atomic(d.out / "meta.json", o);
}

std::vector<fs::path> wrfouts(const fs::path& dir, const std::string& dom) {
  std::vector<fs::path> f;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(dir, ec))
    if (e.path().filename().string().rfind("wrfout_" + dom + "_", 0) == 0) f.push_back(e.path());
  std::sort(f.begin(), f.end());
  return f;
}

}  // namespace

int main(int argc, char** argv) {
  bool follow = false;
  int threads = 4;
  std::vector<std::string> pos;
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--follow") follow = true;
    else if (a == "--threads" && i + 1 < argc) threads = std::max(1, std::atoi(argv[++i]));
    else pos.push_back(a);
  }
  if (pos.size() != 2) {
    std::fprintf(stderr, "usage: wrfpost [--follow] [--threads N] OUT_DIR PRODUCTS_DIR\n");
    return 2;
  }
  const fs::path in = pos[0], out = pos[1];
  // expected frames from the run's plan (for the page's progress), if there is one
  int expected = 0;
  {
    int run_s = 0, out_min = 0;
    std::ifstream pe(in.parent_path() / "plan.env");
    for (std::string line; std::getline(pe, line);) {
      if (line.rfind("RUN_SECONDS=", 0) == 0) run_s = std::atoi(line.c_str() + 13);
      if (line.rfind("OUTPUT_MIN=", 0) == 0) out_min = std::atoi(line.c_str() + 12);
    }
    expected = out_min > 0 ? run_s / (out_min * 60) + 1 : 0;
  }
  try {
    std::vector<std::unique_ptr<Domain>> doms;
    auto domain_of = [&](const std::string& dn) -> Domain& {
      for (auto& d : doms) if (d->dom == dn) return *d;
      auto d = std::make_unique<Domain>();
      d->dom = dn;
      d->in = fs::exists(in / dn) ? in / dn : in;
      d->out = dn == "d01" ? out : out / dn;
      doms.push_back(std::move(d));
      return *doms.back();
    };
    std::set<std::string> started;  // "d01/NNN"
    std::mutex qmu;
    std::condition_variable qcv;
    std::deque<std::function<void()>> q;
    std::atomic<int> active{0};
    std::atomic<bool> stop{false}, failed{false};
    std::vector<std::thread> pool;
    // the workers end and are joined however this block is left (an exception would otherwise terminate)
    struct Joiner {
      std::vector<std::thread>& pool; std::atomic<bool>& stop; std::mutex& mu; std::condition_variable& cv;
      ~Joiner() {
        { std::lock_guard<std::mutex> lk(mu); stop = true; }
        cv.notify_all();
        for (auto& t : pool) if (t.joinable()) t.join();
      }
    } joiner{pool, stop, qmu, qcv};
    for (int i = 0; i < threads; ++i)
      pool.emplace_back([&] {
        while (true) {
          std::function<void()> job;
          {
            std::unique_lock<std::mutex> lk(qmu);
            qcv.wait(lk, [&] { return stop || !q.empty(); });
            if (q.empty()) return;
            job = std::move(q.front());
            q.pop_front();
          }
          try { job(); } catch (const std::exception& e) { std::fprintf(stderr, "wrfpost: %s\n", e.what()); failed = true; }
          --active;
        }
      });
    while (true) {
      const bool done = !follow || fs::exists(in / ".done");
      for (const std::string dn : {"d01", "d02", "d03"}) {
        const fs::path dir = fs::exists(in / dn) ? in / dn : in;
        auto files = wrfouts(dir, dn);
        if (files.empty()) continue;
        // a file is complete when the next exists, or when the model has ended; none is read before that
        const size_t complete = done ? files.size() : files.size() - 1;
        if (complete == 0) continue;
        Domain& d = domain_of(dn);
        if (d.nx == 0) setup(d, files[0]);
        for (size_t k = 0; k < complete; ++k) {
          const std::string key = dn + "/" + std::to_string(k);
          if (started.count(key)) continue;
          started.insert(key);
          const fs::path f = files[k];
          const fs::path pr = k ? files[k - 1] : fs::path();
          ++active;
          std::lock_guard<std::mutex> lk(qmu);
          Domain* dp = &d;
          q.push_back([dp, f, pr, k, expected] {
            frame(*dp, f, pr.empty() ? nullptr : &pr, int(k));
            write_meta(*dp, expected, false);
          });
          qcv.notify_one();
        }
      }
      if (done) break;
      std::this_thread::sleep_for(std::chrono::milliseconds(500));
    }
    while (active > 0) std::this_thread::sleep_for(std::chrono::milliseconds(50));
    {
      std::lock_guard<std::mutex> lk(qmu);
      stop = true;
    }
    qcv.notify_all();
    for (auto& t : pool) t.join();
    if (doms.empty()) throw std::runtime_error("no wrfout files in " + in.string());
    for (auto& d : doms) {
      write_series(*d);
      write_meta(*d, int(d->times.size()), true);
      std::fprintf(stderr, "wrfpost: %s: %zu frames on a %zu x %zu latitude-longitude grid\n", d->dom.c_str(), d->ready.size(),
                   d->nlat, d->nlon);
    }
    return failed ? 1 : 0;
  } catch (const std::exception& e) {
    std::fprintf(stderr, "wrfpost: %s\n", e.what());
    return 1;
  }
}
