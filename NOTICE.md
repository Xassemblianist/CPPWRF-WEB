# Notices

CPPWRF-Web: the CPPWRF model in a web browser through WebAssembly.
Copyright (C) 2026 Ömer Kaan Yılmaz (Xassemblianist)

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of the
License, or (at your option) any later version.

This program is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without
even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the GNU
General Public License for more details. You should have received a copy of the GNU General
Public License along with this program (file LICENSE). If not, see <https://www.gnu.org/licenses/>.

Every source file carries the tag `SPDX-License-Identifier: GPL-3.0-or-later`.

## CPPWRF

The model compiled into `cppwrf_web.wasm` is CPPWRF v1.0.0 (third_party/CPPWRF, a git submodule of
https://github.com/Xassemblianist/CPPWRF), GPL-3.0-or-later, Copyright (C) 2026 Ömer Kaan Yılmaz (Xassemblianist).
Its NOTICE.md applies to the compiled model and is reproduced in part here.

## WRF

CPPWRF is a statement-by-statement port of the Weather Research and Forecasting (WRF) model v4.8.0. The files
`cases/em_squall2d_x/input_sounding` and `cases/em_squall2d_x/namelist.input` are WRF v4.8.0's
`test/em_squall2d_x` files (the namelist with `mp_physics = 1` and `use_netcdf_classic = .true.`).

The WRF notice, as requested by UCAR:

> WRF was developed at the National Center for Atmospheric Research (NCAR) which is operated by
> the University Corporation for Atmospheric Research (UCAR). NCAR and UCAR make no proprietary
> claims, either statutory or otherwise, to this version and release of WRF and consider WRF to
> be in the public domain for use by any person or entity for any purpose without any fee or
> charge. UCAR requests that any WRF user include this notice on any partial or full copies of
> WRF. WRF is provided on an "AS IS" basis and any warranties, either express or implied,
> including but not limited to implied warranties of non-infringement, originality,
> merchantability and fitness for a particular purpose, are disclaimed. In no event shall UCAR
> be liable for any damages, whatsoever, whether direct, indirect, consequential or special,
> that arise out of or in connection with the access, use or performance of WRF, including
> infringement actions.

WRF® is a registered trademark of the University Corporation for Atmospheric Research (UCAR). CPPWRF and
CPPWRF-Web are independent projects and are not affiliated with or endorsed by NCAR or UCAR.

## Schemes inside WRF with their own terms

The compiled model contains CPPWRF's ports of RRTMG and RRTM (Atmospheric & Environmental Research, Inc.) and of
Noah-MP (UCAR); their notices are in third_party/CPPWRF/NOTICE.md and third_party/CPPWRF/licenses/. The
em_squall2d_x case does not run them.

> Copyright 2002-2008, Atmospheric & Environmental Research, Inc. (AER).
> This software may be used, copied, or redistributed as long as it is
> not sold and this copyright notice is reproduced on each copy made.
> This model is provided as is without any express or implied warranties.
> (http://www.rtweb.aer.com/)

> The source of this material is the Research Applications Laboratory at the National Center for Atmospheric
> Research, a program of the University Corporation for Atmospheric Research (UCAR) pursuant to a Cooperative
> Agreement with the National Science Foundation; ©2007 University Corporation for Atmospheric Research. All
> Rights Reserved.

## GNU C Library

CPPWRF's `src/core/glibc_math.hpp`, `glibc_math_tables.hpp`, `libmvec_x86.hpp` and `libmvec_tables.hpp` port
algorithms and tables of the GNU C Library 2.41 (libm and libmvec); the wasm build uses them for every double
math function. The GNU C Library is Copyright (C) the Free Software Foundation, Inc. and its contributors, licensed
under the GNU Lesser General Public License, version 2.1 or later, whose section 3 allows these parts to be
distributed under the GNU General Public License.

## Libraries linked into the wasm module

- NetCDF-C 4.9.3 (Unidata, UCAR; BSD-3-Clause licence), built without NetCDF-4/HDF5 by tools/build_netcdf_wasm.sh.
- zlib (Jean-loup Gailly and Mark Adler; zlib licence), Emscripten's port.
- Emscripten's runtime and system libraries (musl libc, libc++, libc++abi; MIT / University of Illinois NCSA
  licences).
