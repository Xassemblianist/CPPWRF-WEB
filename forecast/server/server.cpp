// SPDX-License-Identifier: GPL-3.0-or-later
// cppwrf-forecast: the local forecast server. Serves the site (forecast/web) and a JSON API on 127.0.0.1 only,
// keeps a queue of forecasts and runs one at a time with forecast/pipeline.sh
// (GFS -> WPS -> cppwrf_real -> cppwrf -> wrfpost).
//
//   cppwrf-forecast [--port 8090]      (from the repository root, or with CPPWRF_WEB_ROOT set)
//
// API (JSON), /api/v1:
//   GET    /system                    GPU (name, memory, compute capability), RAM, disk, the builds, CPPWRF commit
//   GET    /options                   presets and CPPWRF's supported options (from the submodule's translator)
//   GET    /cycles                    GFS cycles: the latest complete one and the earlier ones NOMADS keeps
//   GET    /basemap                   the world map (WPS geography): water percent and height / 25 m at 5'
//   POST   /estimate                  settings -> checks, time per stage, memory, disk, GFS size, warning level
//   POST   /runs                      start (queue) a run; refused when the estimate is red
//   GET    /runs, /runs/<id>          the run library, one run (run.json)
//   DELETE /runs/<id>                 delete a run (and its files)
//   POST   /runs/<id>/cancel          SIGTERM to the run's process group, SIGKILL after 10 s
//   POST   /runs/<id>/star            {"starred": true|false}: starred runs are never deleted automatically
//   GET    /runs/<id>/events          Server-Sent Events: stage, simulated time, step rate, remaining time, log tail
//   GET    /runs/<id>/logs/<stage>    one stage's log
//   GET    /runs/<id>/products/<file> the map products (wrfpost)
//   GET    /runs/<id>/out/[d0N/]<file> the wrfout files
//
// Security: requests are at most 64 KB; bodies are parsed as JSON and checked by forecast/prepare.py against the
// settings schema; programs are started with execvp and argument arrays (never a shell); every file path is built
// from a checked run id and a checked file name; only forecast/web and build/runs are served. Pages served from the
// GitHub Pages origin (CPPWRF_ALLOWED_ORIGINS) may call the API (CORS, Private Network Access); other origins may not
// change anything.
#include <arpa/inet.h>
#include <fcntl.h>
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
#include <condition_variable>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <filesystem>
#include <fstream>
#include <mutex>
#include <random>
#include <regex>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

#include "json.hpp"

namespace fs = std::filesystem;
using json::Value;

