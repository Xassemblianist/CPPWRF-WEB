// SPDX-License-Identifier: GPL-3.0-or-later
// CPPWRF-Web: the time loop of CPPWRF's src/main.cpp (one domain, no tiles, no nests) cut into calls that JS makes,
// so that a worker can run some steps, read the fields and post them, and run on. The model and its output are
// CPPWRF's own (cases::Model, cases::DomainRunner); nothing here changes what it computes.
//
//   web_init(ini, out_dir)  -> nsteps, or -1 (web_error() has the message)
//   web_step(count)         -> the last step done, or -1
//   web_field(which, &nx, &nz) -> an x-z section of theta', W, QRAIN or the height (doubles, k-major)
//   web_finish()            -> 0
// main(argc, argv) runs a whole configuration as ./cppwrf <config.ini> [--set section.key=value ...] (node).
#include <cstdio>
#include <exception>
#include <memory>
#include <string>
#include <vector>

#include <emscripten/emscripten.h>
#include <emscripten/heap.h>

#include "cases/domain_runner.hpp"
#include "cases/model.hpp"
#include "core/backend.hpp"
#include "core/constants.hpp"
#include "io/config.hpp"

using namespace cppwrf;

namespace {
// the model is built in place (as in main.cpp), never moved: its parts keep pointers to it
struct Run {
  explicit Run(io::Config c) : cfg(std::move(c)), m(cases::Model::build(cfg)) {}
  io::Config cfg;
  cases::Model m;
  std::unique_ptr<cases::DomainRunner> r;
  long n = 0;  // the last step done
};
std::unique_ptr<Run> run;
std::string error;
std::vector<double> section;
std::size_t peak = 0;

void note_peak() {
  const std::size_t h = emscripten_get_heap_size();
  if (h > peak) peak = h;
}

template <class F>
int guarded(F f) {
  try {
    return f();
  } catch (const std::exception& e) {
    error = e.what();
    std::fprintf(stderr, "cppwrf: error: %s\n", e.what());
    return -1;
  }
}
}  // namespace

extern "C" {

EMSCRIPTEN_KEEPALIVE int web_init(const char* ini, const char* out_dir) {
  return guarded([&] {
    run.reset();
    auto x = std::make_unique<Run>(io::Config::load(ini, {std::string("output.dir=") + out_dir}));
    x->r = std::make_unique<cases::DomainRunner>(x->cfg, x->m, out_dir, "d01");
    if (!x->r->start()) throw std::runtime_error("start failed");
    x->n = x->r->start_step;
    run = std::move(x);
    note_peak();
    return int(run->m.nsteps);
  });
}

EMSCRIPTEN_KEEPALIVE int web_nsteps() { return run ? int(run->m.nsteps) : 0; }
EMSCRIPTEN_KEEPALIVE int web_step_now() { return run ? int(run->n) : 0; }

EMSCRIPTEN_KEEPALIVE int web_step(int count) {
  return guarded([&] {
    if (!run) throw std::runtime_error("web_step before web_init");
    Run& x = *run;
    for (int c = 0; c < count && x.n < x.m.nsteps; ++c) {
      const long n = x.n + 1;
      x.r->before_step(n);
      x.m.rk->step(*x.m.st, *x.m.tend, *x.m.base);
      dev_sync();
      if (!x.r->after_step(n)) throw std::runtime_error("step " + std::to_string(n) + " failed");
      x.n = n;
    }
    note_peak();
    return int(x.n);
  });
}

// which: 0 theta' (dry theta - its initial profile, as the max_th_pert diagnostic of dyn/diagnostics.cpp; theta_m
// runs), 1 W, 2 QRAIN, 3 height of the mass levels; the x-z section at the middle row j = ny / 2 (0 in an x-z case),
// k-major. A display copy: the model's fields are only read.
EMSCRIPTEN_KEEPALIVE double* web_field(int which, int* nx, int* nz) {
  if (!run) return nullptr;
  const dyn::State& s = *run->m.st;
  const int j = run->m.g.ny / 2;
  if (which == 3) {  // height of the mass levels above the surface [m]: (ph + phb) / g at the w levels, averaged
    std::vector<real> ph, phb;
    s.ph_2.download(ph);
    const BaseField3& b = run->m.base->phb;
    b.download(phb);
    const Layout& L = s.ph_2.layout();
    const Layout& Lb = b.layout();
    const int nxm = run->m.g.nx, nzm = run->m.g.nz;
    section.resize(std::size_t(nxm) * nzm);
    auto z = [&](int i, int k) {
      return (double(ph[L.index(i, j, k)]) + double(phb[Lb.index(b.uniform() ? 0 : i, b.uniform() ? 0 : j, k)])) / cst::g;
    };
    for (int k = 0; k < nzm; ++k)
      for (int i = 0; i < nxm; ++i) section[std::size_t(k) * nxm + i] = 0.5 * (z(i, k) + z(i, k + 1)) - z(i, 0);
    *nx = nxm;
    *nz = nzm;
    return section.data();
  }
  const Field3* f = which == 0 ? &s.t_2 : which == 1 ? &s.w_2 : (which == 2 && s.P_QR >= 0) ? &s.q_2[s.P_QR] : nullptr;
  if (!f) return nullptr;
  std::vector<real> h, qv, ti;
  f->download(h);
  const Layout& L = f->layout();
  section.resize(std::size_t(L.nx) * L.nz);
  for (int k = 0; k < L.nz; ++k)
    for (int i = 0; i < L.nx; ++i) section[std::size_t(k) * L.nx + i] = double(h[L.index(i, j, k)]);
  if (which == 0) {
    const BaseField3& tinit = run->m.base->t_init;
    tinit.download(ti);
    const Layout& Lt = tinit.layout();
    const bool moist = s.P_QV >= 0;
    if (moist) s.q_2[s.P_QV].download(qv);
    for (int k = 0; k < L.nz; ++k)
      for (int i = 0; i < L.nx; ++i) {
        double& v = section[std::size_t(k) * L.nx + i];
        if (moist) v = (v + cst::t0) / (1.0 + cst::rvovrd * double(qv[L.index(i, j, k)])) - cst::t0;
        v -= double(ti[Lt.index(tinit.uniform() ? 0 : i, tinit.uniform() ? 0 : j, k)]);
      }
  }
  *nx = L.nx;
  *nz = L.nz;
  return section.data();
}

EMSCRIPTEN_KEEPALIVE int web_finish() {
  return guarded([&] {
    if (run) run->r->finish();
    note_peak();
    run.reset();
    return 0;
  });
}

EMSCRIPTEN_KEEPALIVE const char* web_error() { return error.c_str(); }
EMSCRIPTEN_KEEPALIVE double web_peak_bytes() { return double(peak); }
EMSCRIPTEN_KEEPALIVE int web_nx() { return run ? run->m.g.nx : 0; }
EMSCRIPTEN_KEEPALIVE int web_nz(int which) { return run ? run->m.g.nz + (which == 1 ? 1 : 0) : 0; }

}  // extern "C"

int main(int argc, char** argv) {
  if (argc < 2) {
    std::fprintf(stderr, "usage: cppwrf_web <config.ini> [out_dir]\n");
    return 2;
  }
  const std::string out = argc > 2 ? argv[2] : "out";
  if (web_init(argv[1], out.c_str()) < 0) return 2;
  if (web_step(1 << 30) < 0) return 3;
  return web_finish() < 0 ? 3 : 0;
}
