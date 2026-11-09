// SPDX-License-Identifier: GPL-3.0-or-later
// The relative L2 difference ||A - B|| / ||B|| and the largest absolute difference of variables of two wrfout files
// (any NetCDF format), for the FP32 against FP64 check of tools/e2e.sh.
//   ncdiff A.nc B.nc [VAR ...]      (default: U V W T PH QVAPOR MU PSFC T2 U10 V10 RAINNC)
// Prints one line per variable: name, relative L2, max |A - B|, max |B|. Exit 1 if a variable is missing in either.
#include <netcdf.h>

#include <cmath>
#include <cstdio>
#include <string>
#include <vector>

static bool read(int nc, const std::string& name, std::vector<double>& out) {
  int id;
  if (nc_inq_varid(nc, name.c_str(), &id) != NC_NOERR) return false;
  int nd;
  int dims[NC_MAX_VAR_DIMS];
  nc_inq_varndims(nc, id, &nd);
  nc_inq_vardimid(nc, id, dims);
  size_t n = 1;
  for (int k = 0; k < nd; ++k) {
    size_t len;
    nc_inq_dimlen(nc, dims[k], &len);
    n *= len;
  }
  out.resize(n);
  return nc_get_var_double(nc, id, out.data()) == NC_NOERR;
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: ncdiff A.nc B.nc [VAR ...]\n");
    return 2;
  }
  std::vector<std::string> vars;
  for (int k = 3; k < argc; ++k) vars.push_back(argv[k]);
  if (vars.empty()) vars = {"U", "V", "W", "T", "PH", "QVAPOR", "MU", "PSFC", "T2", "U10", "V10", "RAINNC"};
  int a, b;
  if (nc_open(argv[1], NC_NOWRITE, &a) != NC_NOERR || nc_open(argv[2], NC_NOWRITE, &b) != NC_NOERR) {
    std::fprintf(stderr, "ncdiff: cannot open the files\n");
    return 2;
  }
  int bad = 0;
  for (const auto& v : vars) {
    std::vector<double> x, y;
    if (!read(a, v, x) || !read(b, v, y) || x.size() != y.size()) {
      std::printf("%-8s missing or different shape\n", v.c_str());
      bad = 1;
      continue;
    }
    double num = 0, den = 0, mx = 0, mb = 0;
    for (size_t k = 0; k < x.size(); ++k) {
      const double d = x[k] - y[k];
      num += d * d;
      den += y[k] * y[k];
      mx = std::max(mx, std::fabs(d));
      mb = std::max(mb, std::fabs(y[k]));
    }
    std::printf("%-8s %.3e %.3e %.3e\n", v.c_str(), den > 0 ? std::sqrt(num / den) : std::sqrt(num), mx, mb);
  }
  nc_close(a);
  nc_close(b);
  return bad;
}
