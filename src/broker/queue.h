#pragma once

#include "consumer.h"
#include "message.h"
#include <algorithm>
#include <chrono>
#include <cstdint>
#include <deque>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <unordered_map>
#include <vector>

namespace broko::broker {

using DeadLetterFn = std::function<void(const std::string&, const std::string&, MessagePtr)>;

class MessageQueue {
public:
    std::string name;
    bool durable = false;
    bool exclusive = false;
    bool auto_delete = false;
    amqp::FieldTable arguments;
    uint32_t owner_connection = 0;

    explicit MessageQueue(std::string qname) : name(std::move(qname)) {}

    void configure() {
        if (auto it = arguments.find("x-message-ttl"); it != arguments.end())
            queueTtlMs_ = static_cast<int64_t>(it->second.int_val);
        if (auto it = arguments.find("x-max-priority"); it != arguments.end())
            maxPriority_ = static_cast<uint8_t>(std::min(int64_t(255), it->second.int_val));
        if (auto it = arguments.find("x-dead-letter-exchange"); it != arguments.end())
            dlxExchange_ = it->second.string_val;
        if (auto it = arguments.find("x-dead-letter-routing-key"); it != arguments.end())
            dlxRoutingKey_ = it->second.string_val;
    }

    void setDeadLetterHandler(DeadLetterFn fn) { deadLetterFn_ = std::move(fn); }

    uint32_t messageCount() const {
        std::lock_guard lock(mu_);
        return static_cast<uint32_t>(messages_.size());
    }

    uint32_t consumerCount() const {
        std::lock_guard lock(mu_);
        return static_cast<uint32_t>(consumers_.size());
    }

    void enqueue(MessagePtr msg) {
        std::vector<std::pair<MessagePtr, std::string>> dlq;
        {
            std::lock_guard lock(mu_);
            msg->enqueued_at = std::chrono::steady_clock::now();
            messages_.push_back(std::move(msg));

            if (maxPriority_ > 0) {
                std::stable_sort(messages_.begin(), messages_.end(),
                    [](const MessagePtr& a, const MessagePtr& b) {
                        return a->effectivePriority() > b->effectivePriority();
                    });
            }

            collectExpired(dlq);
            dispatchLocked();
        }
        deliverDeadLetters(dlq);
    }

    void addConsumer(ConsumerPtr consumer) {
        std::lock_guard lock(mu_);
        consumers_.push_back(std::move(consumer));
        dispatchLocked();
    }

    bool removeConsumer(const std::string& tag) {
        std::lock_guard lock(mu_);
        auto it = std::find_if(consumers_.begin(), consumers_.end(),
            [&](const ConsumerPtr& c) { return c->tag == tag; });
        if (it == consumers_.end()) return false;
        (*it)->on_deliver = nullptr;
        consumers_.erase(it);
        return true;
    }

    void removeConsumersByConnection(uint32_t connId) {
        std::lock_guard lock(mu_);
        for (auto& c : consumers_) {
            if (c->connection_id == connId)
                c->on_deliver = nullptr;
        }
        std::erase_if(consumers_, [connId](const ConsumerPtr& c) {
            return c->connection_id == connId;
        });
    }

    MessagePtr get() {
        std::vector<std::pair<MessagePtr, std::string>> dlq;
        MessagePtr result;
        {
            std::lock_guard lock(mu_);
            collectExpired(dlq);
            if (!messages_.empty()) {
                result = std::move(messages_.front());
                messages_.pop_front();
            }
        }
        deliverDeadLetters(dlq);
        return result;
    }

    uint32_t purge() {
        std::lock_guard lock(mu_);
        auto count = static_cast<uint32_t>(messages_.size());
        messages_.clear();
        return count;
    }

    void ack(uint64_t /*deliveryTag*/) {}

    void reject(uint64_t /*deliveryTag*/, bool requeue, MessagePtr msg) {
        if (!msg) return;
        if (requeue) {
            std::lock_guard lock(mu_);
            msg->redelivered = true;
            messages_.push_front(std::move(msg));
            dispatchLocked();
        } else {
            deadLetter(std::move(msg), "rejected");
        }
    }

