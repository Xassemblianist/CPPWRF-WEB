// SPDX-License-Identifier: GPL-3.0-or-later
// cppwrf-forecast: the local forecast server. Serves the map page (forecast/web) and a small JSON API on 127.0.0.1
// only, and runs one forecast at a time with forecast/pipeline.sh (GFS -> WPS -> cppwrf_real -> cppwrf -> wrfpost).
//
//   cppwrf-forecast [--port 8090]      (from the repository root, or with CPPWRF_WEB_ROOT set)
//
// API
//   GET  /api/info                 GPU, disk, limits, the latest GFS cycle
//   GET  /api/basemap              the world map at 5': uint8 water percent [2160][4320], then uint8 height / 25 m
//                                  [2160][4320] (south row first, x from 180 deg west)
//   GET  /api/runs                 the runs, newest first
//   POST /api/runs                 start a run: {lat, lon, dx_km, nx, ny, nz, hours, backend, suite}
//   POST /api/estimate             the same checks without starting
//   GET  /api/runs/<id>            one run: parameters, state, the end of its log
//   POST /api/runs/<id>/cancel     stop it
//   POST /api/runs/<id>/delete     remove its directory
//   GET  /api/runs/<id>/meta.json, static.bin, frame_NNN.bin, wrfout
//
// Limits (checked before every run): at most 150 x 150 x 45 points and 24 h; the GPU memory estimate below the free
// memory; at least 15 GB free on the disk and the repository below 8 GB after the run (old runs are deleted first).
#include <arpa/inet.h>
#include <netinet/in.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/wait.h>
#include <unistd.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <map>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

namespace fs = std::filesystem;

namespace {

// ---- limits and the measured costs (RTX 2060, CPPWRF FP32: 1.83 GB at 105 k cells, 3.32 GB at 480 k cells)
constexpr int kMaxXY = 150, kMaxZ = 45, kMinXY = 20, kMinZ = 25, kMaxHours = 24;
constexpr double kGpuFixedMiB = 1430, kGpuMiBPerCell = 0.0040, kGpuMargin = 1.10;
constexpr double kMinFreeGB = 15, kMaxRepoGB = 8;
constexpr double kOutBytesPerCellFrame = 45, kInBytesPerCell = 400;
constexpr int kKeepRuns = 6;

fs::path g_root;
std::mutex g_mu;
pid_t g_child = -1;
std::string g_child_id;

// ---- small helpers
std::string run_cmd(const std::string& cmd) {
  std::string out;
  if (FILE* p = popen(cmd.c_str(), "r")) {
    char buf[4096];
    size_t n;
    while ((n = fread(buf, 1, sizeof buf, p)) > 0) out.append(buf, n);
    pclose(p);
  }
  return out;
}
std::string trim(std::string s) {
  while (!s.empty() && (s.back() == '\n' || s.back() == '\r' || s.back() == ' ')) s.pop_back();
  return s;
}
std::string read_file(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(f), {});
}
std::string esc(const std::string& s) {
  std::string r;
  for (char c : s) {
    if (c == '"' || c == '\\') r += '\\', r += c;
    else if (c == '\n') r += "\\n";
    else if (static_cast<unsigned char>(c) < 0x20) r += ' ';
    else r += c;
  }
  return r;
}
std::string num(double v, int prec = 2) {
  char b[64];
  std::snprintf(b, sizeof b, "%.*f", prec, v);
  return b;
}
double disk_free_gb(const fs::path& p) {
  struct statvfs s;
  if (statvfs(p.c_str(), &s) != 0) return 0;
  return double(s.f_bavail) * s.f_frsize / 1e9;
}
double repo_gb() {
  return std::atof(run_cmd("du -sb '" + g_root.string() + "' 2>/dev/null | cut -f1").c_str()) / 1e9;
}
struct Gpu { bool ok = false; std::string name; double total = 0, free = 0; };
Gpu gpu() {
  Gpu g;
  const std::string s = run_cmd("nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null");
  const auto a = s.find(','), b = s.find(',', a + 1);
  if (a == std::string::npos || b == std::string::npos) return g;
  g.ok = true;
  g.name = trim(s.substr(0, a));
  g.total = std::atof(s.c_str() + a + 1);
  g.free = std::atof(s.c_str() + b + 1);
  return g;
}

