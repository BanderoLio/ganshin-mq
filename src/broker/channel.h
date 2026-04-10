#pragma once

#include "../amqp/content.h"
#include "../amqp/frame.h"
#include "../amqp/methods.h"
#include "../amqp/types.h"
#include "consumer.h"
#include "message.h"
#include "vhost.h"
#include <cstdint>
#include <functional>
#include <memory>
#include <string>
#include <unordered_map>
#include <vector>

namespace broko::broker {

using SendFrameFn = std::function<void(const std::vector<uint8_t>&)>;
using StrandPosterFn = std::function<void(std::function<void()>)>;

class Channel : public std::enable_shared_from_this<Channel> {
public:
    Channel(uint16_t id, uint32_t connectionId, VirtualHostPtr vhost,
            SendFrameFn sendFrame, uint32_t frameMax,
            StrandPosterFn strandPoster);

    uint16_t id() const { return id_; }
    bool isOpen() const { return open_; }
    void setOpen(bool v) { open_ = v; }

    void handleMethod(uint16_t classId, uint16_t methodId, amqp::Buffer& buf);
    void handleContentHeader(amqp::Buffer& buf);
    void handleContentBody(const uint8_t* data, size_t len);

    void removeAllConsumers();

private:
    uint16_t id_;
    uint32_t connectionId_;
    VirtualHostPtr vhost_;
    SendFrameFn sendFrame_;
    StrandPosterFn strandPoster_;
    uint32_t frameMax_;
    bool open_ = false;
    bool flow_ = true;
    bool confirmMode_ = false;
    uint64_t nextDeliveryTag_ = 1;
    uint64_t nextConfirmSeqNo_ = 1;

    static constexpr uint64_t MAX_BODY_SIZE = 128 * 1024 * 1024; // 128 MB

    uint16_t prefetchCount_ = 0;
    uint32_t prefetchSize_ = 0;

    std::unordered_map<std::string, ConsumerPtr> consumers_;
    uint64_t consumerTagCounter_ = 0;

    struct PendingPublish {
        std::string exchange;
        std::string routing_key;
        bool mandatory = false;
        bool immediate = false;
        uint64_t bodySize = 0;
        uint64_t bodyReceived = 0;
        amqp::BasicProperties properties;
        std::vector<uint8_t> body;
    };
    std::optional<PendingPublish> pendingPublish_;

    struct UnackedMessage {
        MessagePtr message;
        std::string queue_name;
        ConsumerPtr consumer;
    };
    std::unordered_map<uint64_t, UnackedMessage> unackedMessages_;

    void handleExchangeDeclare(amqp::Buffer& buf);
    void handleExchangeDelete(amqp::Buffer& buf);
    void handleQueueDeclare(amqp::Buffer& buf);
    void handleQueueBind(amqp::Buffer& buf);
    void handleQueueUnbind(amqp::Buffer& buf);
    void handleQueuePurge(amqp::Buffer& buf);
    void handleQueueDelete(amqp::Buffer& buf);
    void handleBasicQos(amqp::Buffer& buf);
    void handleBasicConsume(amqp::Buffer& buf);
    void handleBasicCancel(amqp::Buffer& buf);
    void handleBasicPublish(amqp::Buffer& buf);
    void handleBasicGet(amqp::Buffer& buf);
    void handleBasicAck(amqp::Buffer& buf);
    void handleBasicReject(amqp::Buffer& buf);
    void handleBasicRecover(amqp::Buffer& buf);
    void handleBasicNack(amqp::Buffer& buf);
    void handleConfirmSelect(amqp::Buffer& buf);
    void handleTxSelect(amqp::Buffer& buf);
    void handleTxCommit(amqp::Buffer& buf);
    void handleTxRollback(amqp::Buffer& buf);

    void sendMethodFrame(uint16_t classId, uint16_t methodId,
                         std::function<void(amqp::Buffer&)> writeArgs);
    void sendContentFrames(uint16_t classId, const amqp::BasicProperties& props,
                           const std::vector<uint8_t>& body);
    void sendChannelClose(uint16_t replyCode, const std::string& replyText,
                          uint16_t classId, uint16_t methodId);

    void deliverMessage(const std::string& consumerTag,
                        const std::string& exchange, const std::string& routingKey,
                        bool redelivered, const amqp::BasicProperties& props,
                        const std::vector<uint8_t>& body,
                        const std::string& queueName, MessagePtr original);

    void persistAck(const UnackedMessage& unacked);
};

} // namespace broko::broker
