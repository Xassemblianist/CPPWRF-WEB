# SPDX-License-Identifier: GPL-3.0-or-later
# CPPWRF-Web: the CPU FP64 model of third_party/CPPWRF built for WebAssembly with Emscripten, single-threaded.
#
#   emcmake cmake -S wasm -B build/wasm -G Ninja -DNETCDF_WASM=build/deps/netcdf-wasm
#   cmake --build build/wasm
#
# The sources and compile definitions are those of CPPWRF's own CPU FP64 build (third_party/CPPWRF/CMakeLists.txt,
# v1.0.0: cppwrf_core + cppwrf_io + cppwrf_io_netcdf + cppwrf_wrfio), with three differences, none of which changes
# an operation of the model:
#   - CPPWRF_GLIBC_MATH: the double math functions are CPPWRF's port of glibc's libm and libmvec
#     (src/core/glibc_math.hpp, libmvec_x86.hpp), which the CUDA FP64 build uses; natively the CPU build calls glibc
#     itself. Emscripten's libm (musl) gives other bits (tests/math_bits.cpp).
#   - no OpenMP (one thread; the pragmas are ignored, the omp_* calls are behind _OPENMP), no libmvec (x86-64 only).
#   - NetCDF-C 4.9.3 built for wasm32 without NetCDF-4/HDF5 (tools/build_netcdf_wasm.sh): wrfout is NetCDF classic
#     (use_netcdf_classic = .true. in the case's namelist.input), as natively.
cmake_minimum_required(VERSION 3.24)
project(CPPWRF_WEB LANGUAGES C CXX)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "configure with emcmake (Emscripten)")
endif()
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
set(CMAKE_CXX_FLAGS_RELEASE "-O3")

set(CPPWRF_DIR ${CMAKE_CURRENT_SOURCE_DIR}/../third_party/CPPWRF CACHE PATH "CPPWRF source tree (the submodule)")
get_filename_component(CPPWRF_DIR ${CPPWRF_DIR} REALPATH)
set(NETCDF_WASM "" CACHE PATH "NetCDF-C installed for wasm32 (tools/build_netcdf_wasm.sh)")
if(NOT EXISTS ${NETCDF_WASM}/lib/libnetcdf.a)
  message(FATAL_ERROR "NETCDF_WASM: no lib/libnetcdf.a in '${NETCDF_WASM}'")
endif()

# strict IEEE, as CPPWRF's CMakeLists: no FMA contraction, no fast-math; exceptions as wasm exceptions
add_compile_options(-ffp-contract=off -fwasm-exceptions)
string(TOUPPER "${CMAKE_BUILD_TYPE}" _bt)
if("${CMAKE_CXX_FLAGS} ${CMAKE_CXX_FLAGS_${_bt}}" MATCHES
   "(-Ofast|-f(fast-math|unsafe-math-optimizations|associative-math|reciprocal-math|finite-math-only)|-ffp-contract=(fast|on)|-mrelaxed-simd)")
  message(FATAL_ERROR "CMAKE_CXX_FLAGS: '${CMAKE_MATCH_1}' changes the floating-point results")
endif()