namespace {

constexpr double kMinFreeGB = 15;
constexpr size_t kMaxRequest = 64 * 1024;

fs::path g_root;
int g_port = 8090;
int g_keep_runs = 12;
std::vector<std::string> g_origins = {"https://xassemblianist.github.io"};  // CPPWRF_ALLOWED_ORIGINS
thread_local std::string t_cors;   // the CORS headers of the request being answered
thread_local std::string t_range;  // its Range header ("bytes=a-b"), for the product files
std::mutex g_mu;                 // the queue, the child and every run.json write
std::condition_variable g_cv;
std::deque<std::string> g_queue;
pid_t g_child = -1;              // the running pipeline (its process group id)
std::string g_child_id;

// ---- small helpers
std::string read_file(const fs::path& p) {
  std::ifstream f(p, std::ios::binary);
  return std::string(std::istreambuf_iterator<char>(f), {});
}
void write_atomic(const fs::path& p, const std::string& s) {
  const fs::path tmp = p.string() + ".tmp";
  { std::ofstream(tmp, std::ios::binary) << s; }
  std::error_code ec;
  fs::rename(tmp, p, ec);
}
std::string trim(std::string s) {
  while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.pop_back();
  size_t i = 0;
  while (i < s.size() && std::isspace(static_cast<unsigned char>(s[i]))) ++i;
  return s.substr(i);
}
std::string now_iso() {
  char b[32];
  const std::time_t t = std::time(nullptr);
  std::tm u{};
  gmtime_r(&t, &u);
  std::strftime(b, sizeof b, "%Y-%m-%dT%H:%M:%SZ", &u);
  return b;
}
fs::path runs_dir() { return g_root / "build/runs"; }

// a program with an argument array, its standard output captured (stderr to /dev/null), no shell
struct Proc { int status = -1; std::string out; };
Proc run_prog(const std::vector<std::string>& argv, const fs::path& cwd = {}, int timeout_s = 120) {
  Proc r;
  int fds[2];
  if (pipe(fds) != 0) return r;
  const pid_t pid = fork();
  if (pid == 0) {
    dup2(fds[1], 1);
    const int dn = open("/dev/null", O_WRONLY);
    if (dn >= 0) dup2(dn, 2);
    close(fds[0]);
    close(fds[1]);
    if (!cwd.empty() && chdir(cwd.c_str()) != 0) _exit(127);
    std::vector<char*> a;
    for (const auto& s : argv) a.push_back(const_cast<char*>(s.c_str()));
    a.push_back(nullptr);
    execvp(a[0], a.data());
    _exit(127);
  }
  close(fds[1]);
  if (pid < 0) { close(fds[0]); return r; }
  const auto t0 = std::chrono::steady_clock::now();
  char buf[8192];
  fcntl(fds[0], F_SETFL, O_NONBLOCK);
  while (true) {
    const ssize_t n = read(fds[0], buf, sizeof buf);
    if (n > 0) { r.out.append(buf, size_t(n)); continue; }
    if (n == 0) break;
    if (std::chrono::steady_clock::now() - t0 > std::chrono::seconds(timeout_s)) { kill(pid, SIGKILL); break; }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }
  close(fds[0]);
  int st = 0;
  waitpid(pid, &st, 0);
  r.status = WIFEXITED(st) ? WEXITSTATUS(st) : -1;
  return r;
}

double disk_free_gb() {
  struct statvfs s;
  if (statvfs(g_root.c_str(), &s) != 0) return 0;
  return double(s.f_bavail) * s.f_frsize / 1e9;
}
uint64_t dir_bytes(const fs::path& p) {
  uint64_t n = 0;
  std::error_code ec;
  for (auto it = fs::recursive_directory_iterator(p, fs::directory_options::skip_permission_denied, ec);
       it != fs::recursive_directory_iterator(); it.increment(ec))
    if (!ec && !it->is_symlink(ec) && it->is_regular_file(ec)) n += it->file_size(ec);
  return n;
}
double meminfo_mib(const char* key) {
  std::ifstream f("/proc/meminfo");
  for (std::string line; std::getline(f, line);)
    if (line.rfind(key, 0) == 0) return std::atof(line.c_str() + std::strlen(key)) / 1024.0;
  return 0;
}

std::string cppwrf_commit() {
  static const std::string c =
      trim(run_prog({"git", "-C", (g_root / "third_party/CPPWRF").string(), "rev-parse", "--short=7", "HEAD"}).out);
  return c;
}

Value system_info() {
  Value s = Value::object();
  const Proc g = run_prog({"nvidia-smi", "--query-gpu=name,memory.total,memory.free,compute_cap", "--format=csv,noheader,nounits"});
  Value gpu = Value::object();
  gpu["ok"] = false;
  if (g.status == 0) {
    std::vector<std::string> f;
    std::stringstream ss(g.out.substr(0, g.out.find('\n')));
    for (std::string x; std::getline(ss, x, ',');) f.push_back(trim(x));
    if (f.size() == 4) {
      gpu["ok"] = true;
      gpu["name"] = f[0];
      gpu["total_mib"] = std::atof(f[1].c_str());
      gpu["free_mib"] = std::atof(f[2].c_str());
      gpu["compute_cap"] = f[3];
    }
  }
  s["gpu"] = gpu;
  s["ram_total_mib"] = meminfo_mib("MemTotal:");
  s["ram_available_mib"] = meminfo_mib("MemAvailable:");
  s["cpus"] = int(std::thread::hardware_concurrency());
  s["disk_free_gb"] = disk_free_gb();
  s["disk_floor_gb"] = kMinFreeGB;
  s["runs_gb"] = double(dir_bytes(runs_dir())) / 1e9;
  Value builds = Value::object();
  for (const char* b : {"gpu-fp32", "gpu-fp64", "cpu-fp64"}) {
    const fs::path d = g_root / "build" / b;
    Value x = Value::object();
    x["present"] = fs::exists(d / "cppwrf");
    x["commit"] = trim(read_file(d / ".commit"));
    builds[b] = x;
  }
  builds["cppwrf_real"] = fs::exists(g_root / "build/cpu-fp64/src/init_real/cppwrf_real");
  s["builds"] = builds;
  s["cppwrf_commit"] = cppwrf_commit();
  {
    std::lock_guard<std::mutex> lk(g_mu);
    s["busy"] = g_child > 0;
    s["queued"] = int(g_queue.size());
  }
  return s;
}
// the numbers prepare.py needs to judge a run
std::string system_for_prepare(const Value& s) {
  Value p = Value::object();
  p["gpu_ok"] = s["gpu"]["ok"];
  p["gpu_free_mib"] = s["gpu"]["free_mib"].num();
  p["gpu_total_mib"] = s["gpu"]["total_mib"].num();
  p["ram_available_mib"] = s["ram_available_mib"].num();
  p["disk_free_gb"] = s["disk_free_gb"].num();
  return json::dump(p);
}

// ---- GFS cycles: the newest whose last forecast hour (f384) is on NOMADS, and the earlier ones NOMADS keeps
Value cycles() {
  static std::mutex mu;
  static Value cached;
  static std::time_t when = 0;
  std::lock_guard<std::mutex> lk(mu);
  const std::time_t now = std::time(nullptr);
  if (!cached.is_null() && !cached["latest"].str().empty() && now - when < 600) return cached;
  auto name = [](std::time_t t) {
    std::tm u{};
    gmtime_r(&t, &u);
    u.tm_hour -= u.tm_hour % 6;
    char b[16];
    std::strftime(b, sizeof b, "%Y%m%d%H", &u);
    return std::string(b);
  };
  std::string latest;
  for (int back = 3; back <= 36 && latest.empty(); back += 6) {
    const std::string c = name(now - back * 3600);
    const std::string url = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod/gfs." + c.substr(0, 8) + "/" +
                            c.substr(8) + "/atmos/gfs.t" + c.substr(8) + "z.pgrb2.0p25.f384.idx";
    const Proc p = run_prog({"curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", url}, {}, 20);
    if (trim(p.out) == "200") latest = c;
  }
  Value v = Value::object();
  v["latest"] = latest;
  Value list = Value::array();
  if (!latest.empty()) {
    std::tm u{};
    strptime(latest.c_str(), "%Y%m%d%H", &u);
    const std::time_t t0 = timegm(&u);
    for (int k = 0; k < 4 * 8; ++k) list.push(name(t0 - k * 6 * 3600));  // NOMADS keeps about ten days
  }
  v["cycles"] = list;
  cached = v;
  when = now;
  return v;
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

// ---- runs
bool safe_id(const std::string& s) {
  static const std::regex re("^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$");
  return std::regex_match(s, re);
}
bool safe_name(const std::string& s) {
  static const std::regex re("^[A-Za-z0-9_.:+-]{1,96}$");
  return std::regex_match(s, re) && s.find("..") == std::string::npos;
}
fs::path run_path(const std::string& id) { return runs_dir() / id; }

Value load_run(const std::string& id) {
  try { return json::parse(read_file(run_path(id) / "run.json")); } catch (...) { return Value(); }
}
void save_run(const std::string& id, const Value& r) {
  if (fs::exists(run_path(id))) write_atomic(run_path(id) / "run.json", json::dump(r));
}

bool terminal(const std::string& s) { return s == "done" || s == "failed" || s == "cancelled"; }

// the pipeline's state file: "<stage> <pct>", "done" or "failed <stage> <message>"
void merge_state(const std::string& id, Value& r) {
  const fs::path d = run_path(id);
  const std::string st = trim(read_file(d / "state"));
  if (!st.empty() && !terminal(r["status"].str())) {
    std::istringstream ss(st);
    std::string a, b;
    ss >> a >> b;
    if (a == "done") {
      r["status"] = "done";
      r["stage"] = "done";
      r["pct"] = 100;
    } else if (a == "failed") {
      r["status"] = "failed";
      r["stage"] = b;
      std::string msg;
      std::getline(ss, msg);
      r["message"] = trim(msg);
    } else {
      r["status"] = "running";
      r["stage"] = a;
      r["pct"] = std::atof(b.c_str());
    }
  }
  // the actual seconds per stage
  Value times = Value::object();
  std::ifstream tf(d / "times");
  for (std::string k; tf >> k;) { double s = 0; tf >> s; times[k] = s; }
  if (!times.o.empty()) r["actual"]["stages_s"] = times;
}

std::string new_id() {
  std::time_t t = std::time(nullptr);
  std::tm u{};
  gmtime_r(&t, &u);
  char b[32];
  std::strftime(b, sizeof b, "%Y%m%d-%H%M%S", &u);
  static std::mt19937 rng(std::random_device{}());
  char h[8];
  std::snprintf(h, sizeof h, "%04x", unsigned(rng() & 0xffff));
  return std::string(b) + "-" + h;
}

std::vector<std::string> list_runs() {  // newest first
  std::vector<std::string> ids;
  std::error_code ec;
  for (const auto& e : fs::directory_iterator(runs_dir(), ec))
    if (e.is_directory() && safe_id(e.path().filename().string()) && fs::exists(e.path() / "run.json"))
      ids.push_back(e.path().filename().string());
  std::sort(ids.rbegin(), ids.rend());
  return ids;
}

// delete the oldest finished, unstarred runs beyond g_keep_runs, and while the disk is below the floor + need
void cleanup(double need_gb) {
  auto ids = list_runs();
  std::reverse(ids.begin(), ids.end());  // oldest first
  int finished = 0;
  for (const auto& id : ids) if (terminal(load_run(id)["status"].str())) ++finished;
  for (const auto& id : ids) {
    const Value r = load_run(id);
    if (!terminal(r["status"].str()) || r["starred"].boolean()) continue;
    if (finished <= g_keep_runs && disk_free_gb() - need_gb >= kMinFreeGB) break;
    std::error_code ec;
    fs::remove_all(run_path(id), ec);
    --finished;
    std::fprintf(stderr, "cppwrf-forecast: deleted old run %s\n", id.c_str());
  }
}

// the big partial files of a run that did not finish (GFS, WPS, inputs, wrfout, products); logs and run.json stay
void remove_partial(const std::string& id) {
  const fs::path d = run_path(id);
  std::error_code ec;
  for (const char* sub : {"gfs", "wps", "run", "out", "products", "check"}) fs::remove_all(d / sub, ec);
}

// the GPU memory the model reported (CPPWRF_MEMINFO=1) and its step time
void model_numbers(const std::string& id, Value& r) {
  const std::string log = read_file(run_path(id) / "logs/model.log");
  std::smatch m;
  static const std::regex used("([0-9.]+) MiB used"), ns("([0-9.]+) ns/cell/step"), step("stepping ([0-9.]+) s");
  double peak = 0;
  for (auto it = std::sregex_iterator(log.begin(), log.end(), used); it != std::sregex_iterator(); ++it)
    peak = std::max(peak, std::atof((*it)[1].str().c_str()));
  if (peak > 0) r["actual"]["gpu_mib"] = peak;
  if (std::regex_search(log, m, ns)) r["actual"]["ns_per_cell_step"] = std::atof(m[1].str().c_str());
  if (std::regex_search(log, m, step)) r["actual"]["stepping_s"] = std::atof(m[1].str().c_str());
}

void finish_run(const std::string& id, int status) {
  Value r = load_run(id);
  if (r.is_null()) return;  // deleted while it ran
  merge_state(id, r);
  if (!terminal(r["status"].str())) {
    r["status"] = "failed";
    r["message"] = "İşlem hattı beklenmedik biçimde bitti (çıkış " + std::to_string(status) + ").";
  }
  r["ended"] = now_iso();
  model_numbers(id, r);
  double total = 0;
  for (const auto& [k, v] : r["actual"]["stages_s"].o) total += v.num();
  if (total > 0) r["actual"]["total_s"] = total;
  if (r["status"].str() != "done" && !r["settings"]["keep_partial"].boolean()) remove_partial(id);
  if (r["status"].str() == "done") {
    std::error_code ec;
    fs::remove_all(run_path(id) / "check", ec);
  }
  r["disk_bytes"] = double(dir_bytes(run_path(id)));
  r.o.erase("pgid");
  save_run(id, r);
  // refine the calibration with this run's numbers
  if (r["status"].str() == "done" && fs::exists(g_root / "tools/calibrate.py"))
    run_prog({"python3", "-I", (g_root / "tools/calibrate.py").string(), "add", run_path(id).string()}, g_root, 60);
}

void launch(const std::string& id) {
  const fs::path d = run_path(id);
  fs::create_directories(d / "logs");
  const pid_t pid = fork();
  if (pid == 0) {
    setpgid(0, 0);
    const std::string log = (d / "logs/pipeline.log").string();
    const int fd = open(log.c_str(), O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd >= 0) { dup2(fd, 1); dup2(fd, 2); }
    const std::string script = (g_root / "forecast/pipeline.sh").string(), dir = d.string();
    char* argv[] = {const_cast<char*>("bash"), const_cast<char*>(script.c_str()), const_cast<char*>(dir.c_str()), nullptr};
    execvp("bash", argv);
    _exit(127);
  }
  if (pid > 0) setpgid(pid, pid);
  g_child = pid;
  g_child_id = id;
  Value r = load_run(id);
  r["status"] = "running";
  r["stage"] = "download";
  r["started"] = now_iso();
  r["pgid"] = int(pid);
  save_run(id, r);
}

// the queue: start the next run when none runs; reap the running one
void worker() {
  while (true) {
    std::unique_lock<std::mutex> lk(g_mu);
    g_cv.wait_for(lk, std::chrono::milliseconds(500));
    if (g_child > 0) {
      int st = 0;
      if (waitpid(g_child, &st, WNOHANG) == g_child) {
        const std::string id = g_child_id;
        g_child = -1;
        g_child_id.clear();
        finish_run(id, WIFEXITED(st) ? WEXITSTATUS(st) : -1);
      }
    }
    if (g_child <= 0 && !g_queue.empty()) {
      const std::string id = g_queue.front();
      g_queue.pop_front();
      if (load_run(id)["status"].str() == "queued") {
        cleanup(load_run(id)["estimate"]["disk_peak_bytes"].num() / 1e9);
        if (disk_free_gb() < kMinFreeGB + 0.5) {
          Value r = load_run(id);
          r["status"] = "failed";
          r["message"] = "Diskte 15 GB'tan az boş yer var; çalışma başlatılmadı.";
          save_run(id, r);
          remove_partial(id);
        } else {
          launch(id);
        }
      }
    }
  }
}

// SIGTERM to the process group, SIGKILL after 10 s (the lock is not held while waiting)
void stop_group(pid_t pgid) {
  if (pgid <= 0) return;
  kill(-pgid, SIGTERM);
  for (int k = 0; k < 100; ++k) {
    if (kill(-pgid, 0) != 0) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(100));
  }
  kill(-pgid, SIGKILL);
}

// a run's pipeline still alive after a server restart (its process group, running pipeline.sh)
bool pipeline_alive(pid_t pgid, const std::string& id) {
  if (pgid <= 0 || kill(-pgid, 0) != 0) return false;
  const std::string cmd = read_file("/proc/" + std::to_string(pgid) + "/cmdline");
  return cmd.find("pipeline.sh") != std::string::npos && cmd.find(id) != std::string::npos;
}

void recover() {
  for (const auto& id : list_runs()) {
    Value r = load_run(id);
    const std::string s = r["status"].str();
    if (s == "queued") { g_queue.push_back(id); continue; }
    if (terminal(s)) continue;
    const pid_t pg = pid_t(r["pgid"].num(-1));
    if (pipeline_alive(pg, id)) stop_group(pg);
    merge_state(id, r);
    if (!terminal(r["status"].str())) {
      r["status"] = "failed";
      r["message"] = "Sunucu bu çalışma sürerken yeniden başladı; çalışma durduruldu.";
    }
    r["ended"] = now_iso();
    r.o.erase("pgid");
    save_run(id, r);
    if (r["status"].str() != "done" && !r["settings"]["keep_partial"].boolean()) remove_partial(id);
    std::fprintf(stderr, "cppwrf-forecast: run %s was left %s: %s\n", id.c_str(), s.c_str(), r["status"].str().c_str());
  }
  std::sort(g_queue.begin(), g_queue.end());
}

// ---- requests
Value error_value(const std::string& msg) {
  Value r = Value::object();
  r["ok"] = false;
  r["level"] = "red";
  Value er = Value::object();
  er["field"] = "";
  er["message"] = msg;
  r["errors"].push(er);
  return r;
}

Value check_settings(const std::string& body, const Value& sys, const fs::path& run = {}) {
  Value settings;
  try { settings = json::parse(body); } catch (const std::exception& e) { return error_value(std::string("Geçersiz JSON: ") + e.what()); }
  if (!settings.is_object()) return error_value("Ayarlar bir JSON nesnesi olmalı.");
  // "latest": the newest complete GFS cycle
  if (settings["time"]["cycle"].str("latest") == "latest") {
    const std::string c = cycles()["latest"].str();
    if (c.empty()) return error_value("Tamamlanmış bir GFS çevrimi bulunamadı (ağ bağlantısı?).");
    settings["time"]["cycle"] = c;
  }
  fs::create_directories(g_root / "build/tmp");
  static std::atomic<unsigned> counter{0};
  const std::string tag = std::to_string(::getpid()) + "-" + std::to_string(counter++);
  const fs::path sf = g_root / "build/tmp" / ("settings-" + tag + ".json"), yf = g_root / "build/tmp" / ("system-" + tag + ".json");
  write_atomic(sf, json::dump(settings));
  write_atomic(yf, system_for_prepare(sys));
  std::vector<std::string> argv = {"python3", "-I", (g_root / "forecast/prepare.py").string(), run.empty() ? "check" : "setup",
                                   sf.string(), yf.string()};
  if (!run.empty()) argv.push_back(run.string());
  const Proc p = run_prog(argv, g_root, 120);
  std::error_code ec;
  fs::remove(sf, ec);
  fs::remove(yf, ec);
  try { return json::parse(p.out); } catch (...) { return error_value("Ayarlar denetlenemedi (prepare.py)."); }
}

void send_all(int fd, const std::string& s) {
  size_t o = 0;
  while (o < s.size()) {
    const ssize_t n = ::send(fd, s.data() + o, s.size() - o, MSG_NOSIGNAL);
    if (n <= 0) return;
    o += size_t(n);
  }
}
void reply(int fd, int code, const std::string& type, const std::string& body, const std::string& extra = "") {
  const char* text = code == 200 ? "OK" : code == 201 ? "Created" : code == 404 ? "Not Found" : code == 409 ? "Conflict"
                   : code == 413 ? "Payload Too Large" : code == 422 ? "Unprocessable Entity" : code == 405 ? "Method Not Allowed"
                   : code == 503 ? "Service Unavailable" : code == 403 ? "Forbidden" : code == 206 ? "Partial Content"
                   : code == 416 ? "Range Not Satisfiable" : "Bad Request";
  send_all(fd, "HTTP/1.1 " + std::to_string(code) + " " + text + "\r\nContent-Type: " + type +
                   "\r\nContent-Length: " + std::to_string(body.size()) +
                   "\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n" + t_cors +
                   (extra.empty() ? "Cache-Control: no-store\r\n" : extra) + "\r\n" + body);
}
void reply_json(int fd, int code, const Value& v) { reply(fd, code, "application/json; charset=utf-8", json::dump(v)); }
void error_json(int fd, int code, const std::string& msg) {
  Value v = Value::object();
  v["error"] = msg;
  reply_json(fd, code, v);
}
const char* mime(const std::string& p) {
  if (p.ends_with(".html")) return "text/html; charset=utf-8";
  if (p.ends_with(".js") || p.ends_with(".mjs")) return "text/javascript; charset=utf-8";
  if (p.ends_with(".css")) return "text/css; charset=utf-8";
  if (p.ends_with(".json")) return "application/json; charset=utf-8";
  if (p.ends_with(".svg")) return "image/svg+xml";
  if (p.ends_with(".png")) return "image/png";
  if (p.ends_with(".woff2")) return "font/woff2";
  if (p.ends_with(".log") || p.ends_with(".txt") || p.ends_with(".md")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}
void send_file(int fd, const fs::path& p, const std::string& cache = "") {
  std::error_code ec;
  if (!fs::is_regular_file(p, ec)) { error_json(fd, 404, "Bulunamadı."); return; }
  // one byte range (the page reads single planes, points and soundings this way)
  unsigned long long a = 0, b = 0;
  if (!t_range.empty() && std::sscanf(t_range.c_str(), "bytes=%llu-%llu", &a, &b) == 2 && b >= a) {
    const auto size = fs::file_size(p, ec);
    if (a >= size) { reply(fd, 416, "text/plain", "", "Content-Range: bytes */" + std::to_string(size) + "\r\n"); return; }
    b = std::min<unsigned long long>(b, size - 1);
    std::string body(b - a + 1, '\0');
    std::ifstream f(p, std::ios::binary);
    f.seekg(std::streamoff(a));
    f.read(body.data(), std::streamsize(body.size()));
    reply(fd, 206, mime(p.string()), body,
          "Content-Range: bytes " + std::to_string(a) + "-" + std::to_string(b) + "/" + std::to_string(size) + "\r\n" +
              "Accept-Ranges: bytes\r\n" + (cache.empty() ? "Cache-Control: no-store\r\n" : cache));
    return;
  }
  reply(fd, 200, mime(p.string()), read_file(p), "Accept-Ranges: bytes\r\n" + (cache.empty() ? "Cache-Control: no-store\r\n" : cache));
}

// Server-Sent Events: the progress of one run, once a second until it ends
void events(int fd, const std::string& id) {
  send_all(fd, "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nCache-Control: no-store\r\n"
               "Connection: close\r\n" + t_cors + "\r\n");
  const fs::path d = run_path(id);
  while (true) {
    Value r;
    {
      std::lock_guard<std::mutex> lk(g_mu);
      r = load_run(id);
      if (!r.is_null()) {
        merge_state(id, r);
        if (r["status"].str() == "queued") {
          int pos = 1;
          for (const auto& q : g_queue) { if (q == id) break; ++pos; }
          r["queue_position"] = pos;
        }
      }
    }
    if (r.is_null()) return;
    Value e = Value::object();
    for (const char* k : {"status", "stage", "pct", "message", "actual", "queue_position"}) if (r.has(k)) e[k] = r[k];
    const double run_s = r["settings"]["time"]["hours"].num() * 3600;
    // the model's progress from diag.csv: step, simulated time, max|u|, max|v|, ..., wall seconds (last column)
    const std::string diag = read_file(d / "out/diag.csv");
    if (diag.size() > 2) {
      const size_t end = diag.find_last_not_of('\n');
      const size_t nl = diag.rfind('\n', end);
      const size_t beg = nl == std::string::npos ? 0 : nl + 1;
      std::vector<std::string> f;
      std::stringstream ss(diag.substr(beg, end - beg + 1));
      for (std::string x; std::getline(ss, x, ',');) f.push_back(x);
      if (f.size() > 3 && std::isdigit(static_cast<unsigned char>(f[0][0]))) {
        const double step = std::atof(f[0].c_str()), sim = std::atof(f[1].c_str()), wall = std::atof(f.back().c_str());
        e["sim_s"] = sim;
        e["run_s"] = run_s;
        e["wall_s"] = wall;
        e["step"] = step;
        e["max_wind"] = std::max(std::atof(f[2].c_str()), std::atof(f[3].c_str()));
        if (wall > 0 && sim > 0) {
          e["sim_per_wall"] = sim / wall;
          e["steps_per_s"] = step / wall;
          e["model_remaining_s"] = std::max(0.0, (run_s - sim) * wall / sim);
        }
      }
    }
    // the frames wrfpost has finished (meta.json "ready"), so the page can show them during the run
    int frames = 0;
    if (const std::string meta = read_file(d / "products/meta.json"); !meta.empty()) {
      try {
        const Value m = json::parse(meta);
        if (m.has("ready")) frames = int(m["ready"].a.size());
      } catch (...) { /* being rewritten */ }
    }
    e["frames"] = frames;
    // the log tail of the running stage
    const std::string stage = r["stage"].str();
    std::string logname = stage;
    if (stage == "wps")
      for (const char* p : {"geogrid", "ungrib", "metgrid"})
        if (fs::exists(d / "logs" / (std::string(p) + ".log"))) logname = p;
    std::string tail = read_file(d / "logs" / (logname + ".log"));
    if (tail.size() > 2000) tail = tail.substr(tail.size() - 2000);
    e["log_stage"] = logname;
    e["log_tail"] = tail;
    send_all(fd, "data: " + json::dump(e) + "\n\n");
    char probe;
    if (::recv(fd, &probe, 1, MSG_PEEK | MSG_DONTWAIT) == 0) return;  // the page went away
    if (terminal(r["status"].str())) return;
    std::this_thread::sleep_for(std::chrono::seconds(1));
  }
}

void api(int fd, const std::string& M, const std::vector<std::string>& seg, const std::string& body) {
  if (seg.size() == 1 && seg[0] == "system" && M == "GET") { reply_json(fd, 200, system_info()); return; }
  if (seg.size() == 1 && seg[0] == "options" && M == "GET") {
    static std::string opts;
    static std::mutex mu;
    std::lock_guard<std::mutex> lk(mu);
    if (opts.empty()) opts = run_prog({"python3", "-I", (g_root / "forecast/prepare.py").string(), "options"}, g_root).out;
    reply(fd, 200, "application/json; charset=utf-8", opts);
    return;
  }
  if (seg.size() == 1 && seg[0] == "cycles" && M == "GET") { reply_json(fd, 200, cycles()); return; }
  if (seg.size() == 1 && seg[0] == "basemap" && M == "GET") {
    reply(fd, 200, "application/octet-stream", build_basemap(), "Cache-Control: max-age=86400\r\n");
    return;
  }
  if (seg.size() == 1 && seg[0] == "estimate" && M == "POST") { reply_json(fd, 200, check_settings(body, system_info())); return; }
  if (seg.size() == 1 && seg[0] == "runs" && M == "GET") {
    Value list = Value::array();
    std::lock_guard<std::mutex> lk(g_mu);
    for (const auto& id : list_runs()) {
      Value r = load_run(id);
      merge_state(id, r);
      r.o.erase("system");
      list.push(r);
    }
    reply_json(fd, 200, list);
    return;
  }
  if (seg.size() == 1 && seg[0] == "runs" && M == "POST") {
    const Value sys = system_info();
    const std::string id = new_id();
    const fs::path d = run_path(id);
    fs::create_directories(d / "logs");
    Value chk = check_settings(body, sys, d);
    if (!chk["ok"].boolean()) {
      std::error_code ec;
      fs::remove_all(d, ec);
      reply_json(fd, 422, chk);
      return;
    }
    Value r = Value::object();
    r["id"] = id;
    r["created"] = now_iso();
    r["status"] = "queued";
    r["stage"] = "queued";
    for (const char* k : {"settings", "estimate", "other_modes", "derived", "warnings", "level"}) r[k] = chk[k];
    r["cppwrf_commit"] = cppwrf_commit();
    r["system"] = sys;
    r["starred"] = false;
    {
      std::lock_guard<std::mutex> lk(g_mu);
      save_run(id, r);
      g_queue.push_back(id);
      r["queue_position"] = int(g_queue.size()) + (g_child > 0 ? 1 : 0);
    }
    g_cv.notify_all();
    reply_json(fd, 201, r);
    return;
  }
  if (seg.size() >= 2 && seg[0] == "runs") {
    const std::string id = seg[1];
    if (!safe_id(id) || !fs::exists(run_path(id) / "run.json")) { error_json(fd, 404, "Böyle bir çalışma yok."); return; }
    if (seg.size() == 2 && M == "GET") {
      std::lock_guard<std::mutex> lk(g_mu);
      Value r = load_run(id);
      merge_state(id, r);
      reply_json(fd, 200, r);
      return;
    }
    if (seg.size() == 2 && M == "DELETE") {
      pid_t pg = -1;
      {
        std::lock_guard<std::mutex> lk(g_mu);
        if (g_child_id == id) pg = g_child;
        g_queue.erase(std::remove(g_queue.begin(), g_queue.end(), id), g_queue.end());
      }
      if (pg > 0) stop_group(pg);
      std::lock_guard<std::mutex> lk(g_mu);
      std::error_code ec;
      fs::remove_all(run_path(id), ec);
      Value v = Value::object();
      v["ok"] = true;
      reply_json(fd, 200, v);
      return;
    }
    if (seg.size() == 3 && seg[2] == "cancel" && M == "POST") {
      pid_t pg = -1;
      {
        std::lock_guard<std::mutex> lk(g_mu);
        Value r = load_run(id);
        if (terminal(r["status"].str())) { reply_json(fd, 200, r); return; }
        if (g_child_id == id) pg = g_child;
        g_queue.erase(std::remove(g_queue.begin(), g_queue.end(), id), g_queue.end());
        r["status"] = "cancelled";
        r["message"] = "Kullanıcı iptal etti.";
        r["ended"] = now_iso();
        save_run(id, r);
      }
      if (pg > 0) stop_group(pg);  // the worker reaps it; finish_run keeps "cancelled" and removes the partial files
      else {
        std::lock_guard<std::mutex> lk(g_mu);
        if (!load_run(id)["settings"]["keep_partial"].boolean()) remove_partial(id);
      }
      std::lock_guard<std::mutex> lk(g_mu);
      reply_json(fd, 200, load_run(id));
      return;
    }
    if (seg.size() == 3 && seg[2] == "star" && M == "POST") {
      Value b;
      try { b = json::parse(body); } catch (...) { error_json(fd, 400, "Geçersiz JSON."); return; }
      std::lock_guard<std::mutex> lk(g_mu);
      Value r = load_run(id);
      r["starred"] = b["starred"].boolean(true);
      save_run(id, r);
      reply_json(fd, 200, r);
      return;
    }
    if (seg.size() == 3 && seg[2] == "events" && M == "GET") { events(fd, id); return; }
    if (seg.size() == 4 && seg[2] == "logs" && M == "GET" && safe_name(seg[3])) {
      send_file(fd, run_path(id) / "logs" / (seg[3] + ".log"));
      return;
    }
    if (seg.size() >= 4 && seg.size() <= 6 && seg[2] == "products" && M == "GET") {
      // products/<file>, products/<f|n|s>/<file>, products/d0N/[<f|n|s>/]<file>
      static const std::regex sub("^(f|n|s|d0[2-9])$");
      fs::path p = run_path(id) / "products";
      for (size_t i = 3; i + 1 < seg.size(); ++i) {
        if (!std::regex_match(seg[i], sub)) { error_json(fd, 404, "Bulunamadı."); return; }
        p /= seg[i];
      }
      if (!safe_name(seg.back())) { error_json(fd, 404, "Bulunamadı."); return; }
      send_file(fd, p / seg.back(), seg.back().ends_with(".f32") ? "Cache-Control: max-age=600\r\n" : "");
      return;
    }
    if ((seg.size() == 4 || seg.size() == 5) && seg[2] == "out" && M == "GET" && safe_name(seg.back()) &&
        seg.back().rfind("wrfout_", 0) == 0) {
      fs::path p = run_path(id) / "out";
      if (seg.size() == 5) {
        static const std::regex dn("^d0[1-9]$");
        if (!std::regex_match(seg[3], dn)) { error_json(fd, 404, "Bulunamadı."); return; }
        p /= seg[3];
      }
      send_file(fd, p / seg.back(), "Content-Disposition: attachment\r\nCache-Control: no-store\r\n");
      return;
    }
    if (seg.size() == 3 && seg[2] == "files" && M == "GET") {
      Value list = Value::array();
      std::error_code ec;
      for (auto it = fs::recursive_directory_iterator(run_path(id) / "out", ec); it != fs::recursive_directory_iterator(); it.increment(ec)) {
        const std::string n = it->path().filename().string();
        if (n.rfind("wrfout_", 0) == 0) {
          Value f = Value::object();
          f["path"] = fs::relative(it->path(), run_path(id) / "out").string();
          f["bytes"] = double(it->file_size(ec));
          list.push(f);
        }
      }
      reply_json(fd, 200, list);
      return;
    }
  }
  error_json(fd, 404, "Bilinmeyen API adresi.");
}

void handle(int fd) {
  std::string buf;
  char tmp[8192];
  size_t hdr_end = std::string::npos;
  while (hdr_end == std::string::npos && buf.size() < kMaxRequest) {
    const ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) return;
    buf.append(tmp, size_t(n));
    hdr_end = buf.find("\r\n\r\n");
  }
  if (hdr_end == std::string::npos) { error_json(fd, 413, "İstek çok büyük."); return; }
  std::string method, path;
  std::istringstream hs(buf.substr(0, hdr_end));
  hs >> method >> path;
  size_t len = 0;
  std::string origin;
  t_range.clear();
  for (std::string line; std::getline(hs, line);) {
    std::string l = line;
    std::transform(l.begin(), l.end(), l.begin(), ::tolower);
    if (l.rfind("content-length:", 0) == 0) len = size_t(std::atol(l.c_str() + 15));
    if (l.rfind("origin:", 0) == 0) origin = trim(line.substr(7));
    if (l.rfind("range:", 0) == 0) t_range = trim(l.substr(6));
  }
  // the site may also be opened from GitHub Pages: those origins get CORS (and Private Network Access) headers;
  // any other foreign origin may read nothing and change nothing
  t_cors.clear();
  const bool same = origin.empty() || origin == "http://127.0.0.1:" + std::to_string(g_port) ||
                    origin == "http://localhost:" + std::to_string(g_port);
  const bool allowed = std::find(g_origins.begin(), g_origins.end(), origin) != g_origins.end();
  if (allowed) t_cors = "Access-Control-Allow-Origin: " + origin + "\r\nVary: Origin\r\nAccess-Control-Expose-Headers: Content-Range\r\n";
  if (method == "OPTIONS") {
    if (!allowed) { error_json(fd, 403, "Bu kaynağa izin yok."); return; }
    send_all(fd, "HTTP/1.1 204 No Content\r\n" + t_cors +
                     "Access-Control-Allow-Methods: GET, POST, DELETE\r\nAccess-Control-Allow-Headers: Content-Type, Range\r\n"
                     "Access-Control-Allow-Private-Network: true\r\nAccess-Control-Max-Age: 600\r\n"
                     "Content-Length: 0\r\nConnection: close\r\n\r\n");
    return;
  }
  if (!same && !allowed && method != "GET") { error_json(fd, 403, "Bu kaynağa izin yok."); return; }
  if (len > kMaxRequest) { error_json(fd, 413, "İstek çok büyük."); return; }
  std::string body = buf.substr(hdr_end + 4);
  while (body.size() < len) {
    const ssize_t n = ::recv(fd, tmp, sizeof tmp, 0);
    if (n <= 0) break;
    body.append(tmp, size_t(n));
  }
  if (body.size() > len) body.resize(len);
  if (const auto qm = path.find('?'); qm != std::string::npos) path.resize(qm);
  std::vector<std::string> seg;
  {
    std::stringstream ss(path);
    for (std::string x; std::getline(ss, x, '/');) if (!x.empty()) seg.push_back(x);
  }
  if (seg.size() >= 2 && seg[0] == "api" && seg[1] == "v1") {
    seg.erase(seg.begin(), seg.begin() + 2);
    api(fd, method, seg, body);
    return;
  }
  if (method != "GET") { error_json(fd, 405, "Yalnızca GET."); return; }
  // the site: files under forecast/web only
  const std::string rel = path == "/" ? "index.html" : path.substr(1);
  static const std::regex ok("^[A-Za-z0-9_][A-Za-z0-9_./-]{0,200}$");
  if (!std::regex_match(rel, ok) || rel.find("..") != std::string::npos) { error_json(fd, 404, "Bulunamadı."); return; }
  const fs::path web = fs::weakly_canonical(g_root / "forecast/web");
  const fs::path p = fs::weakly_canonical(web / rel);
  if (p.string().rfind(web.string() + "/", 0) != 0) { error_json(fd, 404, "Bulunamadı."); return; }
  send_file(fd, p, "Cache-Control: no-cache\r\n");
}

}  // namespace