// the flat JSON object of a request body: numbers and strings
std::map<std::string, std::string> parse_flat(const std::string& s) {
  std::map<std::string, std::string> m;
  size_t i = 0;
  auto skip = [&] { while (i < s.size() && std::strchr(" \t\r\n,{}:", s[i])) ++i; };
  auto str = [&] {
    std::string r;
    ++i;
    while (i < s.size() && s[i] != '"') { if (s[i] == '\\' && i + 1 < s.size()) ++i; r += s[i++]; }
    ++i;
    return r;
  };
  while (true) {
    skip();
    if (i >= s.size() || s[i] != '"') break;
    const std::string k = str();
    skip();
    if (i < s.size() && s[i] == '"') m[k] = str();
    else { size_t j = i; while (j < s.size() && !std::strchr(",}", s[j])) ++j; m[k] = trim(s.substr(i, j - i)); i = j; }
  }
  return m;
}

// ---- the world map from WPS's low-resolution geography (GMTED2010 5' height, MODIS 5' water fraction)
std::string build_basemap() {
  const fs::path cache = g_root / "build/forecast/basemap.bin";
  if (fs::exists(cache) && fs::file_size(cache) == 2u * 4320u * 2160u) return read_file(cache);
  const char* home = std::getenv("HOME");
  const fs::path geog = std::getenv("GEOG_DIR") ? fs::path(std::getenv("GEOG_DIR"))
                                                 : fs::path(home ? home : "") / "wrf_real/geog/WPS_GEOG_LOW_RES";
  const int NX = 4320, NY = 2160, T = 600, B = 3, W = T + 2 * B;
  std::vector<short> topo(size_t(NX) * NY, 0);
  std::vector<unsigned char> water(size_t(NX) * NY, 0);
  for (int ty = 0; ty < NY / T; ++ty)
    for (int tx = 0; tx < NX / T; ++tx) {
      char name[64];
      std::snprintf(name, sizeof name, "%05d-%05d.%05d-%05d", tx * T + 1, tx * T + T, ty * T + 1, ty * T + T);
      const std::string t = read_file(geog / "topo_gmted2010_5m" / name);
      const std::string l = read_file(geog / "modis_landuse_20class_5m_with_lakes" / name);
      if (t.size() != size_t(W) * W * 2 || l.size() != size_t(W) * W * 21) continue;
      for (int y = 0; y < T; ++y)
        for (int x = 0; x < T; ++x) {
          const size_t o = size_t(y + B) * W + (x + B);
          const auto* u = reinterpret_cast<const unsigned char*>(t.data()) + 2 * o;
          // topo: x from 0 deg east; landuse: x from 180 deg west (category 17 water, 21 lakes; percent)
          topo[size_t(ty * T + y) * NX + (tx * T + x)] = short((u[0] << 8) | u[1]);
          const int w = int(static_cast<unsigned char>(l[16 * size_t(W) * W + o])) +
                        int(static_cast<unsigned char>(l[20 * size_t(W) * W + o]));
          water[size_t(ty * T + y) * NX + (tx * T + x)] = static_cast<unsigned char>(std::min(100, w));
        }
    }
  // two planes at 5', x from 180 deg west, south row first: water percent, height / 25 m
  std::string out(2u * NX * NY, '\0');
  for (int y = 0; y < NY; ++y)
    for (int x = 0; x < NX; ++x) {
      const size_t o = size_t(y) * NX + x;
      out[o] = char(water[o]);
      out[size_t(NX) * NY + o] = char(std::clamp(int(topo[size_t(y) * NX + (x + NX / 2) % NX]) / 25, 0, 255));
    }
  fs::create_directories(cache.parent_path());
  std::ofstream(cache, std::ios::binary) << out;
  return out;
}

