cmake_minimum_required(VERSION 3.16)
project(Broko CXX)

set(CMAKE_CXX_STANDARD 23)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(ENABLE_SANITIZERS "Enable ASan + UBSan" OFF)

find_package(Boost REQUIRED)
find_package(Threads REQUIRED)

set(SOURCES
    src/main.cpp
    src/broker/channel.cpp
    src/broker/connection.cpp
    src/broker/server.cpp
)

add_executable(${PROJECT_NAME} ${SOURCES})

target_include_directories(${PROJECT_NAME} PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/src
)

target_link_libraries(${PROJECT_NAME} PRIVATE
    Boost::headers
    Threads::Threads
)

target_compile_options(${PROJECT_NAME} PRIVATE -Wall -Wextra -Wpedantic -O2)

if(ENABLE_SANITIZERS)
    target_compile_options(${PROJECT_NAME} PRIVATE -fsanitize=address,undefined -fno-omit-frame-pointer)
    target_link_options(${PROJECT_NAME} PRIVATE -fsanitize=address,undefined)
endif()
