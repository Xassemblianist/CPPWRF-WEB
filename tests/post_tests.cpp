// SPDX-License-Identifier: GPL-3.0-or-later
// Unit tests of wrfpost's column diagnostics (forecast/server/postcore.hpp) against closed-form cases:
//   interpolation in ln p, the MSLP reduction of a standard-atmosphere column, dew point, the pseudoadiabat,
//   CAPE of a stable column, CAPE of a column with a known constant buoyancy, CIN of a capped column, gusts.
// MetPy is the usual reference for CAPE; it is not installed on this machine, so the cases are analytic.
#include "../forecast/server/postcore.hpp"

#include <cstdio>
#include <vector>

static int failures = 0, checks = 0;
static void near(const char* what, double got, double want, double tol) {
  ++checks;
  const bool ok = std::fabs(got - want) <= tol;
  if (!ok) ++failures;
  std::printf("%s %-46s got %.6g want %.6g (tol %.3g)\n", ok ? "ok  " : "FAIL", what, got, want, tol);
}
static void is_nan(const char* what, double got) {
  ++checks;
  const bool ok = std::isnan(got);
  if (!ok) ++failures;
  std::printf("%s %-46s got %.6g want NaN\n", ok ? "ok  " : "FAIL", what, got);
}

int main() {
  using namespace post;
  // ---- ln p interpolation: exact for a field linear in ln p; NaN outside the column
  {
    std::vector<float> p{1000, 900, 800, 700, 600, 500}, v(6);
    for (int k = 0; k < 6; ++k) v[k] = float(10.0 + 30.0 * std::log(1000.0 / p[k]));
    near("interp_logp 850 hPa", interp_logp(p.data(), v.data(), 6, 850), 10 + 30 * std::log(1000.0 / 850), 1e-4);
    near("interp_logp 555 hPa", interp_logp(p.data(), v.data(), 6, 555), 10 + 30 * std::log(1000.0 / 555), 1e-4);
    near("interp_logp at a level", interp_logp(p.data(), v.data(), 6, 700), v[3], 1e-5);
    is_nan("interp_logp below the ground", interp_logp(p.data(), v.data(), 6, 1013));
    is_nan("interp_logp above the top", interp_logp(p.data(), v.data(), 6, 300));
  }
  // ---- MSLP: the ICAO standard atmosphere over ground at 1500 m reduces to 1013.25 hPa
  {
    const double T0 = 288.15, P0 = 101325, gam = 0.0065, ex = kG / (kRd * gam);
    std::vector<double> z, p, t, q;
    for (double h = 1500; h < 11000; h += 250) {
      z.push_back(h);
      t.push_back(T0 - gam * h);
      p.push_back(P0 * std::pow(1 - gam * h / T0, ex));
      q.push_back(0);
    }
    near("mslp standard atmosphere, ground 1500 m (Pa)", mslp(p.data(), t.data(), q.data(), z.data(), int(z.size())), P0, 50);
    // a warm column: the reduction follows the MM5 rule above 290.66 K, so only a plausible range is asserted
    for (auto& x : t) x += 25;
    const double warm = mslp(p.data(), t.data(), q.data(), z.data(), int(z.size()));
    ++checks;
    if (!(warm > 95000 && warm < P0)) ++failures;
    std::printf("%s %-46s got %.6g (a warmer column reduces to lower pressure)\n", warm > 95000 && warm < P0 ? "ok  " : "FAIL", "mslp warm column", warm);
  }
  // ---- dew point: the vapour pressure at Td equals the vapour pressure of q
  {
    const double p = 950, q = 0.009;
    const double td = dewpoint_k(q, p);
    near("es(Td) = e(q)", es_hpa(td), vapour_hpa(q, p), 1e-6);
    near("RH at saturation", rh_pct(290, qsat(290, 900), 900), 100, 1e-6);
  }
  // ---- the pseudoadiabat keeps theta-e
  {
    const double t0 = 297, p0 = 1000, q0 = qsat(t0, p0);
    const double the = theta_e(t0, q0, p0, t0);
    const double t5 = t_on_pseudoadiabat(the, 500, 260);
    near("theta-e conserved at 500 hPa", theta_e(t5, qsat(t5, 500), 500, t5), the, 1e-3);
    ++checks;
    const bool ok = t5 > 255 && t5 < 275;  // tables: about 266 K for a 24 C saturated surface parcel
    if (!ok) ++failures;
    std::printf("%s %-46s got %.4g K (about 266 K in pseudoadiabatic tables)\n", ok ? "ok  " : "FAIL", "pseudoadiabat 24 C -> 500 hPa", t5);
  }
  // ---- CAPE
  std::vector<double> p;
  for (double x = 1000; x >= 100; x -= 25) p.push_back(x);
  const int nz = int(p.size());
  {
    // a stable, dry column much warmer than any parcel: no CAPE, no LFC
    std::vector<double> t(nz, 320), q(nz, 1e-5);
    const Parcel r = lift(1000, 300, 0.01, p.data(), t.data(), q.data(), nz, 0);
    near("CAPE stable column", r.cape, 0, 1e-9);
  }
  {
    // a saturated parcel at 1000 hPa; the environment's virtual temperature is the parcel's minus D everywhere:
    // the buoyancy is Rd * D on every level, and CAPE = Rd * D * ln(p1 / p_top) (the first layer starts at B = 0
    // at the parcel's own level and counts below the LFC)
    const double t0 = 298, q0 = qsat(t0, 1000), D = 2.0;
    const double the = theta_e(t0, q0, 1000, t_lcl(t0, q0, 1000));  // as lift(): Bolton's LCL temperature
    std::vector<double> t(nz), q(nz);
    double guess = t0;
    for (int k = 0; k < nz; ++k) {
      const double tp = k == 0 ? t0 : t_on_pseudoadiabat(the, p[k], guess);
      guess = tp;
      q[k] = qsat(tp, p[k]);
      t[k] = (tp * (1 + 0.61 * q[k]) - D) / (1 + 0.61 * q[k]);
    }
    t[0] = t0;
    q[0] = q0;
    const Parcel r = lift(1000, t0, q0, p.data(), t.data(), q.data(), nz, 1);
    near("CAPE constant buoyancy (J/kg)", r.cape, kRd * D * std::log(p[1] / p[nz - 1]), 0.5);
    near("CIN constant buoyancy", r.cin, 0, 1e-9);
  }
  {
    // the same parcel under a cap: a 4 K warmer environment from the parcel up to 900 hPa gives CIN below the LFC
    // (the first LFC, as MetPy's default which_lfc="bottom"); CAPE above the cap
    const double t0 = 298, q0 = qsat(t0, 1000), D = 2.0;
    const double the = theta_e(t0, q0, 1000, t_lcl(t0, q0, 1000));  // as lift(): Bolton's LCL temperature
    std::vector<double> t(nz), q(nz);
    double guess = t0;
    for (int k = 0; k < nz; ++k) {
      const double tp = k == 0 ? t0 : t_on_pseudoadiabat(the, p[k], guess);
      guess = tp;
      q[k] = qsat(tp, p[k]);
      const double d = p[k] >= 900 ? -4.0 : D;
      t[k] = (tp * (1 + 0.61 * q[k]) - d) / (1 + 0.61 * q[k]);
    }
    t[0] = t0;
    q[0] = q0;
    const Parcel r = lift(1000, t0, q0, p.data(), t.data(), q.data(), nz, 1);
    // B = 0 at the parcel, -4 Rd up to 900 hPa, crossing zero a third of the way to 875 hPa, then +2 Rd
    const double cin = -2 * kRd * std::log(1000.0 / 975) - 4 * kRd * std::log(975.0 / 900) - 0.5 * 4 * kRd * (2.0 / 3) * std::log(900.0 / 875);
    const double cape = 0.5 * 2 * kRd * (1.0 / 3) * std::log(900.0 / 875) + kRd * D * std::log(875.0 / p[nz - 1]);
    near("CIN under a cap (J/kg)", r.cin, cin, 0.5);
    near("CAPE above a cap (J/kg)", r.cape, cape, 0.5);
  }
  // ---- gusts (UPP CALGUST)
  near("gust, no PBL difference", gust(10, 8, 1000), 10, 1e-12);
  near("gust, deep PBL halves the difference", gust(10, 20, 3000), 15, 1e-12);
  near("gust, shallow PBL", gust(10, 20, 500), 17.5, 1e-12);

  std::printf("\n%d checks, %d failed\n", checks, failures);
  return failures ? 1 : 0;
}
