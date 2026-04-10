#pragma once

#include "../storage/message_store.h"
#include "exchange.h"
#include "queue.h"
#include <atomic>
#include <format>
#include <iostream>
#include <mutex>
#include <random>
#include <string>
#include <unordered_map>
#include <unordered_set>

namespace broko::broker {

class VirtualHost {
public:
    explicit VirtualHost(std::string name, std::shared_ptr<storage::MessageStore> store = nullptr)
        : name_(std::move(name)), store_(std::move(store)) {
        auto defaultEx = std::make_shared<DirectExchange>();
        defaultEx->name = "";
        defaultEx->type = "direct";
        defaultEx->durable = true;
        exchanges_[""] = defaultEx;

        auto directEx = std::make_shared<DirectExchange>();
        directEx->name = "amq.direct";
        directEx->type = "direct";
        directEx->durable = true;
        exchanges_["amq.direct"] = directEx;

        auto fanoutEx = std::make_shared<FanoutExchange>();
        fanoutEx->name = "amq.fanout";
        fanoutEx->type = "fanout";
        fanoutEx->durable = true;
        exchanges_["amq.fanout"] = fanoutEx;

        auto topicEx = std::make_shared<TopicExchange>();
        topicEx->name = "amq.topic";
        topicEx->type = "topic";
        topicEx->durable = true;
        exchanges_["amq.topic"] = topicEx;

        auto headersEx = std::make_shared<HeadersExchange>();
        headersEx->name = "amq.headers";
        headersEx->type = "headers";
        headersEx->durable = true;
        exchanges_["amq.headers"] = headersEx;

        auto matchEx = std::make_shared<HeadersExchange>();
        matchEx->name = "amq.match";
        matchEx->type = "headers";
        matchEx->durable = true;
        exchanges_["amq.match"] = matchEx;
    }

    const std::string& name() const { return name_; }

    // --- Exchange operations ---

    ExchangePtr declareExchange(const std::string& name, const std::string& type,
                                bool passive, bool durable, bool autoDelete,
                                bool internal, const amqp::FieldTable& args,
                                uint16_t& replyCode, std::string& replyText) {
        std::lock_guard lock(mu_);

        auto it = exchanges_.find(name);
        if (passive) {
            if (it == exchanges_.end()) {
                replyCode = 404;
                replyText = "NOT_FOUND - no exchange '" + name + "'";
                return nullptr;
            }
            return it->second;
        }
        if (it != exchanges_.end()) {
            if (it->second->type != type) {
                replyCode = 406;
                replyText = "PRECONDITION_FAILED - exchange type mismatch";
                return nullptr;
            }
            return it->second;
        }
        auto ex = createExchange(type);
        ex->name = name;
        ex->durable = durable;
        ex->auto_delete = autoDelete;
        ex->internal = internal;
        ex->arguments = args;
        exchanges_[name] = ex;
        if (durable && store_)
            store_->storeExchangeDeclare(name, type, durable, autoDelete, internal);
        return ex;
    }

    bool deleteExchange(const std::string& name, bool /*ifUnused*/,
                        uint16_t& replyCode, std::string& replyText) {
        std::lock_guard lock(mu_);
        auto it = exchanges_.find(name);
        if (it == exchanges_.end()) {
            replyCode = 404;
            replyText = "NOT_FOUND - no exchange '" + name + "'";
            return false;
        }
        if (name.starts_with("amq.") || name.empty()) {
            replyCode = 403;
            replyText = "ACCESS_REFUSED - cannot delete default exchange";
            return false;
        }
        exchanges_.erase(it);
        if (store_) store_->storeExchangeDelete(name);
        return true;
    }

    ExchangePtr findExchange(const std::string& name) {
        std::lock_guard lock(mu_);
        auto it = exchanges_.find(name);
        return (it != exchanges_.end()) ? it->second : nullptr;
    }

    // --- Queue operations ---

    struct QueueDeclareResult {
        MessageQueuePtr queue;
        bool created = false;
    };

