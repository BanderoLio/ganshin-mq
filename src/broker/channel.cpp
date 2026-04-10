#include "channel.h"
#include <format>
#include <iostream>

namespace broko::broker {

using namespace amqp;

Channel::Channel(uint16_t id, uint32_t connectionId, VirtualHostPtr vhost,
                 SendFrameFn sendFrame, uint32_t frameMax,
                 StrandPosterFn strandPoster)
    : id_(id), connectionId_(connectionId), vhost_(std::move(vhost)),
      sendFrame_(std::move(sendFrame)), strandPoster_(std::move(strandPoster)),
      frameMax_(frameMax) {}

void Channel::removeAllConsumers() {
    for (auto& [tag, consumer] : consumers_) {
        auto q = vhost_->findQueue(consumer->queue_name);
        if (q) q->removeConsumer(tag);
    }
    consumers_.clear();
}

void Channel::sendMethodFrame(uint16_t classId, uint16_t methodId,
                              std::function<void(Buffer&)> writeArgs) {
    Buffer payload;
    payload.writeUint16(classId);
    payload.writeUint16(methodId);
    if (writeArgs) writeArgs(payload);

    Buffer frame;
    frame.writeUint8(FRAME_METHOD);
    frame.writeUint16(id_);
    frame.writeUint32(static_cast<uint32_t>(payload.size()));
    frame.writeBytes(payload.data(), payload.size());
    frame.writeUint8(FRAME_END);

    sendFrame_(frame.raw());
}

void Channel::sendContentFrames(uint16_t classId, const BasicProperties& props,
                                const std::vector<uint8_t>& body) {
    Buffer headerPayload;
    headerPayload.writeUint16(classId);
    headerPayload.writeUint16(0); // weight
    headerPayload.writeUint64(body.size());
    props.encode(headerPayload);

    Buffer headerFrame;
    headerFrame.writeUint8(FRAME_HEADER);
    headerFrame.writeUint16(id_);
    headerFrame.writeUint32(static_cast<uint32_t>(headerPayload.size()));
    headerFrame.writeBytes(headerPayload.data(), headerPayload.size());
    headerFrame.writeUint8(FRAME_END);
    sendFrame_(headerFrame.raw());

    uint32_t maxBodyPayload = frameMax_ > 8 ? frameMax_ - 8 : 131064;
    if (maxBodyPayload == 0) maxBodyPayload = 131064;

    size_t offset = 0;
    do {
        size_t chunkSize = std::min(static_cast<size_t>(maxBodyPayload),
                                    body.size() - offset);
        Buffer bodyFrame;
        bodyFrame.writeUint8(FRAME_BODY);
        bodyFrame.writeUint16(id_);
        bodyFrame.writeUint32(static_cast<uint32_t>(chunkSize));
        bodyFrame.writeBytes(body.data() + offset, chunkSize);
        bodyFrame.writeUint8(FRAME_END);
        sendFrame_(bodyFrame.raw());
        offset += chunkSize;
    } while (offset < body.size());

    if (body.empty()) {
        Buffer bodyFrame;
        bodyFrame.writeUint8(FRAME_BODY);
        bodyFrame.writeUint16(id_);
        bodyFrame.writeUint32(0);
        bodyFrame.writeUint8(FRAME_END);
        sendFrame_(bodyFrame.raw());
    }
}

void Channel::sendChannelClose(uint16_t replyCode, const std::string& replyText,
                                uint16_t classId, uint16_t methodId) {
    sendMethodFrame(class_id::CHANNEL, channel_method::CLOSE, [&](Buffer& buf) {
        buf.writeUint16(replyCode);
        buf.writeShortString(replyText);
        buf.writeUint16(classId);
        buf.writeUint16(methodId);
    });
}

void Channel::handleMethod(uint16_t classId, uint16_t methodId, Buffer& buf) {
    switch (classId) {
    case class_id::EXCHANGE:
        switch (methodId) {
        case exchange_method::DECLARE: handleExchangeDeclare(buf); return;
        case exchange_method::DELETE:  handleExchangeDelete(buf); return;
        }
        break;
    case class_id::QUEUE:
        switch (methodId) {
        case queue_method::DECLARE: handleQueueDeclare(buf); return;
        case queue_method::BIND:    handleQueueBind(buf); return;
        case queue_method::UNBIND:  handleQueueUnbind(buf); return;
        case queue_method::PURGE:   handleQueuePurge(buf); return;
        case queue_method::DELETE:  handleQueueDelete(buf); return;
        }
        break;
    case class_id::BASIC:
        switch (methodId) {
        case basic_method::QOS:           handleBasicQos(buf); return;
        case basic_method::CONSUME:       handleBasicConsume(buf); return;
        case basic_method::CANCEL:        handleBasicCancel(buf); return;
        case basic_method::PUBLISH:       handleBasicPublish(buf); return;
        case basic_method::GET:           handleBasicGet(buf); return;
        case basic_method::ACK:           handleBasicAck(buf); return;
        case basic_method::REJECT:        handleBasicReject(buf); return;
        case basic_method::RECOVER:       handleBasicRecover(buf); return;
        case basic_method::RECOVER_ASYNC: handleBasicRecover(buf); return;
        case basic_method::NACK:          handleBasicNack(buf); return;
        }
        break;
    case class_id::CONFIRM:
        if (methodId == confirm_method::SELECT) { handleConfirmSelect(buf); return; }
        break;
    case class_id::TX:
        switch (methodId) {
        case tx_method::SELECT:   handleTxSelect(buf); return;
        case tx_method::COMMIT:   handleTxCommit(buf); return;
        case tx_method::ROLLBACK: handleTxRollback(buf); return;
        }
        break;
    }

    sendChannelClose(reply_code::NOT_IMPLEMENTED,
                     std::format("Method not implemented: {}.{}", classId, methodId),
                     classId, methodId);
}

// --- Content handling ---

void Channel::handleContentHeader(Buffer& buf) {
    if (!pendingPublish_) return;

    /*uint16_t classId =*/ buf.readUint16();
    /*uint16_t weight =*/ buf.readUint16();
    pendingPublish_->bodySize = buf.readUint64();

    if (pendingPublish_->bodySize > MAX_BODY_SIZE) {
        pendingPublish_.reset();
        sendChannelClose(reply_code::CONTENT_TOO_LARGE,
            "Message body exceeds maximum size",
            class_id::BASIC, basic_method::PUBLISH);
        return;
    }

    pendingPublish_->properties = BasicProperties::decode(buf);
    pendingPublish_->body.reserve(static_cast<size_t>(pendingPublish_->bodySize));

    if (pendingPublish_->bodySize == 0) {
        handleContentBody(nullptr, 0);
    }
}

void Channel::handleContentBody(const uint8_t* data, size_t len) {
    if (!pendingPublish_) return;

    if (data && len > 0) {
        pendingPublish_->body.insert(pendingPublish_->body.end(), data, data + len);
        pendingPublish_->bodyReceived += len;
    }

    if (pendingPublish_->bodyReceived >= pendingPublish_->bodySize) {
        auto msg = std::make_shared<Message>();
        msg->exchange = pendingPublish_->exchange;
        msg->routing_key = pendingPublish_->routing_key;
        msg->mandatory = pendingPublish_->mandatory;
        msg->immediate = pendingPublish_->immediate;
        msg->properties = std::move(pendingPublish_->properties);
        msg->body = std::move(pendingPublish_->body);
        msg->source_connection_id = connectionId_;

        auto queues = vhost_->routeMessage(msg->exchange, msg->routing_key,
            msg->properties.headers ? &*msg->properties.headers : nullptr);

        if (queues.empty() && msg->mandatory) {
            sendMethodFrame(class_id::BASIC, basic_method::RETURN, [&](Buffer& b) {
                b.writeUint16(reply_code::NO_ROUTE);
                b.writeShortString("NO_ROUTE");
                b.writeShortString(msg->exchange);
                b.writeShortString(msg->routing_key);
            });
            sendContentFrames(class_id::BASIC, msg->properties, msg->body);
        } else {
            for (auto& qname : queues) {
                auto copy = (queues.size() > 1)
                    ? std::make_shared<Message>(*msg) : msg;
                if (copy->isPersistent() && vhost_->store()) {
                    auto q = vhost_->findQueue(qname);
                    if (q && q->durable) {
                        copy->wal_id = vhost_->store()->storeMessage(qname, copy);
                    }
                }
                vhost_->deliverToQueue(qname, copy);
            }
        }

        if (confirmMode_) {
            uint64_t seqNo = nextConfirmSeqNo_++;
            sendMethodFrame(class_id::BASIC, basic_method::ACK, [seqNo](Buffer& b) {
                b.writeUint64(seqNo);
                b.writeUint8(0);
            });
        }

        pendingPublish_.reset();
    }
}

// --- Exchange methods ---

void Channel::handleExchangeDeclare(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto exchange = buf.readShortString();
    auto type = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool passive    = bits & 0x01;
    bool durable    = bits & 0x02;
    bool autoDelete = bits & 0x04;
    bool internal   = bits & 0x08;
    bool noWait     = bits & 0x10;
    auto args = buf.readFieldTable();

    if (type.empty() && !passive) type = "direct";

    uint16_t replyCode = 0;
    std::string replyText;
    auto ex = vhost_->declareExchange(exchange, type, passive, durable,
                                       autoDelete, internal, args,
                                       replyCode, replyText);
    if (!ex) {
        sendChannelClose(replyCode, replyText, class_id::EXCHANGE, exchange_method::DECLARE);
        return;
    }
    if (!noWait) {
        sendMethodFrame(class_id::EXCHANGE, exchange_method::DECLARE_OK, nullptr);
    }
}

void Channel::handleExchangeDelete(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto exchange = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool ifUnused = bits & 0x01;
    bool noWait   = bits & 0x02;

    uint16_t replyCode = 0;
    std::string replyText;
    if (!vhost_->deleteExchange(exchange, ifUnused, replyCode, replyText)) {
        sendChannelClose(replyCode, replyText, class_id::EXCHANGE, exchange_method::DELETE);
        return;
    }
    if (!noWait) {
        sendMethodFrame(class_id::EXCHANGE, exchange_method::DELETE_OK, nullptr);
    }
}

// --- Queue methods ---

void Channel::handleQueueDeclare(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool passive    = bits & 0x01;
    bool durable    = bits & 0x02;
    bool exclusive  = bits & 0x04;
    bool autoDelete = bits & 0x08;
    bool noWait     = bits & 0x10;
    auto args = buf.readFieldTable();

    uint16_t replyCode = 0;
    std::string replyText;
    auto result = vhost_->declareQueue(queue, passive, durable, exclusive,
                                        autoDelete, args, connectionId_,
                                        replyCode, replyText);
    if (!result.queue) {
        sendChannelClose(replyCode, replyText, class_id::QUEUE, queue_method::DECLARE);
        return;
    }
    if (!noWait) {
        auto& q = result.queue;
        sendMethodFrame(class_id::QUEUE, queue_method::DECLARE_OK, [&](Buffer& b) {
            b.writeShortString(q->name);
            b.writeUint32(q->messageCount());
            b.writeUint32(q->consumerCount());
        });
    }
}

void Channel::handleQueueBind(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    auto exchange = buf.readShortString();
    auto routingKey = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool noWait = bits & 0x01;
    auto args = buf.readFieldTable();

    uint16_t replyCode = 0;
    std::string replyText;
    if (!vhost_->bindQueue(queue, exchange, routingKey, args, replyCode, replyText)) {
        sendChannelClose(replyCode, replyText, class_id::QUEUE, queue_method::BIND);
        return;
    }
    if (!noWait) {
        sendMethodFrame(class_id::QUEUE, queue_method::BIND_OK, nullptr);
    }
}

void Channel::handleQueueUnbind(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    auto exchange = buf.readShortString();
    auto routingKey = buf.readShortString();
    auto args = buf.readFieldTable();

    uint16_t replyCode = 0;
    std::string replyText;
    if (!vhost_->unbindQueue(queue, exchange, routingKey, args, replyCode, replyText)) {
        sendChannelClose(replyCode, replyText, class_id::QUEUE, queue_method::UNBIND);
        return;
    }
    sendMethodFrame(class_id::QUEUE, queue_method::UNBIND_OK, nullptr);
}

void Channel::handleQueuePurge(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool noWait = bits & 0x01;

    auto q = vhost_->findQueue(queue);
    if (!q) {
        sendChannelClose(reply_code::NOT_FOUND, "NOT_FOUND - no queue '" + queue + "'",
                         class_id::QUEUE, queue_method::PURGE);
        return;
    }
    uint32_t count = q->purge();
    if (!noWait) {
        sendMethodFrame(class_id::QUEUE, queue_method::PURGE_OK, [count](Buffer& b) {
            b.writeUint32(count);
        });
    }
}

void Channel::handleQueueDelete(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool ifUnused = bits & 0x01;
    bool ifEmpty  = bits & 0x02;
    bool noWait   = bits & 0x04;

    uint32_t messageCount = 0;
    uint16_t replyCode = 0;
    std::string replyText;
    if (!vhost_->deleteQueue(queue, ifUnused, ifEmpty, messageCount, replyCode, replyText)) {
        sendChannelClose(replyCode, replyText, class_id::QUEUE, queue_method::DELETE);
        return;
    }
    if (!noWait) {
        sendMethodFrame(class_id::QUEUE, queue_method::DELETE_OK, [messageCount](Buffer& b) {
            b.writeUint32(messageCount);
        });
    }
}

// --- Basic methods ---

void Channel::handleBasicQos(Buffer& buf) {
    prefetchSize_ = buf.readUint32();
    prefetchCount_ = buf.readUint16();
    /*bool global =*/ buf.readUint8();
    sendMethodFrame(class_id::BASIC, basic_method::QOS_OK, nullptr);
}

void Channel::handleBasicConsume(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    auto consumerTag = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool noLocal    = bits & 0x01;
    bool noAck      = bits & 0x02;
    bool exclusive  = bits & 0x04;
    bool noWait     = bits & 0x08;
    auto args = buf.readFieldTable();

    auto q = vhost_->findQueue(queue);
    if (!q) {
        sendChannelClose(reply_code::NOT_FOUND, "NOT_FOUND - no queue '" + queue + "'",
                         class_id::BASIC, basic_method::CONSUME);
        return;
    }

    if (consumerTag.empty()) {
        consumerTag = "amq.ctag-" + std::to_string(connectionId_) + "-"
                    + std::to_string(id_) + "-" + std::to_string(++consumerTagCounter_);
    }

    auto consumer = std::make_shared<Consumer>();
    consumer->tag = consumerTag;
    consumer->queue_name = queue;
    consumer->no_local = noLocal;
    consumer->no_ack = noAck;
    consumer->exclusive = exclusive;
    consumer->channel_id = id_;
    consumer->connection_id = connectionId_;
    consumer->prefetch_count = prefetchCount_;
    consumer->on_deliver = [poster = strandPoster_,
                            weakCh = weak_from_this(), queue](
        const std::string& tag, uint64_t /*unused*/, bool redelivered,
        const std::string& exchange, const std::string& routingKey,
        const BasicProperties& props, const std::vector<uint8_t>& body) {

        auto msg = std::make_shared<Message>();
        msg->exchange = exchange;
        msg->routing_key = routingKey;
        msg->properties = props;
        msg->body = body;
        msg->redelivered = redelivered;

        poster([weakCh, tag, exchange, routingKey, redelivered, props, body, queue, msg]() {
            auto ch = weakCh.lock();
            if (!ch || !ch->isOpen()) return;
            ch->deliverMessage(tag, exchange, routingKey, redelivered, props, body, queue, msg);
        });
    };

    consumers_[consumerTag] = consumer;

    if (!noWait) {
        sendMethodFrame(class_id::BASIC, basic_method::CONSUME_OK, [&](Buffer& b) {
            b.writeShortString(consumerTag);
        });
    }

    q->addConsumer(consumer);
}

void Channel::handleBasicCancel(Buffer& buf) {
    auto consumerTag = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool noWait = bits & 0x01;

    auto it = consumers_.find(consumerTag);
    if (it != consumers_.end()) {
        auto q = vhost_->findQueue(it->second->queue_name);
        if (q) q->removeConsumer(consumerTag);
        consumers_.erase(it);
    }

    if (!noWait) {
        sendMethodFrame(class_id::BASIC, basic_method::CANCEL_OK, [&](Buffer& b) {
            b.writeShortString(consumerTag);
        });
    }
}

void Channel::handleBasicPublish(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto exchange = buf.readShortString();
    auto routingKey = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool mandatory = bits & 0x01;
    bool immediate = bits & 0x02;

    if (immediate) {
        sendChannelClose(reply_code::NOT_IMPLEMENTED,
            "immediate=true is not supported",
            class_id::BASIC, basic_method::PUBLISH);
        return;
    }

    pendingPublish_ = PendingPublish{};
    pendingPublish_->exchange = exchange;
    pendingPublish_->routing_key = routingKey;
    pendingPublish_->mandatory = mandatory;
}

void Channel::handleBasicGet(Buffer& buf) {
    /*uint16_t reserved =*/ buf.readUint16();
    auto queue = buf.readShortString();
    uint8_t bits = buf.readUint8();
    bool noAck = bits & 0x01;

    auto q = vhost_->findQueue(queue);
    if (!q) {
        sendChannelClose(reply_code::NOT_FOUND, "NOT_FOUND - no queue '" + queue + "'",
                         class_id::BASIC, basic_method::GET);
        return;
    }

    auto msg = q->get();
    if (!msg) {
        sendMethodFrame(class_id::BASIC, basic_method::GET_EMPTY, [](Buffer& b) {
            b.writeShortString("");
        });
        return;
    }

    uint64_t deliveryTag = nextDeliveryTag_++;
    if (!noAck) {
        unackedMessages_[deliveryTag] = {msg, queue, nullptr};
    }

    sendMethodFrame(class_id::BASIC, basic_method::GET_OK, [&](Buffer& b) {
        b.writeUint64(deliveryTag);
        b.writeUint8(msg->redelivered ? 1 : 0);
        b.writeShortString(msg->exchange);
        b.writeShortString(msg->routing_key);
        b.writeUint32(q->messageCount());
    });
    sendContentFrames(class_id::BASIC, msg->properties, msg->body);
}

void Channel::persistAck(const UnackedMessage& unacked) {
    if (unacked.consumer)
        unacked.consumer->in_flight.fetch_sub(1, std::memory_order_relaxed);
    if (!unacked.message->isPersistent() || !vhost_->store()) return;
    auto q = vhost_->findQueue(unacked.queue_name);
    if (q && q->durable && unacked.message->wal_id != 0)
        vhost_->store()->storeAck(unacked.queue_name, unacked.message->wal_id);
}

void Channel::handleBasicAck(Buffer& buf) {
    uint64_t deliveryTag = buf.readUint64();
    uint8_t bits = buf.readUint8();
    bool multiple = bits & 0x01;

    if (multiple) {
        std::vector<uint64_t> toRemove;
        for (auto& [tag, _] : unackedMessages_) {
            if (tag <= deliveryTag)
                toRemove.push_back(tag);
        }
        for (auto tag : toRemove) {
            auto it = unackedMessages_.find(tag);
            if (it != unackedMessages_.end()) {
                persistAck(it->second);
                unackedMessages_.erase(it);
            }
        }
    } else {
        auto it = unackedMessages_.find(deliveryTag);
        if (it != unackedMessages_.end()) {
            persistAck(it->second);
            unackedMessages_.erase(it);
        }
    }
}

void Channel::handleBasicReject(Buffer& buf) {
    uint64_t deliveryTag = buf.readUint64();
    uint8_t bits = buf.readUint8();
    bool requeue = bits & 0x01;

    auto it = unackedMessages_.find(deliveryTag);
    if (it != unackedMessages_.end()) {
        if (!requeue) persistAck(it->second);
        auto q = vhost_->findQueue(it->second.queue_name);
        if (q) q->reject(deliveryTag, requeue, it->second.message);
        unackedMessages_.erase(it);
    }
}

void Channel::handleBasicNack(Buffer& buf) {
    uint64_t deliveryTag = buf.readUint64();
    uint8_t bits = buf.readUint8();
    bool multiple = bits & 0x01;
    bool requeue  = bits & 0x02;

    std::vector<uint64_t> tags;
    if (multiple) {
        for (auto& [tag, _] : unackedMessages_) {
            if (tag <= deliveryTag) tags.push_back(tag);
        }
    } else {
        tags.push_back(deliveryTag);
    }

    for (auto tag : tags) {
        auto it = unackedMessages_.find(tag);
        if (it != unackedMessages_.end()) {
            if (!requeue) persistAck(it->second);
            auto q = vhost_->findQueue(it->second.queue_name);
            if (q) q->reject(tag, requeue, it->second.message);
            unackedMessages_.erase(it);
        }
    }
}

void Channel::handleBasicRecover(Buffer& buf) {
    uint8_t bits = buf.readUint8();
    bool requeue = bits & 0x01;

    if (requeue) {
        for (auto& [tag, unacked] : unackedMessages_) {
            auto q = vhost_->findQueue(unacked.queue_name);
            if (q) q->reject(tag, true, unacked.message);
        }
    }
    unackedMessages_.clear();

    sendMethodFrame(class_id::BASIC, basic_method::RECOVER_OK, nullptr);
}

void Channel::handleConfirmSelect(Buffer& buf) {
    uint8_t bits = buf.readUint8();
    bool noWait = bits & 0x01;
    confirmMode_ = true;
    nextConfirmSeqNo_ = 1;
    if (!noWait)
        sendMethodFrame(class_id::CONFIRM, confirm_method::SELECT_OK, nullptr);
}

void Channel::handleTxSelect(Buffer& /*buf*/) {
    sendMethodFrame(class_id::TX, tx_method::SELECT_OK, nullptr);
}

void Channel::handleTxCommit(Buffer& /*buf*/) {
    sendMethodFrame(class_id::TX, tx_method::COMMIT_OK, nullptr);
}

void Channel::handleTxRollback(Buffer& /*buf*/) {
    sendMethodFrame(class_id::TX, tx_method::ROLLBACK_OK, nullptr);
}

void Channel::deliverMessage(const std::string& consumerTag,
                             const std::string& exchange, const std::string& routingKey,
                             bool redelivered, const BasicProperties& props,
                             const std::vector<uint8_t>& body,
                             const std::string& queueName, MessagePtr original) {
    uint64_t deliveryTag = nextDeliveryTag_++;

    auto consIt = consumers_.find(consumerTag);
    if (consIt != consumers_.end() && !consIt->second->no_ack) {
        unackedMessages_[deliveryTag] = {original, queueName, consIt->second};
    }

    sendMethodFrame(class_id::BASIC, basic_method::DELIVER, [&](Buffer& b) {
        b.writeShortString(consumerTag);
        b.writeUint64(deliveryTag);
        b.writeUint8(redelivered ? 1 : 0);
        b.writeShortString(exchange);
        b.writeShortString(routingKey);
    });
    sendContentFrames(class_id::BASIC, props, body);
}

} // namespace broko::broker
