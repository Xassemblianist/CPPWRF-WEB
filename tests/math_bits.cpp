// SPDX-License-Identifier: GPL-3.0-or-later
// The math functions of the model, as its kernels call them (core/backend.hpp: cppwrf::libm and the libmvec lanes
// of cppwrf::vm), on 10^6 arguments each; prints one 64-bit hash of the result bits per function. The native CPU
// build calls glibc's libm and libmvec; the wasm build (CPPWRF_GLIBC_MATH) calls CPPWRF's port of them. The two
// outputs must be equal line for line.
#include <cinttypes>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <vector>

#include "core/backend.hpp"

namespace {
constexpr int kN = 1000000;

struct Rng {  // splitmix64
  std::uint64_t s;
  std::uint64_t next() {
    std::uint64_t z = (s += 0x9e3779b97f4a7c15ull);
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
  }
  double uniform(double a, double b) { return a + (b - a) * double(next() >> 11) * 0x1p-53; }
  double positive_bits() {  // any positive finite double, uniform in its bit pattern
    for (;;) {
      std::uint64_t u = next() & 0x7fffffffffffffffull;
      double d;
      std::memcpy(&d, &u, 8);
      if (d > 0 && d < __builtin_inf()) return d;
    }
  }
};

struct Hash {  // FNV-1a over the bits of the results
  std::uint64_t h = 0xcbf29ce484222325ull;
  void add(double d) {
    std::uint64_t u;
    std::memcpy(&u, &d, 8);
    for (int b = 0; b < 8; ++b) {
      h ^= (u >> (8 * b)) & 0xff;
      h *= 0x100000001b3ull;
    }
  }
};

// arguments: half over a wide range, half over the range the model's kernels see most
std::vector<double> args(std::uint64_t seed, double a, double b, double c, double d, bool bits = false) {
  Rng r{seed};
  std::vector<double> v(kN);
  for (int i = 0; i < kN; ++i)
    v[i] = (i & 1) ? r.uniform(c, d) : (bits ? r.positive_bits() : r.uniform(a, b));
  return v;
}

template <class F>
void report(const char* name, F f) {
  Hash h;
  for (int i = 0; i < kN; ++i) h.add(f(i));
  std::printf("%-10s %016" PRIx64 "\n", name, h.h);
}
}  // namespace

int main() {
  namespace lm = cppwrf::libm;
  namespace vm = cppwrf::vm;
  const auto ex = args(1, -745.0, 709.0, -2.0, 2.0);
  const auto lg = args(2, 0, 0, 0.5, 2.0, true);
  const auto px = args(3, 1e-6, 1e3, 0.1, 2.0);
  const auto py = args(4, -10.0, 10.0, 0.1, 3.0);
  const auto tr = args(5, -1e3, 1e3, -3.15, 3.15);
  const auto ay = args(6, -1e3, 1e3, -1.0, 1.0);
  const auto ax = args(7, -1e3, 1e3, -1.0, 1.0);
  const auto sq = args(8, 0, 0, 0.0, 1e5, true);
  // scalar libm (the kernels' cppwrf::libm, also rexp / rlog / rpow)
  report("exp", [&](int i) { return lm::exp(ex[i]); });
  report("log", [&](int i) { return lm::log(lg[i]); });
  report("log10", [&](int i) { return lm::log10(lg[i]); });
  report("pow", [&](int i) { return lm::pow(px[i], py[i]); });
  report("sin", [&](int i) { return lm::sin(tr[i]); });
  report("cos", [&](int i) { return lm::cos(tr[i]); });
  report("atan", [&](int i) { return lm::atan(ay[i]); });
  report("atan2", [&](int i) { return lm::atan2(ay[i], ax[i]); });
  report("tanh", [&](int i) { return lm::tanh(tr[i] * 0.01); });
  report("sqrt", [&](int i) { return std::sqrt(sq[i]); });
  // libmvec lanes (vm::f(x, i, n) with n even: every iteration is a vector lane)
  report("vm.exp", [&](int i) { return vm::exp(ex[i], i, kN); });
  report("vm.log", [&](int i) { return vm::log(lg[i], i, kN); });
  report("vm.log10", [&](int i) { return vm::log10(lg[i], i, kN); });
  report("vm.pow", [&](int i) { return vm::pow(px[i], py[i], i, kN); });
  report("vm.sin", [&](int i) { return vm::sin(tr[i], i, kN); });
  report("vm.cos", [&](int i) { return vm::cos(tr[i], i, kN); });
  report("vm.atan", [&](int i) { return vm::atan(ay[i], i, kN); });
  return 0;
}
