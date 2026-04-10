#pragma once

#include "message.h"
#include <atomic>
#include <cstdint>
#include <functional>
#include <string>

namespace broko::broker {

using DeliverCallback = std::function<void(
    const std::string& consumer_tag,
    uint64_t delivery_tag,
    bool redelivered,
    const std::string& exchange,
    const std::string& routing_key,
    const amqp::BasicProperties& properties,
    const std::vector<uint8_t>& body
)>;

struct Consumer {
    std::string tag;
    std::string queue_name;
    bool no_local = false;
    bool no_ack = false;
    bool exclusive = false;
    uint16_t channel_id = 0;
    uint32_t connection_id = 0;
    uint16_t prefetch_count = 0;
    std::atomic<uint32_t> in_flight{0};
    DeliverCallback on_deliver;
};

using ConsumerPtr = std::shared_ptr<Consumer>;

} // namespace broko::broker