// ---- the latest GFS cycle whose forecast hours are all published (NOMADS), cached for 10 minutes
std::string latest_cycle() {
  static std::mutex mu;
  static std::string cached;
  static std::time_t when = 0;
  std::lock_guard<std::mutex> lk(mu);
  const std::time_t now = std::time(nullptr);
  if (!cached.empty() && now - when < 600) return cached;
  for (int back = 3; back <= 48; back += 6) {
    const std::time_t t = now - back * 3600;
    std::tm u{};
    gmtime_r(&t, &u);
    u.tm_hour -= u.tm_hour % 6;
    char ymd[16], hh[8];
    std::strftime(ymd, sizeof ymd, "%Y%m%d", &u);
    std::strftime(hh, sizeof hh, "%H", &u);
    const std::string url = std::string("https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs.") + ymd + "/" + hh +
                            "/atmos/gfs.t" + hh + "z.pgrb2.0p25.f027.idx";
    if (trim(run_cmd("curl -s -o /dev/null -w '%{http_code}' --max-time 15 '" + url + "'")) == "200") {
      cached = std::string(ymd) + hh;
      when = now;
      return cached;
    }
  }
  return "";
}

// ---- runs
struct Params {
  double lat = 0, lon = 0;
  int dx_km = 15, nx = 60, ny = 50, nz = 40, hours = 6;
  std::string backend = "gpu-fp32", suite = "CONUS", cycle;
};
struct Check {
  bool ok = true;
  std::string error, suggestion;
  double gpu_mib = 0, disk_gb = 0;
};

Check check(const Params& p, bool for_start) {
  Check c;
  auto bad = [&](const std::string& e, const std::string& s = "") { c.ok = false; c.error = e; c.suggestion = s; };
  if (!(std::fabs(p.lat) <= 80 && std::fabs(p.lon) <= 180)) bad("the centre must be within 80 degrees of the equator");
  else if (p.nx > kMaxXY || p.ny > kMaxXY || p.nz > kMaxZ)
    bad("the domain is above " + std::to_string(kMaxXY) + " x " + std::to_string(kMaxXY) + " x " + std::to_string(kMaxZ) + " points",
        "use at most 150 x 150 points and 45 levels; for a larger area take a coarser grid spacing");
  else if (p.nx < kMinXY || p.ny < kMinXY || p.nz < kMinZ) bad("the domain needs at least 20 x 20 points and 25 levels");
  else if (p.hours < 1 || p.hours > kMaxHours) bad("the forecast length must be 1 to 24 hours");
  else if (p.dx_km < 3 || p.dx_km > 30) bad("the grid spacing must be 3 to 30 km");
  else if (p.backend != "gpu-fp32" && p.backend != "cpu-fp64") bad("unknown backend " + p.backend);
  else if (p.suite != "CONUS" && p.suite != "tropical") bad("unknown physics suite " + p.suite);
  else {
    const double cells = double(p.nx) * p.ny * p.nz;
    const int frames = p.hours + 1;
    c.disk_gb = (cells * (kOutBytesPerCellFrame * frames + kInBytesPerCell) + 80e6) / 1e9;
    if (p.backend == "gpu-fp32") {
      c.gpu_mib = (kGpuFixedMiB + kGpuMiBPerCell * cells) * kGpuMargin;
      const Gpu g = gpu();
      if (!g.ok) bad("no NVIDIA GPU found (nvidia-smi)", "choose the CPU FP64 backend");
      else if (c.gpu_mib > g.free - 200) {
        const double cells_fit = ((g.free - 200) / kGpuMargin - kGpuFixedMiB) / kGpuMiBPerCell;
        const double f = std::sqrt(std::max(0.0, cells_fit) / cells);
        bad("the domain needs about " + num(c.gpu_mib / 1024, 1) + " GB of GPU memory; " + num(g.free / 1024, 1) +
                " GB are free",
            "try " + std::to_string(int(p.nx * f)) + " x " + std::to_string(int(p.ny * f)) + " points, or " +
                std::to_string(int(std::ceil(p.dx_km / f))) + " km spacing for the same area");
      }
    }
    if (c.ok && for_start) {
      if (disk_free_gb(g_root) - c.disk_gb < kMinFreeGB)
        bad("the run needs about " + num(c.disk_gb, 2) + " GB and would leave less than 15 GB free on the disk",
            "delete old runs, or choose fewer hours or a smaller domain");
      else if (repo_gb() + c.disk_gb > kMaxRepoGB)
        bad("the run would take ~/cppwrf-web above 8 GB", "delete old runs, or choose fewer hours or a smaller domain");
    }
  }
  return c;
}