    QueueDeclareResult declareQueue(const std::string& name, bool passive,
                                    bool durable, bool exclusive, bool autoDelete,
                                    const amqp::FieldTable& args,
                                    uint32_t connectionId,
                                    uint16_t& replyCode, std::string& replyText) {
        std::lock_guard lock(mu_);

        std::string qname = name;
        if (qname.empty()) {
            qname = generateQueueName();
        }

        auto it = queues_.find(qname);
        if (passive) {
            if (it == queues_.end()) {
                replyCode = 404;
                replyText = "NOT_FOUND - no queue '" + qname + "'";
                return {};
            }
            return {it->second, false};
        }
        if (it != queues_.end()) {
            auto& q = it->second;
            if (q->exclusive && q->owner_connection != connectionId) {
                replyCode = 405;
                replyText = "RESOURCE_LOCKED - queue '" + qname + "' is exclusive";
                return {};
            }
            return {q, false};
        }

        auto q = std::make_shared<MessageQueue>(qname);
        q->durable = durable;
        q->exclusive = exclusive;
        q->auto_delete = autoDelete;
        q->arguments = args;
        q->owner_connection = exclusive ? connectionId : 0;
        q->configure();
        setupDeadLetterHandler(q);
        queues_[qname] = q;

        // Auto-bind to default exchange
        if (auto defEx = exchanges_.find(""); defEx != exchanges_.end()) {
            defEx->second->addBinding(qname, qname, {});
        }

        if (durable && store_)
            store_->storeQueueDeclare(qname, durable, autoDelete);
        return {q, true};
    }

    bool deleteQueue(const std::string& name, bool ifUnused, bool ifEmpty,
                     uint32_t& messageCount,
                     uint16_t& replyCode, std::string& replyText) {
        std::lock_guard lock(mu_);
        auto it = queues_.find(name);
        if (it == queues_.end()) {
            replyCode = 404;
            replyText = "NOT_FOUND - no queue '" + name + "'";
            return false;
        }
        auto& q = it->second;
        if (ifUnused && q->consumerCount() > 0) {
            replyCode = 406;
            replyText = "PRECONDITION_FAILED - queue in use";
            return false;
        }
        if (ifEmpty && q->messageCount() > 0) {
            replyCode = 406;
            replyText = "PRECONDITION_FAILED - queue not empty";
            return false;
        }
        messageCount = q->messageCount();
        // Remove bindings from all exchanges
        for (auto& [_, ex] : exchanges_) {
            for (auto& b : ex->getBindings()) {
                if (b.queue_name == name)
                    ex->removeBinding(name, b.routing_key, b.arguments);
            }
        }
        queues_.erase(it);
        if (store_) store_->storeQueueDelete(name);
        return true;
    }

    MessageQueuePtr findQueue(const std::string& name) {
        std::lock_guard lock(mu_);
        auto it = queues_.find(name);
        return (it != queues_.end()) ? it->second : nullptr;
    }

    // --- Binding operations ---

    bool bindQueue(const std::string& queue, const std::string& exchange,
                   const std::string& routingKey, const amqp::FieldTable& args,
                   uint16_t& replyCode, std::string& replyText) {
        std::lock_guard lock(mu_);
        auto exIt = exchanges_.find(exchange);
        if (exIt == exchanges_.end()) {
            replyCode = 404;
            replyText = "NOT_FOUND - no exchange '" + exchange + "'";
            return false;
        }
        auto qIt = queues_.find(queue);
        if (qIt == queues_.end()) {
            replyCode = 404;
            replyText = "NOT_FOUND - no queue '" + queue + "'";
            return false;
        }
        exIt->second->addBinding(queue, routingKey, args);
        if (store_) store_->storeBinding(queue, exchange, routingKey);
        return true;
    }

    bool unbindQueue(const std::string& queue, const std::string& exchange,
                     const std::string& routingKey, const amqp::FieldTable& args,
                     uint16_t& replyCode, std::string& replyText) {
        std::lock_guard lock(mu_);
        auto exIt = exchanges_.find(exchange);
        if (exIt == exchanges_.end()) {
            replyCode = 404;
            replyText = "NOT_FOUND - no exchange '" + exchange + "'";
            return false;
        }
        exIt->second->removeBinding(queue, routingKey, args);
        if (store_) store_->storeUnbind(queue, exchange, routingKey);
        return true;
    }

    std::shared_ptr<storage::MessageStore> store() const { return store_; }

    // --- Publish ---

    std::vector<std::string> routeMessage(const std::string& exchangeName,
                                          const std::string& routingKey,
                                          const amqp::FieldTable* headers) {
        ExchangePtr ex;
        {
            std::lock_guard lock(mu_);
            auto it = exchanges_.find(exchangeName);
            if (it == exchanges_.end()) return {};
            ex = it->second;
        }
        auto result = ex->route(routingKey, headers);
        // Deduplicate queue names
        std::unordered_set<std::string> seen;
        std::erase_if(result, [&seen](const std::string& q) {
            return !seen.insert(q).second;
        });
        return result;
    }

    void deliverToQueue(const std::string& queueName, MessagePtr msg) {
        MessageQueuePtr q;
        {
            std::lock_guard lock(mu_);
            auto it = queues_.find(queueName);
            if (it == queues_.end()) return;
            q = it->second;
        }
        q->enqueue(std::move(msg));
    }

