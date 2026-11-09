// SPDX-License-Identifier: GPL-3.0-or-later
// The column diagnostics of wrfpost, in one header so that tests/post_tests.cpp checks the same code.
//
// Methods (docs/FORECAST.md, "Products"):
//   pressure levels   linear in ln p between the model's mass levels (as NCEP's UPP); NaN below the ground
//   MSLP              the reduction of wrf-python's slp() and NCL's wrf_slp (DCOMPUTESEAPRS): from the level 100 hPa
//                     above the lowest model level, a 6.5 K/km lapse rate, the "ridiculous MM5 test" at 290.66 K
//   dew point         Bolton (1980) over water from the vapour pressure
//   CAPE / CIN        a parcel lifted dry-adiabatically to its LCL (Bolton's LCL temperature), then along the
//                     pseudoadiabat (Bolton's equivalent potential temperature held constant), buoyancy from virtual
//                     temperatures (Doswell and Rasmussen 1994), integrated in ln p over the model levels:
//                     CAPE = the positive area from the LFC to the EL, CIN = the negative area below the LFC.
//                     Surface-based: the 2 m parcel at PSFC; most unstable: the model level with the highest
//                     equivalent potential temperature in the lowest 300 hPa.
//   lifted index      the 500 hPa temperature of the environment minus the surface-based parcel's
//   gusts             UPP's CALGUST: the 10 m wind plus the wind difference to the PBL top, reduced by
//                     (1 - min(0.5, PBLH / 2000 m))
//   clouds            the maximum CLDFRA in each pressure band (low p > 680 hPa, mid 680-440, high < 440 hPa;
//                     ISCCP's bands); total: random overlap of the three bands' maxima
#pragma once
#include <algorithm>
#include <cmath>
#include <limits>
#include <vector>