fs::path runs_dir() { return g_root / "build/runs"; }

std::string run_state(const fs::path& d) {
  std::string s = trim(read_file(d / "state"));
  return s.empty() ? "queued" : s;
}

std::string params_json(const Params& p) {
  return "{\"lat\":" + num(p.lat, 3) + ",\"lon\":" + num(p.lon, 3) + ",\"dx_km\":" + std::to_string(p.dx_km) +
         ",\"nx\":" + std::to_string(p.nx) + ",\"ny\":" + std::to_string(p.ny) + ",\"nz\":" + std::to_string(p.nz) +
         ",\"hours\":" + std::to_string(p.hours) + ",\"backend\":\"" + esc(p.backend) + "\",\"suite\":\"" + esc(p.suite) +
         "\",\"cycle\":\"" + esc(p.cycle) + "\"}";
}

std::string run_json(const std::string& id, bool with_log) {
  const fs::path d = runs_dir() / id;
  std::string j = "{\"id\":\"" + esc(id) + "\",\"params\":" + (fs::exists(d / "params.json") ? trim(read_file(d / "params.json")) : "{}") +
                  ",\"state\":\"" + esc(run_state(d)) + "\",\"products\":" + (fs::exists(d / "products/meta.json") ? "true" : "false");
  if (with_log) {
    std::string log = read_file(d / "pipeline.log");
    if (log.size() > 4000) log = log.substr(log.size() - 4000);
    std::string tr = read_file(d / "run/translate.log");
    j += ",\"log\":\"" + esc(log) + "\"";
    if (run_state(d).rfind("failed model", 0) == 0 || run_state(d).find("translator") != std::string::npos)
      j += ",\"translator\":\"" + esc(tr.size() > 3000 ? tr.substr(tr.size() - 3000) : tr) + "\"";
  }
  return j + "}";
}

std::vector<std::string> list_runs() {
  std::vector<std::string> ids;
  if (fs::exists(runs_dir()))
    for (const auto& e : fs::directory_iterator(runs_dir()))
      if (e.is_directory() && fs::exists(e.path() / "params.json")) ids.push_back(e.path().filename().string());
  std::sort(ids.rbegin(), ids.rend());
  return ids;
}

bool busy() {
  std::lock_guard<std::mutex> lk(g_mu);
  return g_child > 0;
}

// delete the oldest finished runs: beyond kKeepRuns, and while the new run would not fit
void cleanup(double need_gb) {
  auto ids = list_runs();
  std::reverse(ids.begin(), ids.end());  // oldest first
  int finished = 0;
  for (const auto& id : ids) finished += run_state(runs_dir() / id).rfind("running", 0) != 0;
  for (const auto& id : ids) {
    if (id == g_child_id) continue;
    const bool over = finished >= kKeepRuns || disk_free_gb(g_root) - need_gb < kMinFreeGB || repo_gb() + need_gb > kMaxRepoGB;
    if (!over) break;
    std::error_code ec;
    fs::remove_all(runs_dir() / id, ec);
    --finished;
    std::fprintf(stderr, "cppwrf-forecast: deleted old run %s\n", id.c_str());
  }
}

void reaper() {
  while (true) {
    std::this_thread::sleep_for(std::chrono::milliseconds(500));
    std::lock_guard<std::mutex> lk(g_mu);
    if (g_child <= 0) continue;
    int st;
    if (waitpid(g_child, &st, WNOHANG) == g_child) {
      const fs::path d = runs_dir() / g_child_id;
      if (run_state(d).rfind("running", 0) == 0 || run_state(d) == "queued")
        std::ofstream(d / "state") << "failed stopped the pipeline ended (exit " << (WIFEXITED(st) ? WEXITSTATUS(st) : -1) << ")\n";
      g_child = -1;
      g_child_id.clear();
    }
  }
}