set(S ${CPPWRF_DIR}/src)
file(GLOB CORE_SOURCES CONFIGURE_DEPENDS ${S}/core/*.cpp ${S}/dyn/*.cpp ${S}/cases/*.cpp)
# the column physics of cppwrf_core (CPPWRF CMakeLists.txt, CPPWRF_SOURCES)
foreach(f driver/suite driver/surface_driver driver/pbl_driver driver/cumulus_driver driver/fdda_driver
          driver/phy_prep driver/tendency_coupling driver/landuse_tables driver/radiation
          ra_rrtmg_lw/rrtmg_lw ra_rrtmg_lw/rrtmg_lw_batch ra_rrtmg_lw/rrtmg_lw_tables
          ra_rrtmg_sw/rrtmg_sw ra_rrtmg_sw/rrtmg_sw_batch ra_rrtmg_sw/rrtmg_sw_tables
          ra_rrtmg_common/cam_gases ra_rrtmg_common/cam_ozone ra_rrtmg_common/batch_memory
          ra_rrtm_lw/rrtm_lw ra_rrtm_lw/rrtm_lw_tables sf_sfclayrev/sfclayrev sf_myjsfc/myjsfc bl_ysu/ysu
          bl_myj/myjpbl lsm_noah/noah lsm_noah/noah_tables lsm_noahmp/noahmp lsm_noahmp/noahmp_tables cu_kf/kf
          cu_kf/kf_tables mp_thompson/thompson mp_thompson/thompson_tables mp_morrison/morrison)
  list(APPEND CORE_SOURCES ${S}/phys/${f}.cpp)
endforeach()
list(APPEND CORE_SOURCES
  ${S}/io/config.cpp ${S}/io/output.cpp
  ${S}/io_netcdf/restart.cpp ${S}/io_netcdf/wrf_readers.cpp
  ${S}/wrf_io/namelist.cpp ${S}/wrf_io/nc_out.cpp ${S}/wrf_io/nc_deflate.cpp ${S}/wrf_io/wrf_schema.cpp
  ${S}/wrf_io/global_atts.cpp ${S}/wrf_io/stream_file.cpp)

# the configuration keys (CPPWRF CMakeLists.txt: src/cases/config_keys.cmake)
file(GLOB_RECURSE KEY_SOURCES CONFIGURE_DEPENDS ${S}/*.cpp ${S}/*.hpp ${S}/*.cu)
add_custom_command(OUTPUT ${CMAKE_BINARY_DIR}/generated/config_keys.inc
  COMMAND ${CMAKE_COMMAND} -DROOT=${S} -DOUT=${CMAKE_BINARY_DIR}/generated/config_keys.inc
          -P ${S}/cases/config_keys.cmake
  DEPENDS ${KEY_SOURCES} ${S}/cases/config_keys.cmake VERBATIM)

# the commit of the submodule (CPPWRF's restart files record it)
execute_process(COMMAND git -C ${CPPWRF_DIR} rev-parse HEAD OUTPUT_VARIABLE CPPWRF_COMMIT
                RESULT_VARIABLE _rc ERROR_QUIET OUTPUT_STRIP_TRAILING_WHITESPACE)
if(NOT _rc EQUAL 0)
  set(CPPWRF_COMMIT "unknown")
endif()
message(STATUS "CPPWRF commit: ${CPPWRF_COMMIT}")
set_property(SOURCE ${S}/cases/domain_runner.cpp APPEND PROPERTY COMPILE_DEFINITIONS CPPWRF_COMMIT="${CPPWRF_COMMIT}")

add_library(cppwrf_core STATIC ${CORE_SOURCES} ${CMAKE_BINARY_DIR}/generated/config_keys.inc)
target_include_directories(cppwrf_core PUBLIC ${S} ${NETCDF_WASM}/include PRIVATE ${CMAKE_BINARY_DIR}/generated)
# the data files are embedded at /cppwrf/data (the link options below)
target_compile_definitions(cppwrf_core PRIVATE CPPWRF_DATA_DIR="/cppwrf/data")
target_compile_definitions(cppwrf_core PUBLIC CPPWRF_DOUBLE CPPWRF_HAVE_NETCDF CPPWRF_HAVE_SMALL_STEP CPPWRF_GLIBC_MATH=1)
target_compile_options(cppwrf_core PRIVATE -sUSE_ZLIB=1)
target_link_libraries(cppwrf_core PUBLIC ${NETCDF_WASM}/lib/libnetcdf.a)

set(WEB_LINK -fwasm-exceptions -sUSE_ZLIB=1 -sALLOW_MEMORY_GROWTH=1 -sMAXIMUM_MEMORY=4GB -sSTACK_SIZE=8MB
    -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXIT_RUNTIME=0 -sINVOKE_RUN=0
    -sEXPORTED_RUNTIME_METHODS=FS,ccall,cwrap,HEAP32,HEAPF64,UTF8ToString
    "--embed-file=${CPPWRF_DIR}/data/wrf_schema@/cppwrf/data/wrf_schema")

# the model as the browser and node drive it (wasm/cppwrf_web.cpp: init, step, fields, finish)
add_executable(cppwrf_web ${CMAKE_CURRENT_SOURCE_DIR}/cppwrf_web.cpp)
target_link_libraries(cppwrf_web PRIVATE cppwrf_core)
target_link_options(cppwrf_web PRIVATE ${WEB_LINK} -sENVIRONMENT=web,worker,node -sEXPORT_NAME=CppwrfWeb
    "-sEXPORTED_FUNCTIONS=_main,_web_init,_web_step,_web_nsteps,_web_step_now,_web_nx,_web_nz,_web_field,_web_finish,_web_error,_web_peak_bytes,_malloc,_free")
set_target_properties(cppwrf_web PROPERTIES SUFFIX ".mjs")

# the math check (tests/math_bits.cpp), for node
add_executable(math_bits ${CMAKE_CURRENT_SOURCE_DIR}/../tests/math_bits.cpp)
target_compile_definitions(math_bits PRIVATE CPPWRF_GLIBC_MATH=1)
target_include_directories(math_bits PRIVATE ${S})
target_link_options(math_bits PRIVATE -sENVIRONMENT=node -sALLOW_MEMORY_GROWTH=1)
