#pragma once

#include <cstdint>
#include <vector>

namespace broko::amqp {

constexpr uint8_t FRAME_METHOD    = 1;
constexpr uint8_t FRAME_HEADER    = 2;
constexpr uint8_t FRAME_BODY      = 3;
constexpr uint8_t FRAME_HEARTBEAT = 8;
constexpr uint8_t FRAME_END       = 0xCE;

constexpr size_t FRAME_HEADER_SIZE = 7;
constexpr size_t FRAME_END_SIZE    = 1;

constexpr uint8_t PROTOCOL_HEADER[] = {'A', 'M', 'Q', 'P', 0, 0, 9, 1};
constexpr size_t  PROTOCOL_HEADER_SIZE = 8;

struct Frame {
    uint8_t type = 0;
    uint16_t channel = 0;
    std::vector<uint8_t> payload;
};

} // namespace broko::amqp
