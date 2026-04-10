#pragma once

#include "../amqp/types.h"
#include <algorithm>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

namespace broko::broker {

struct Binding {
    std::string queue_name;
    std::string routing_key;
    amqp::FieldTable arguments;
};

class Exchange {
public:
    std::string name;
    std::string type;
    bool durable = false;
    bool auto_delete = false;
    bool internal = false;
    amqp::FieldTable arguments;

    virtual ~Exchange() = default;

    virtual std::vector<std::string> route(
        const std::string& routing_key,
        const amqp::FieldTable* headers
    ) const = 0;

    void addBinding(const std::string& queue, const std::string& routing_key,
                    const amqp::FieldTable& args) {
        std::lock_guard lock(mu_);
        bindings_.push_back({queue, routing_key, args});
    }

    void removeBinding(const std::string& queue, const std::string& routing_key,
                       const amqp::FieldTable& /*args*/) {
        std::lock_guard lock(mu_);
        std::erase_if(bindings_, [&](const Binding& b) {
            return b.queue_name == queue && b.routing_key == routing_key;
        });
    }

    std::vector<Binding> getBindings() const {
        std::lock_guard lock(mu_);
        return bindings_;
    }

protected:
    mutable std::mutex mu_;
    std::vector<Binding> bindings_;
};

using ExchangePtr = std::shared_ptr<Exchange>;

class DirectExchange : public Exchange {
public:
    std::vector<std::string> route(
        const std::string& routing_key,
        const amqp::FieldTable* /*headers*/
    ) const override {
        std::lock_guard lock(mu_);
        std::vector<std::string> result;
        for (auto& b : bindings_) {
            if (b.routing_key == routing_key)
                result.push_back(b.queue_name);
        }
        return result;
    }
};

class FanoutExchange : public Exchange {
public:
    std::vector<std::string> route(
        const std::string& /*routing_key*/,
        const amqp::FieldTable* /*headers*/
    ) const override {
        std::lock_guard lock(mu_);
        std::vector<std::string> result;
        for (auto& b : bindings_)
            result.push_back(b.queue_name);
        return result;
    }
};

class TopicExchange : public Exchange {
public:
    std::vector<std::string> route(
        const std::string& routing_key,
        const amqp::FieldTable* /*headers*/
    ) const override {
        std::lock_guard lock(mu_);
        std::vector<std::string> result;
        for (auto& b : bindings_) {
            if (topicMatch(b.routing_key, routing_key))
                result.push_back(b.queue_name);
        }
        return result;
    }

private:
    static std::vector<std::string> splitDot(const std::string& s) {
        std::vector<std::string> parts;
        size_t start = 0;
        for (size_t i = 0; i <= s.size(); ++i) {
            if (i == s.size() || s[i] == '.') {
                parts.push_back(s.substr(start, i - start));
                start = i + 1;
            }
        }
        return parts;
    }

    // O(P*K) iterative DP matching
    static bool topicMatch(const std::string& pattern, const std::string& key) {
        auto pat = splitDot(pattern);
        auto kp = splitDot(key);
        size_t P = pat.size(), K = kp.size();

        // dp[j] = "can pat[0..i) match kp[0..j)?"
        std::vector<bool> dp(K + 1, false);
        dp[0] = true;

        for (size_t i = 0; i < P; ++i) {
            if (pat[i] == "#") {
                // # matches zero or more words: dp_new[j] = dp[j] || dp_new[j-1]
                // (propagate left-to-right)
                for (size_t j = 1; j <= K; ++j)
                    dp[j] = dp[j] || dp[j - 1];
            } else {
                // * matches exactly one word, literal matches exactly one word
                // Scan right-to-left to avoid overwriting values we still need
                for (size_t j = K; j >= 1; --j) {
                    dp[j] = dp[j - 1] &&
                            (pat[i] == "*" || pat[i] == kp[j - 1]);
                }
                dp[0] = false;
            }
        }

        return dp[K];
    }
};

class HeadersExchange : public Exchange {
public:
    std::vector<std::string> route(
        const std::string& /*routing_key*/,
        const amqp::FieldTable* headers
    ) const override {
        std::lock_guard lock(mu_);
        if (!headers) return {};
        std::vector<std::string> result;
        for (auto& b : bindings_) {
            if (matchHeaders(b.arguments, *headers))
                result.push_back(b.queue_name);
        }
        return result;
    }

private:
    static bool matchHeaders(const amqp::FieldTable& bindArgs,
                             const amqp::FieldTable& msgHeaders) {
        auto matchIt = bindArgs.find("x-match");
        bool matchAll = true;
        if (matchIt != bindArgs.end() && matchIt->second.string_val == "any")
            matchAll = false;

        for (auto& [name, val] : bindArgs) {
            if (name.starts_with("x-")) continue;
            auto it = msgHeaders.find(name);
            bool found = (it != msgHeaders.end());
            if (matchAll && !found) return false;
            if (!matchAll && found) return true;
        }
        return matchAll;
    }
};

inline ExchangePtr createExchange(const std::string& type) {
    ExchangePtr ex;
    if (type == "direct")       ex = std::make_shared<DirectExchange>();
    else if (type == "fanout")  ex = std::make_shared<FanoutExchange>();
    else if (type == "topic")   ex = std::make_shared<TopicExchange>();
    else if (type == "headers") ex = std::make_shared<HeadersExchange>();
    else                        ex = std::make_shared<DirectExchange>();
    ex->type = type;
    return ex;
}

} // namespace broko::broker
