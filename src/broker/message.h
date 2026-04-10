#pragma once

#include "../amqp/content.h"
#include <chrono>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace broko::broker {

struct Message {
    std::string exchange;
    std::string routing_key;
    bool mandatory = false;
    bool immediate = false;

    amqp::BasicProperties properties;
    std::vector<uint8_t> body;

    bool redelivered = false;
    std::chrono::steady_clock::time_point enqueued_at;
    uint64_t wal_id = 0;
    uint32_t source_connection_id = 0;
    uint32_t dlx_hops = 0;

    bool isPersistent() const {
        return properties.delivery_mode.has_value() && *properties.delivery_mode == 2;
    }

    uint8_t effectivePriority() const {
        return properties.priority.value_or(0);
    }
};

using MessagePtr = std::shared_ptr<Message>;

} // namespace broko::broker
