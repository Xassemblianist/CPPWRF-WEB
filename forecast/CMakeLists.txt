# SPDX-License-Identifier: GPL-3.0-or-later
# The local forecast server and its post-processor (native, no dependency but NetCDF-C):
#   cmake -S forecast -B build/forecast -G Ninja && cmake --build build/forecast
cmake_minimum_required(VERSION 3.24)
project(CPPWRF_FORECAST LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
if(NOT CMAKE_BUILD_TYPE)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)
endif()
find_path(NETCDF_INCDIR netcdf.h HINTS /usr/include /usr/local/include REQUIRED)
find_library(NETCDF_LIBRARY NAMES netcdf HINTS /usr/lib /usr/lib/x86_64-linux-gnu /usr/local/lib REQUIRED)
find_package(Threads REQUIRED)

add_executable(wrfpost server/wrfpost.cpp)
target_include_directories(wrfpost PRIVATE ${NETCDF_INCDIR})
target_link_libraries(wrfpost PRIVATE ${NETCDF_LIBRARY})
target_compile_options(wrfpost PRIVATE -Wall -Wextra)

add_executable(cppwrf-forecast server/server.cpp)
target_link_libraries(cppwrf-forecast PRIVATE Threads::Threads)
target_compile_options(cppwrf-forecast PRIVATE -Wall -Wextra)