namespace post {

constexpr double kRd = 287.04, kCp = 1004.6, kG = 9.81, kEps = 0.622;
const float kNaN = std::numeric_limits<float>::quiet_NaN();

// saturation vapour pressure over water (hPa), Bolton (1980)
inline double es_hpa(double t_k) { return 6.112 * std::exp(17.67 * (t_k - 273.15) / (t_k - 29.65)); }
inline double vapour_hpa(double q, double p_hpa) { return std::max(1e-10, q * p_hpa / (kEps + q)); }
inline double dewpoint_k(double q, double p_hpa) {
  const double l = std::log(vapour_hpa(q, p_hpa) / 6.112);
  return 273.15 + 243.5 * l / (17.67 - l);
}
inline double rh_pct(double t_k, double q, double p_hpa) {
  return std::clamp(100.0 * vapour_hpa(q, p_hpa) / es_hpa(t_k), 0.0, 100.0);
}
inline double qsat(double t_k, double p_hpa) {
  const double e = es_hpa(t_k);
  return kEps * e / std::max(p_hpa - e, 1.0);
}
// Bolton (1980) eq. 22 (LCL temperature) and 43 (equivalent potential temperature)
inline double t_lcl(double t_k, double q, double p_hpa) {
  const double e = vapour_hpa(q, p_hpa);
  return 2840.0 / (3.5 * std::log(t_k) - std::log(e) - 4.805) + 55.0;
}
inline double theta_e(double t_k, double q, double p_hpa, double tl) {
  const double r = q * 1000.0;  // g/kg
  return t_k * std::pow(1000.0 / p_hpa, 0.2854 * (1.0 - 0.28e-3 * r)) * std::exp((3.376 / tl - 0.00254) * r * (1.0 + 0.81e-3 * r));
}
// the temperature on the pseudoadiabat theta_e at pressure p (Newton's method on theta_e of a saturated parcel)
inline double t_on_pseudoadiabat(double the, double p_hpa, double guess) {
  double t = guess;
  for (int it = 0; it < 30; ++it) {
    const double f = theta_e(t, qsat(t, p_hpa), p_hpa, t) - the;
    const double d = (theta_e(t + 0.01, qsat(t + 0.01, p_hpa), p_hpa, t + 0.01) - theta_e(t, qsat(t, p_hpa), p_hpa, t)) / 0.01;
    const double dt = f / d;
    t -= std::clamp(dt, -20.0, 20.0);
    if (std::fabs(dt) < 1e-4) break;
  }
  return t;
}

// linear interpolation in ln p of a column v (index 0 at the bottom, p decreasing upward); NaN outside the column
inline float interp_logp(const float* p, const float* v, int nz, double target, int stride = 1) {
  if (target > p[0] || target < p[(nz - 1) * stride]) return kNaN;
  for (int k = 0; k + 1 < nz; ++k) {
    const double p0 = p[k * stride], p1 = p[(k + 1) * stride];
    if (target <= p0 && target >= p1) {
      const double w = std::log(p0 / target) / std::log(p0 / p1);
      return float(v[k * stride] + w * (v[(k + 1) * stride] - v[k * stride]));
    }
  }
  return kNaN;
}

// wrf-python slp(): p, t (K), q (kg/kg), z (m above sea level, mass levels); index 0 at the bottom. Returns Pa.
inline double mslp(const double* p, const double* t, const double* q, const double* z, int nz) {
  constexpr double pconst = 10000.0, gamma = 0.0065, tc = 273.16 + 17.5;
  int level = -1;
  for (int k = 0; k < nz; ++k)
    if (p[k] < p[0] - pconst) { level = k; break; }
  if (level < 0) return std::numeric_limits<double>::quiet_NaN();
  const int klo = std::max(level - 1, 0), khi = std::min(klo + 1, nz - 1);
  if (klo == khi) return std::numeric_limits<double>::quiet_NaN();
  const double plo = p[klo], phi = p[khi];
  const double tlo = t[klo] * (1.0 + 0.608 * q[klo]), thi = t[khi] * (1.0 + 0.608 * q[khi]);
  const double zlo = z[klo], zhi = z[khi];
  const double p_at = p[0] - pconst;
  const double t_at = thi - (thi - tlo) * std::log(p_at / phi) / std::log(plo / phi);
  const double z_at = zhi - (zhi - zlo) * std::log(p_at / phi) / std::log(plo / phi);
  const double t_surf = t_at * std::pow(p[0] / p_at, gamma * kRd / kG);
  double t_sl = t_at + gamma * z_at;
  // the "ridiculous MM5 test" of wrf-python
  const bool l1 = t_sl < tc, l2 = t_surf <= tc, l3 = !l1;
  if (l2 && l3) t_sl = tc;
  else if (!l2 && l3) t_sl = tc - 0.005 * (t_surf - tc) * (t_surf - tc);
  return p[0] * std::exp(2.0 * kG * z[0] / (kRd * (t_sl + t_surf)));
}

struct Parcel { double cape = 0, cin = 0, t500 = std::numeric_limits<double>::quiet_NaN(); };

// a parcel from (p0 hPa, t0 K, q0) through the environment column (p hPa, t K, q) from level kstart up
inline Parcel lift(double p0, double t0, double q0, const double* p, const double* t, const double* q, int nz, int kstart) {
  Parcel r;
  const double tl = t_lcl(t0, q0, p0);
  const double plcl = p0 * std::pow(tl / t0, kCp / kRd);
  const double the = theta_e(t0, q0, p0, tl);
  const double theta = t0 * std::pow(1000.0 / p0, kRd / kCp);
  auto parcel_t = [&](double pp, double guess) {
    return pp >= plcl ? theta * std::pow(pp / 1000.0, kRd / kCp) : t_on_pseudoadiabat(the, pp, guess);
  };
  auto parcel_tv = [&](double pp, double tp) { return tp * (1.0 + 0.61 * (pp >= plcl ? q0 : qsat(tp, pp))); };
  // the buoyancy profile from the start point upward
  std::vector<double> pp{p0}, b;
  double tp = t0;
  b.push_back(kRd * (parcel_tv(p0, t0) - t0 * (1.0 + 0.61 * q0)));
  for (int k = kstart; k < nz; ++k) {
    if (p[k] >= p0) continue;
    tp = parcel_t(p[k], tp);
    pp.push_back(p[k]);
    b.push_back(kRd * (parcel_tv(p[k], tp) - t[k] * (1.0 + 0.61 * q[k])));
    if (std::isnan(r.t500) && p[k] <= 500.0 && pp.size() >= 2) {
      // the parcel's temperature at 500 hPa, by ln p between the last two levels
      const size_t n = pp.size();
      const double tp_prev = parcel_t(pp[n - 2], tp);
      const double w = std::log(pp[n - 2] / 500.0) / std::log(pp[n - 2] / pp[n - 1]);
      r.t500 = tp_prev + w * (tp - tp_prev);
    }
  }
  // areas between levels (trapezoids in ln p); LFC: the first level above the LCL where B turns positive
  const size_t n = pp.size();
  if (n < 2) return r;
  size_t lfc = n;
  for (size_t k = 1; k < n; ++k)
    if (b[k] > 0 && pp[k] <= plcl * 1.0001) { lfc = k; break; }
  if (lfc == n) return r;  // no free convection
  // the EL: the last level where B is positive
  size_t el = lfc;
  for (size_t k = lfc; k < n; ++k) if (b[k] > 0) el = k;
  for (size_t k = 1; k < n; ++k) {
    const double area = 0.5 * (b[k - 1] + b[k]) * std::log(pp[k - 1] / pp[k]);
    if (k <= lfc) r.cin += std::min(0.0, area);
    else if (k <= el) r.cape += std::max(0.0, area);
  }
  // the part of the LFC layer above the zero crossing belongs to CAPE
  if (lfc >= 1 && b[lfc - 1] < 0 && b[lfc] > 0) {
    const double f = b[lfc] / (b[lfc] - b[lfc - 1]);  // the fraction of the layer that is positive
    const double dl = std::log(pp[lfc - 1] / pp[lfc]);
    r.cin -= 0.5 * (b[lfc - 1] + b[lfc]) * dl;           // undo the whole layer
    r.cin += 0.5 * b[lfc - 1] * (1.0 - f) * dl;          // negative part
    r.cape += 0.5 * b[lfc] * f * dl;                     // positive part
  }
  return r;
}

// UPP's CALGUST: s10 the 10 m speed, spbl the speed at the PBL top, pblh in metres
inline double gust(double s10, double spbl, double pblh) {
  const double d = std::max(0.0, spbl - s10) * (1.0 - std::min(0.5, pblh / 2000.0));
  return s10 + d;
}

}  // namespace post