std::string start_run(const Params& p0, int& status) {
  Params p = p0;
  if (busy()) { status = 409; return "{\"error\":\"a forecast is already running; one at a time\"}"; }
  if (p.cycle.empty()) p.cycle = latest_cycle();
  if (p.cycle.empty()) { status = 503; return "{\"error\":\"no GFS cycle found on NOMADS (network?)\"}"; }
  Check c = check(p, false);
  if (c.ok) { cleanup(c.disk_gb); c = check(p, true); }
  if (!c.ok) { status = 422; return "{\"error\":\"" + esc(c.error) + "\",\"suggestion\":\"" + esc(c.suggestion) + "\"}"; }
  char id[32];
  const std::time_t now = std::time(nullptr);
  std::strftime(id, sizeof id, "%Y%m%d-%H%M%S", std::localtime(&now));
  const fs::path d = runs_dir() / id;
  fs::create_directories(d);
  std::ofstream(d / "params.json") << params_json(p) << "\n";
  std::ofstream(d / "state") << "running queued 0\n";
  const pid_t pid = fork();
  if (pid == 0) {
    setsid();
    const std::string log = (d / "pipeline.log").string();
    std::freopen(log.c_str(), "w", stdout);
    std::freopen(log.c_str(), "a", stderr);
    setenv("LAT", num(p.lat, 4).c_str(), 1);
    setenv("LON", num(p.lon, 4).c_str(), 1);
    setenv("DX_KM", std::to_string(p.dx_km).c_str(), 1);
    setenv("NX", std::to_string(p.nx).c_str(), 1);
    setenv("NY", std::to_string(p.ny).c_str(), 1);
    setenv("NZ", std::to_string(p.nz).c_str(), 1);
    setenv("HOURS", std::to_string(p.hours).c_str(), 1);
    setenv("CYCLE", p.cycle.c_str(), 1);
    setenv("BACKEND", p.backend.c_str(), 1);
    setenv("SUITE", p.suite.c_str(), 1);
    const std::string script = (g_root / "forecast/pipeline.sh").string();
    execl("/bin/bash", "bash", script.c_str(), d.c_str(), static_cast<char*>(nullptr));
    _exit(127);
  }
  {
    std::lock_guard<std::mutex> lk(g_mu);
    g_child = pid;
    g_child_id = id;
  }
  status = 202;
  return run_json(id, false);
}

// ---- HTTP
struct Req { std::string method, path, body; };