int main(int argc, char** argv) {
  int port = 8090;
  for (int i = 1; i + 1 < argc; ++i)
    if (std::string(argv[i]) == "--port") port = std::atoi(argv[i + 1]);
  g_port = port;
  if (const char* o = std::getenv("CPPWRF_ALLOWED_ORIGINS")) {
    g_origins.clear();
    std::stringstream ss(o);
    for (std::string x; std::getline(ss, x, ',');) if (!trim(x).empty()) g_origins.push_back(trim(x));
  }
  g_root = fs::absolute(std::getenv("CPPWRF_WEB_ROOT") ? std::getenv("CPPWRF_WEB_ROOT") : ".");
  if (const char* k = std::getenv("CPPWRF_KEEP_RUNS")) g_keep_runs = std::max(1, std::atoi(k));
  if (!fs::exists(g_root / "forecast/pipeline.sh")) {
    std::fprintf(stderr, "cppwrf-forecast: run it from the repository root (or set CPPWRF_WEB_ROOT)\n");
    return 1;
  }
  fs::create_directories(runs_dir());
  signal(SIGPIPE, SIG_IGN);
  recover();
  std::thread(worker).detach();

  const int s = socket(AF_INET, SOCK_STREAM, 0);
  const int one = 1;
  setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
  sockaddr_in a{};
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);  // 127.0.0.1 only
  a.sin_port = htons(uint16_t(port));
  if (bind(s, reinterpret_cast<sockaddr*>(&a), sizeof a) != 0 || listen(s, 32) != 0) {
    std::perror("cppwrf-forecast: bind 127.0.0.1");
    return 1;
  }
  std::fprintf(stderr, "cppwrf-forecast: http://127.0.0.1:%d/ (CPPWRF %s)\n", port, cppwrf_commit().c_str());
  while (true) {
    const int c = accept(s, nullptr, nullptr);
    if (c < 0) continue;
    timeval tv{30, 0};
    setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    std::thread([c] { handle(c); close(c); }).detach();
  }
}