    // Periodic maintenance: expire TTL messages, trigger dead-lettering
    void tick() {
        std::vector<MessageQueuePtr> queuesCopy;
        {
            std::lock_guard lock(mu_);
            queuesCopy.reserve(queues_.size());
            for (auto& [_, q] : queues_)
                queuesCopy.push_back(q);
        }
        for (auto& q : queuesCopy)
            q->flush();
    }

    // Cleanup exclusive queues for a disconnected connection
    void removeConnectionQueues(uint32_t connectionId) {
        // Phase 1: snapshot queue pointers and identify exclusive queues to remove
        std::vector<std::string> toRemove;
        std::vector<MessageQueuePtr> nonExclusive;
        {
            std::lock_guard lock(mu_);
            for (auto& [name, q] : queues_) {
                if (q->exclusive && q->owner_connection == connectionId)
                    toRemove.push_back(name);
                else
                    nonExclusive.push_back(q);
            }
        }

        // Phase 2: remove consumers without holding vhost mu_ (avoids lock ordering issue)
        for (auto& q : nonExclusive)
            q->removeConsumersByConnection(connectionId);

        // Phase 3: reacquire mu_ for deletions
        {
            std::lock_guard lock(mu_);
            for (auto& name : toRemove) {
                for (auto& [_, ex] : exchanges_) {
                    for (auto& b : ex->getBindings()) {
                        if (b.queue_name == name)
                            ex->removeBinding(name, b.routing_key, b.arguments);
                    }
                }
                queues_.erase(name);
            }
            // Auto-delete queues with no consumers
            std::vector<std::string> autoDeleteRemove;
            for (auto& [name, q] : queues_) {
                if (q->auto_delete && q->consumerCount() == 0)
                    autoDeleteRemove.push_back(name);
            }
            for (auto& name : autoDeleteRemove)
                queues_.erase(name);
        }
    }

    void recoverFromStore() {
        if (!store_) return;
        auto data = store_->recover();

        for (auto& ed : data.exchanges) {
            if (exchanges_.count(ed.name)) continue;
            auto ex = createExchange(ed.type);
            ex->name = ed.name;
            ex->durable = ed.durable;
            ex->auto_delete = ed.auto_delete;
            ex->internal = ed.internal;
            exchanges_[ed.name] = ex;
        }
        for (auto& qd : data.queues) {
            if (queues_.count(qd.name)) continue;
            auto q = std::make_shared<MessageQueue>(qd.name);
            q->durable = qd.durable;
            q->auto_delete = qd.auto_delete;
            queues_[qd.name] = q;
            // Auto-bind to default exchange
            if (auto defEx = exchanges_.find(""); defEx != exchanges_.end())
                defEx->second->addBinding(qd.name, qd.name, {});
        }
        for (auto& sb : data.bindings) {
            if (auto exIt = exchanges_.find(sb.exchange); exIt != exchanges_.end())
                exIt->second->addBinding(sb.queue, sb.routing_key, {});
        }
        for (auto& sm : data.messages) {
            if (auto qIt = queues_.find(sm.queue_name); qIt != queues_.end()) {
                auto msg = std::make_shared<Message>();
                msg->exchange = sm.exchange;
                msg->routing_key = sm.routing_key;
                msg->properties = sm.properties;
                msg->body = sm.body;
                msg->wal_id = sm.id;
                qIt->second->enqueue(std::move(msg));
            }
        }
        std::cerr << std::format("Recovered {} exchanges, {} queues, {} bindings, {} messages\n",
            data.exchanges.size(), data.queues.size(),
            data.bindings.size(), data.messages.size());
    }

    void setupDeadLetterHandler(MessageQueuePtr& q) {
        q->setDeadLetterHandler([this](const std::string& exchange,
                                        const std::string& routingKey,
                                        MessagePtr msg) {
            auto queues = routeMessage(exchange, routingKey,
                msg->properties.headers ? &*msg->properties.headers : nullptr);
            for (auto& qname : queues)
                deliverToQueue(qname, msg);
        });
    }

private:
    std::string name_;
    std::shared_ptr<storage::MessageStore> store_;
    mutable std::mutex mu_;
    std::unordered_map<std::string, ExchangePtr> exchanges_;
    std::unordered_map<std::string, MessageQueuePtr> queues_;

    std::string generateQueueName() {
        static std::atomic<uint64_t> counter{0};
        return "amq.gen-" + std::to_string(++counter);
    }
};

using VirtualHostPtr = std::shared_ptr<VirtualHost>;

} // namespace broko::broker