void send_all(int fd, const std::string& s) {
  size_t o = 0;
  while (o < s.size()) {
    const ssize_t n = ::send(fd, s.data() + o, s.size() - o, MSG_NOSIGNAL);
    if (n <= 0) return;
    o += size_t(n);
  }
}
void reply(int fd, int code, const std::string& type, const std::string& body, const std::string& extra = "") {
  const char* text = code == 200 ? "OK" : code == 202 ? "Accepted" : code == 404 ? "Not Found" : code == 409 ? "Conflict"
                   : code == 422 ? "Unprocessable Entity" : code == 503 ? "Service Unavailable" : "Bad Request";
  send_all(fd, "HTTP/1.1 " + std::to_string(code) + " " + text + "\r\nContent-Type: " + type +
                   "\r\nContent-Length: " + std::to_string(body.size()) +
                   "\r\nCache-Control: no-store\r\nConnection: close\r\n" + extra + "\r\n" + body);
}
const char* mime(const std::string& p) {
  if (p.ends_with(".html")) return "text/html; charset=utf-8";
  if (p.ends_with(".js")) return "text/javascript; charset=utf-8";
  if (p.ends_with(".css")) return "text/css; charset=utf-8";
  if (p.ends_with(".json")) return "application/json";
  if (p.ends_with(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
bool safe_id(const std::string& s) {
  return !s.empty() && s.size() < 40 && std::all_of(s.begin(), s.end(), [](char c) { return std::isalnum(c) || c == '-'; });
}

Params params_from(const std::map<std::string, std::string>& m) {
  Params p;
  auto d = [&](const char* k, double def) { auto i = m.find(k); return i == m.end() ? def : std::atof(i->second.c_str()); };
  auto s = [&](const char* k, const std::string& def) { auto i = m.find(k); return i == m.end() ? def : i->second; };
  p.lat = d("lat", 0); p.lon = d("lon", 0);
  p.dx_km = int(d("dx_km", 15)); p.nx = int(d("nx", 60)); p.ny = int(d("ny", 50)); p.nz = int(d("nz", 40));
  p.hours = int(d("hours", 6)); p.backend = s("backend", "gpu-fp32"); p.suite = s("suite", "CONUS");
  return p;
}

void handle(int fd) {
  std::string buf;
  char tmp[8192];
  size_t hdr_end = std::string::npos;
  while (hdr_end == std::string::npos && buf.size() < 65536) {
    const ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return;
    buf.append(tmp, size_t(n));
    hdr_end = buf.find("\r\n\r\n");
  }
  if (hdr_end == std::string::npos) return;
  Req q;
  std::istringstream hs(buf.substr(0, hdr_end));
  hs >> q.method >> q.path;
  size_t len = 0;
  for (std::string line; std::getline(hs, line);) {
    std::string l = line;
    std::transform(l.begin(), l.end(), l.begin(), ::tolower);
    if (l.rfind("content-length:", 0) == 0) len = size_t(std::atol(l.c_str() + 15));
  }
  q.body = buf.substr(hdr_end + 4);
  while (q.body.size() < len && q.body.size() < 65536) {
    const ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) break;
    q.body.append(tmp, size_t(n));
  }
  if (const auto qm = q.path.find('?'); qm != std::string::npos) q.path.resize(qm);
  const std::string json = "application/json";

  if (q.path == "/api/info") {
    const Gpu g = gpu();
    reply(fd, 200, json,
          "{\"gpu\":{\"ok\":" + std::string(g.ok ? "true" : "false") + ",\"name\":\"" + esc(g.name) +
              "\",\"total_mib\":" + num(g.total, 0) + ",\"free_mib\":" + num(g.free, 0) + "},\"disk_free_gb\":" +
              num(disk_free_gb(g_root), 1) + ",\"repo_gb\":" + num(repo_gb(), 2) + ",\"cycle\":\"" + esc(latest_cycle()) +
              "\",\"busy\":" + (busy() ? "true" : "false") +
              ",\"limits\":{\"max_xy\":150,\"max_z\":45,\"min_xy\":20,\"min_z\":25,\"max_hours\":24,\"min_free_gb\":15,\"max_repo_gb\":8}}");
  } else if (q.path == "/api/basemap") {
    reply(fd, 200, "application/octet-stream", build_basemap(), "Cache-Control: max-age=86400\r\n");
  } else if (q.path == "/api/runs" && q.method == "GET") {
    std::string j = "[";
    for (const auto& id : list_runs()) j += (j.size() > 1 ? "," : "") + run_json(id, false);
    reply(fd, 200, json, j + "]");
  } else if ((q.path == "/api/runs" || q.path == "/api/estimate") && q.method == "POST") {
    const Params p = params_from(parse_flat(q.body));
    if (q.path == "/api/estimate") {
      const Check c = check(p, true);
      reply(fd, 200, json, "{\"ok\":" + std::string(c.ok ? "true" : "false") + ",\"error\":\"" + esc(c.error) +
                               "\",\"suggestion\":\"" + esc(c.suggestion) + "\",\"gpu_gb\":" + num(c.gpu_mib / 1024, 2) +
                               ",\"disk_gb\":" + num(c.disk_gb, 2) + "}");
    } else {
      int status = 200;
      const std::string r = start_run(p, status);
      reply(fd, status, json, r);
    }
  } else if (q.path.rfind("/api/runs/", 0) == 0) {
    std::string rest = q.path.substr(10), id = rest, sub;
    if (const auto s = rest.find('/'); s != std::string::npos) { id = rest.substr(0, s); sub = rest.substr(s + 1); }
    const fs::path d = runs_dir() / id;
    if (!safe_id(id) || !fs::exists(d / "params.json")) { reply(fd, 404, json, "{\"error\":\"no such run\"}"); return; }
    if (sub.empty()) reply(fd, 200, json, run_json(id, true));
    else if (sub == "cancel" && q.method == "POST") {
      std::lock_guard<std::mutex> lk(g_mu);
      if (g_child > 0 && g_child_id == id) {
        kill(-g_child, SIGTERM);
        std::ofstream(d / "state") << "failed cancelled by the user\n";
      }
      reply(fd, 200, json, "{\"ok\":true}");
    } else if (sub == "delete" && q.method == "POST") {
      if (busy() && g_child_id == id) { reply(fd, 409, json, "{\"error\":\"the run is still going\"}"); return; }
      std::error_code ec;
      fs::remove_all(d, ec);
      reply(fd, 200, json, "{\"ok\":true}");
    } else if (sub == "wrfout") {
      for (const auto& e : fs::directory_iterator(d / "out"))
        if (e.path().filename().string().rfind("wrfout_d01_", 0) == 0) {
          std::string name = e.path().filename().string();
          std::replace(name.begin(), name.end(), ':', '_');
          reply(fd, 200, "application/x-netcdf", read_file(e.path()),
                "Content-Disposition: attachment; filename=\"" + name + "\"\r\n");
          return;
        }
      reply(fd, 404, json, "{\"error\":\"no wrfout\"}");
    } else if (sub == "meta.json" || sub == "static.bin" ||
               (sub.rfind("frame_", 0) == 0 && sub.ends_with(".bin") && sub.size() == 13 &&
                std::all_of(sub.begin() + 6, sub.begin() + 9, ::isdigit))) {
      const fs::path f = d / "products" / sub;
      if (fs::exists(f)) reply(fd, 200, mime(sub), read_file(f));
      else reply(fd, 404, json, "{\"error\":\"not yet\"}");
    } else reply(fd, 404, json, "{\"error\":\"unknown\"}");
  } else {
    // the page: forecast/web
    std::string p = q.path == "/" ? "/index.html" : q.path;
    if (p.find("..") != std::string::npos) { reply(fd, 400, "text/plain", "bad path"); return; }
    const fs::path f = g_root / "forecast/web" / p.substr(1);
    if (fs::is_regular_file(f)) reply(fd, 200, mime(p), read_file(f));
    else reply(fd, 404, "text/plain", "not found");
  }
}

}  // namespace

int main(int argc, char** argv) {
  int port = 8090;
  for (int a = 1; a + 1 < argc; ++a)
    if (std::string(argv[a]) == "--port") port = std::atoi(argv[a + 1]);
  g_root = std::getenv("CPPWRF_WEB_ROOT") ? fs::path(std::getenv("CPPWRF_WEB_ROOT")) : fs::current_path();
  if (!fs::exists(g_root / "forecast/pipeline.sh")) {
    std::fprintf(stderr, "cppwrf-forecast: run it from the cppwrf-web repository (or set CPPWRF_WEB_ROOT)\n");
    return 2;
  }
  fs::create_directories(runs_dir());
  // runs left "running" by an earlier server: their pipeline is gone
  for (const auto& id : list_runs())
    if (run_state(runs_dir() / id).rfind("running", 0) == 0)
      std::ofstream(runs_dir() / id / "state") << "failed stopped the server restarted\n";
  signal(SIGPIPE, SIG_IGN);
  std::thread(reaper).detach();
  std::thread([] { build_basemap(); }).detach();

  const int s = socket(AF_INET, SOCK_STREAM, 0);
  int one = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_port = htons(uint16_t(port));
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  // 127.0.0.1 only
  if (bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || listen(s, 32) != 0) {
    std::perror("cppwrf-forecast: bind 127.0.0.1");
    return 1;
  }
  std::fprintf(stderr, "cppwrf-forecast: http://127.0.0.1:%d/ (root %s)\n", port, g_root.c_str());
  while (true) {
    const int c = accept(s, nullptr, nullptr);
    if (c < 0) continue;
    std::thread([c] { handle(c); close(c); }).detach();
  }
}