    void flush() {
        std::vector<std::pair<MessagePtr, std::string>> dlq;
        {
            std::lock_guard lock(mu_);
            collectExpired(dlq);
            dispatchLocked();
        }
        deliverDeadLetters(dlq);
    }

private:
    mutable std::mutex mu_;
    std::deque<MessagePtr> messages_;
    std::vector<ConsumerPtr> consumers_;
    size_t roundRobinIdx_ = 0;

    int64_t queueTtlMs_ = -1;
    uint8_t maxPriority_ = 0;
    std::string dlxExchange_;
    std::string dlxRoutingKey_;
    DeadLetterFn deadLetterFn_;

    void collectExpired(std::vector<std::pair<MessagePtr, std::string>>& dlq) {
        if (queueTtlMs_ < 0 && !hasPerMessageTtl()) return;

        auto now = std::chrono::steady_clock::now();
        while (!messages_.empty()) {
            auto& msg = messages_.front();
            int64_t ttl = effectiveTtl(msg);
            if (ttl < 0) break;

            auto age = std::chrono::duration_cast<std::chrono::milliseconds>(
                now - msg->enqueued_at).count();
            if (age < ttl) break;

            auto expired = std::move(messages_.front());
            messages_.pop_front();
            dlq.emplace_back(std::move(expired), "expired");
        }
    }

    bool hasPerMessageTtl() const {
        for (auto& msg : messages_) {
            if (msg->properties.expiration.has_value())
                return true;
        }
        return false;
    }

    int64_t effectiveTtl(const MessagePtr& msg) const {
        int64_t perMsg = -1;
        if (msg->properties.expiration.has_value()) {
            try { perMsg = std::stoll(*msg->properties.expiration); }
            catch (...) {}
        }
        if (perMsg >= 0 && queueTtlMs_ >= 0) return std::min(perMsg, queueTtlMs_);
        if (perMsg >= 0) return perMsg;
        return queueTtlMs_;
    }

    static constexpr uint32_t MAX_DLX_HOPS = 20;

    void deadLetter(MessagePtr msg, const std::string& reason) {
        if (dlxExchange_.empty() || !deadLetterFn_) return;
        if (++msg->dlx_hops > MAX_DLX_HOPS) return;

        if (!msg->properties.headers) msg->properties.headers = amqp::FieldTable{};
        (*msg->properties.headers)["x-first-death-reason"] = amqp::FieldValue::longString(reason);
        (*msg->properties.headers)["x-first-death-queue"] = amqp::FieldValue::longString(name);
        (*msg->properties.headers)["x-first-death-exchange"] = amqp::FieldValue::longString(msg->exchange);

        std::string rk = dlxRoutingKey_.empty() ? msg->routing_key : dlxRoutingKey_;
        deadLetterFn_(dlxExchange_, rk, std::move(msg));
    }

    void deliverDeadLetters(std::vector<std::pair<MessagePtr, std::string>>& dlq) {
        for (auto& [msg, reason] : dlq)
            deadLetter(std::move(msg), reason);
    }

    void dispatchLocked() {
        if (consumers_.empty()) return;

        while (!messages_.empty()) {
            size_t attempts = consumers_.size();
            bool delivered = false;

            for (size_t i = 0; i < attempts; ++i) {
                auto& consumer = consumers_[roundRobinIdx_ % consumers_.size()];
                roundRobinIdx_++;

                if (!consumer->on_deliver)
                    continue;

                if (consumer->prefetch_count > 0 &&
                    consumer->in_flight.load(std::memory_order_relaxed) >= consumer->prefetch_count)
                    continue;

                auto& msg = messages_.front();

                if (consumer->no_local &&
                    msg->source_connection_id == consumer->connection_id)
                    continue;

                auto taken = std::move(messages_.front());
                messages_.pop_front();

                if (!consumer->no_ack)
                    consumer->in_flight.fetch_add(1, std::memory_order_relaxed);

                consumer->on_deliver(
                    consumer->tag, 0, taken->redelivered,
                    taken->exchange, taken->routing_key,
                    taken->properties, taken->body
                );
                delivered = true;
                break;
            }

            if (!delivered) break;
        }
    }
};

using MessageQueuePtr = std::shared_ptr<MessageQueue>;

} // namespace broko::broker
