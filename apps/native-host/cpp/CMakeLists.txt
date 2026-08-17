cmake_minimum_required(VERSION 3.24)
project(nnit_native_audio_host LANGUAGES CXX)
set(CMAKE_CXX_STANDARD 20)
add_executable(nnit_native_audio_host main.cpp)
# VST3/ASIO integration deliberately requires vendor SDKs:
# target_include_directories(... Steinberg VST3 SDK / ASIO SDK ...)
