#include "connection.h"
#include <chrono>
#include <format>
#include <iostream>

namespace broko::broker {

using namespace amqp;
using boost::asio::ip::tcp;

AmqpConnection::AmqpConnection(tcp::socket socket, VirtualHostPtr defaultVhost,
                                uint32_t id, CloseCallback onClose,
                                UserStore* userStore)
    : id_(id), socket_(std::move(socket)),
      strand_(boost::asio::make_strand(socket_.get_executor())),
      heartbeatTimer_(strand_),
      heartbeatCheckTimer_(strand_),
      vhost_(std::move(defaultVhost)),
      onClose_(std::move(onClose)),
      userStore_(userStore) {
    connectedAtMs_ = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::system_clock::now().time_since_epoch()).count();
    boost::system::error_code ec;
    auto ep = socket_.remote_endpoint(ec);
    if (!ec) peerAddress_ = ep.address().to_string() + ":" + std::to_string(ep.port());
}

void AmqpConnection::start() {
    readProtocolHeader();
}

void AmqpConnection::postToStrand(std::function<void()> fn) {
    boost::asio::post(strand_, std::move(fn));
}

void AmqpConnection::close() {
    sendConnectionClose(reply_code::CONNECTION_FORCED, "Connection forced", 0, 0);
}

void AmqpConnection::readProtocolHeader() {
    readBuf_.resize(PROTOCOL_HEADER_SIZE);
    auto self = shared_from_this();
    boost::asio::async_read(socket_, boost::asio::buffer(readBuf_),
        boost::asio::bind_executor(strand_,
        [self](const boost::system::error_code& ec, size_t) {
            if (ec) {
                self->shutdown();
                return;
            }

            if (self->readBuf_[0] == 'A' && self->readBuf_[1] == 'M' &&
                self->readBuf_[2] == 'Q' && self->readBuf_[3] == 'P' &&
                self->readBuf_[4] == 0   && self->readBuf_[5] == 0   &&
                self->readBuf_[6] == 9   && self->readBuf_[7] == 1) {
                self->state_ = State::AWAITING_START_OK;
                self->sendConnectionStart();
                self->readFrameHeader();
            } else {
                std::vector<uint8_t> hdr(PROTOCOL_HEADER, PROTOCOL_HEADER + PROTOCOL_HEADER_SIZE);
                self->sendFrame(hdr);
                self->shutdown();
            }
        }));
}

void AmqpConnection::readFrameHeader() {
    readBuf_.resize(FRAME_HEADER_SIZE);
    auto self = shared_from_this();
    boost::asio::async_read(socket_, boost::asio::buffer(readBuf_),
        boost::asio::bind_executor(strand_,
        [self](const boost::system::error_code& ec, size_t) {
            if (ec) {
                if (ec != boost::asio::error::eof && ec != boost::asio::error::operation_aborted)
                    std::cerr << std::format("[conn-{}] Frame header read error: {}\n",
                                             self->id_, ec.message());
                self->shutdown();
                return;
            }
            self->receivedData_ = true;

            uint8_t type = self->readBuf_[0];
            uint16_t channel = (static_cast<uint16_t>(self->readBuf_[1]) << 8)
                             | static_cast<uint16_t>(self->readBuf_[2]);
            uint32_t size = (static_cast<uint32_t>(self->readBuf_[3]) << 24)
                          | (static_cast<uint32_t>(self->readBuf_[4]) << 16)
                          | (static_cast<uint32_t>(self->readBuf_[5]) << 8)
                          | static_cast<uint32_t>(self->readBuf_[6]);

            uint32_t effectiveMax = self->frameMax_ > 0 ? self->frameMax_ : HARD_FRAME_MAX;
            if (size > effectiveMax) {
                self->sendConnectionClose(reply_code::FRAME_ERROR,
                    "Frame too large", 0, 0);
                return;
            }

            self->readFramePayload(type, channel, size);
        }));
}

void AmqpConnection::readFramePayload(uint8_t type, uint16_t channel, uint32_t size) {
    readBuf_.resize(size + 1);
    auto self = shared_from_this();
    boost::asio::async_read(socket_, boost::asio::buffer(readBuf_),
        boost::asio::bind_executor(strand_,
        [self, type, channel, size](const boost::system::error_code& ec, size_t) {
            if (ec) { self->shutdown(); return; }

            if (self->readBuf_[size] != FRAME_END) {
                self->sendConnectionClose(reply_code::FRAME_ERROR,
                    "Invalid frame-end byte", 0, 0);
                return;
            }

            Frame frame;
            frame.type = type;
            frame.channel = channel;
            frame.payload.assign(self->readBuf_.begin(),
                                  self->readBuf_.begin() + size);

            try {
                self->handleFrame(frame);
            } catch (const std::exception& e) {
                std::cerr << std::format("[conn-{}] Frame handling error: {}\n",
                                         self->id_, e.what());
                self->sendConnectionClose(reply_code::FRAME_ERROR,
                    "Internal error", 0, 0);
                return;
            }

            if (self->state_ != State::CLOSED) {
                self->readFrameHeader();
            }
        }));
}

void AmqpConnection::handleFrame(const Frame& frame) {
    if (state_ == State::CLOSING && frame.type == FRAME_METHOD) {
        Buffer buf(frame.payload);
        uint16_t classId = buf.readUint16();
        uint16_t methodId = buf.readUint16();
        if (classId == class_id::CONNECTION && methodId == connection_method::CLOSE_OK) {
            handleConnectionCloseOk();
            return;
        }
        return;
    }

    switch (frame.type) {
    case FRAME_METHOD: {
        Buffer buf(frame.payload);
        handleMethodFrame(frame.channel, buf);
        break;
    }
    case FRAME_HEADER: {
        auto it = channels_.find(frame.channel);
        if (it != channels_.end() && it->second->isOpen()) {
            Buffer buf(frame.payload);
            it->second->handleContentHeader(buf);
        }
        break;
    }
    case FRAME_BODY: {
        auto it = channels_.find(frame.channel);
        if (it != channels_.end() && it->second->isOpen()) {
            it->second->handleContentBody(frame.payload.data(), frame.payload.size());
        }
        break;
    }
    case FRAME_HEARTBEAT:
        break;
    default:
        sendConnectionClose(reply_code::FRAME_ERROR, "Unknown frame type", 0, 0);
        break;
    }
}

void AmqpConnection::handleMethodFrame(uint16_t channel, Buffer& buf) {
    uint16_t classId = buf.readUint16();
    uint16_t methodId = buf.readUint16();

    if (classId == class_id::CONNECTION) {
        if (channel != 0) {
            sendConnectionClose(reply_code::COMMAND_INVALID,
                "Connection method on non-zero channel", classId, methodId);
            return;
        }
        handleConnectionMethod(methodId, buf);
        return;
    }

    if (classId == class_id::CHANNEL) {
        switch (methodId) {
        case channel_method::OPEN:     handleChannelOpen(channel, buf); return;
        case channel_method::CLOSE:    handleChannelClose(channel, buf); return;
        case channel_method::CLOSE_OK: handleChannelCloseOk(channel); return;
        case channel_method::FLOW:     handleChannelFlow(channel, buf); return;
        }
    }

    auto it = channels_.find(channel);
    if (it == channels_.end() || !it->second->isOpen()) {
        sendConnectionClose(reply_code::CHANNEL_ERROR,
            std::format("Channel {} not open", channel), classId, methodId);
        return;
    }

    it->second->handleMethod(classId, methodId, buf);
}

void AmqpConnection::handleConnectionMethod(uint16_t methodId, Buffer& buf) {
    switch (methodId) {
    case connection_method::START_OK:  handleStartOk(buf); break;
    case connection_method::TUNE_OK:   handleTuneOk(buf); break;
    case connection_method::OPEN:      handleConnectionOpen(buf); break;
    case connection_method::CLOSE:     handleConnectionClose(buf); break;
    case connection_method::CLOSE_OK:  handleConnectionCloseOk(); break;
    default:
        sendConnectionClose(reply_code::COMMAND_INVALID,
            std::format("Unexpected connection method {}", methodId),
            class_id::CONNECTION, methodId);
        break;
    }
}

void AmqpConnection::sendConnectionStart() {
    FieldTable serverProps;
    serverProps["product"]     = FieldValue::longString("Broko");
    serverProps["version"]     = FieldValue::longString("0.1.0");
    serverProps["platform"]    = FieldValue::longString("C++");
    serverProps["copyright"]   = FieldValue::longString("");
    serverProps["information"] = FieldValue::longString("https://github.com/broko");
    FieldTable caps;
    caps["publisher_confirms"]           = FieldValue::boolean(true);
    caps["exchange_exchange_bindings"]    = FieldValue::boolean(false);
    caps["basic.nack"]                   = FieldValue::boolean(true);
    caps["consumer_cancel_notify"]       = FieldValue::boolean(true);
    caps["connection.blocked"]           = FieldValue::boolean(false);
    caps["consumer_priorities"]          = FieldValue::boolean(false);
    caps["authentication_failure_close"] = FieldValue::boolean(true);
    caps["per_consumer_qos"]             = FieldValue::boolean(true);
    caps["direct_reply_to"]              = FieldValue::boolean(false);
    serverProps["capabilities"] = FieldValue::table(std::move(caps));

    sendMethodFrame(0, class_id::CONNECTION, connection_method::START, [&](Buffer& b) {
        b.writeUint8(0);
        b.writeUint8(9);
        b.writeFieldTable(serverProps);
        b.writeLongString("PLAIN AMQPLAIN");
        b.writeLongString("en_US");
    });
}

void AmqpConnection::handleStartOk(Buffer& buf) {
    if (state_ != State::AWAITING_START_OK) {
        sendConnectionClose(reply_code::COMMAND_INVALID, "Unexpected Start-Ok",
                            class_id::CONNECTION, connection_method::START_OK);
        return;
    }

    /*auto clientProps =*/ buf.readFieldTable();
    auto mechanism = buf.readShortString();
    auto response = buf.readLongString();
    /*auto locale =*/ buf.readShortString();

    std::string user, pass;
    if (mechanism == "PLAIN") {
        size_t i = 0;
        if (i < response.size() && response[i] == '\0') i++;
        while (i < response.size() && response[i] != '\0')
            user += response[i++];
        if (i < response.size()) i++;
        while (i < response.size())
            pass += response[i++];
    } else if (mechanism == "AMQPLAIN") {
        Buffer respBuf(reinterpret_cast<const uint8_t*>(response.data()), response.size());
        auto fields = respBuf.readFieldTable();
        if (auto it = fields.find("LOGIN"); it != fields.end())
            user = it->second.string_val;
        if (auto it = fields.find("PASSWORD"); it != fields.end())
            pass = it->second.string_val;
    } else {
        sendConnectionClose(reply_code::ACCESS_REFUSED,
            "Unsupported mechanism: " + mechanism,
            class_id::CONNECTION, connection_method::START_OK);
        return;
    }

    if (userStore_ && !userStore_->verify(user, pass)) {
        std::cerr << std::format("[conn-{}] Auth failed for user '{}'\n", id_, user);
        sendConnectionClose(reply_code::ACCESS_REFUSED,
            "ACCESS_REFUSED - Login was refused using authentication mechanism " + mechanism,
            class_id::CONNECTION, connection_method::START_OK);
        return;
    }

    authUser_ = user;
    state_ = State::AWAITING_TUNE_OK;
    sendConnectionTune();
}

void AmqpConnection::sendConnectionTune() {
    sendMethodFrame(0, class_id::CONNECTION, connection_method::TUNE, [this](Buffer& b) {
        b.writeUint16(channelMax_);
        b.writeUint32(frameMax_);
        b.writeUint16(heartbeatInterval_);
    });
}

void AmqpConnection::handleTuneOk(Buffer& buf) {
    if (state_ != State::AWAITING_TUNE_OK) {
        sendConnectionClose(reply_code::COMMAND_INVALID, "Unexpected Tune-Ok",
                            class_id::CONNECTION, connection_method::TUNE_OK);
        return;
    }

    uint16_t clientChannelMax = buf.readUint16();
    uint32_t clientFrameMax = buf.readUint32();
    uint16_t clientHeartbeat = buf.readUint16();

    if (clientChannelMax > 0)
        channelMax_ = std::min(channelMax_, clientChannelMax);
    if (clientFrameMax > 0)
        frameMax_ = std::min(frameMax_, clientFrameMax);
    if (clientHeartbeat > 0 && heartbeatInterval_ > 0)
        heartbeatInterval_ = std::min(heartbeatInterval_, clientHeartbeat);
    else if (clientHeartbeat > 0)
        heartbeatInterval_ = clientHeartbeat;

    state_ = State::AWAITING_OPEN;

    if (heartbeatInterval_ > 0)
        startHeartbeat();
}

void AmqpConnection::handleConnectionOpen(Buffer& buf) {
    if (state_ != State::AWAITING_OPEN) {
        sendConnectionClose(reply_code::COMMAND_INVALID, "Unexpected Open",
                            class_id::CONNECTION, connection_method::OPEN);
        return;
    }

    auto virtualHost = buf.readShortString();
    /*auto reserved1 =*/ buf.readShortString();
    if (buf.remaining() > 0) buf.readUint8();

    if (virtualHost != "/" && !virtualHost.empty()) {
        sendConnectionClose(reply_code::INVALID_PATH,
            "Unknown vhost: " + virtualHost,
            class_id::CONNECTION, connection_method::OPEN);
        return;
    }

    state_ = State::OPEN;

    sendMethodFrame(0, class_id::CONNECTION, connection_method::OPEN_OK, [](Buffer& b) {
        b.writeShortString("");
    });

    std::cerr << std::format("[conn-{}] Connection opened (user={}, vhost=/)\n",
                             id_, authUser_);
}

void AmqpConnection::handleConnectionClose(Buffer& buf) {
    uint16_t replyCode = buf.readUint16();
    auto replyText = buf.readShortString();
    /*uint16_t classId =*/ buf.readUint16();
    /*uint16_t methodId =*/ buf.readUint16();

    std::cerr << std::format("[conn-{}] Client requested close: {} {}\n",
                             id_, replyCode, replyText);

    sendMethodFrame(0, class_id::CONNECTION, connection_method::CLOSE_OK, nullptr);
    shutdown();
}

void AmqpConnection::handleConnectionCloseOk() {
    shutdown();
}

void AmqpConnection::handleChannelOpen(uint16_t channelNum, Buffer& buf) {
    /*auto reserved =*/ buf.readShortString();

    if (channelNum == 0 || channelNum > channelMax_) {
        sendConnectionClose(reply_code::CHANNEL_ERROR,
            std::format("Invalid channel number {}", channelNum),
            class_id::CHANNEL, channel_method::OPEN);
        return;
    }

    auto sendFn = [weak = weak_from_this()](const std::vector<uint8_t>& data) {
        if (auto self = weak.lock())
            self->sendFrame(data);
    };

    auto posterFn = [weak = weak_from_this()](std::function<void()> fn) {
        if (auto self = weak.lock())
            boost::asio::post(self->strand_, std::move(fn));
    };

    auto channel = std::make_shared<Channel>(channelNum, id_, vhost_,
                                              sendFn, frameMax_, posterFn);
    channel->setOpen(true);
    channels_[channelNum] = channel;

    sendMethodFrame(channelNum, class_id::CHANNEL, channel_method::OPEN_OK,
        [](Buffer& b) {
            b.writeLongString("");
        });
}

void AmqpConnection::cleanupChannel(uint16_t channelNum) {
    auto it = channels_.find(channelNum);
    if (it == channels_.end()) return;
    it->second->setOpen(false);
    it->second->removeAllConsumers();
    channels_.erase(it);
}

void AmqpConnection::cleanupAllChannels() {
    for (auto& [num, ch] : channels_) {
        ch->setOpen(false);
        ch->removeAllConsumers();
    }
    channels_.clear();
}

void AmqpConnection::handleChannelClose(uint16_t channelNum, Buffer& buf) {
    uint16_t replyCode = buf.readUint16();
    auto replyText = buf.readShortString();
    /*uint16_t classId =*/ buf.readUint16();
    /*uint16_t methodId =*/ buf.readUint16();

    std::cerr << std::format("[conn-{}] Channel {} closed: {} {}\n",
                             id_, channelNum, replyCode, replyText);

    cleanupChannel(channelNum);

    sendMethodFrame(channelNum, class_id::CHANNEL, channel_method::CLOSE_OK, nullptr);
}

void AmqpConnection::handleChannelCloseOk(uint16_t channelNum) {
    cleanupChannel(channelNum);
}

void AmqpConnection::handleChannelFlow(uint16_t channelNum, Buffer& buf) {
    uint8_t bits = buf.readUint8();
    bool active = bits & 0x01;

    sendMethodFrame(channelNum, class_id::CHANNEL, channel_method::FLOW_OK,
        [active](Buffer& b) {
            b.writeUint8(active ? 1 : 0);
        });
}

void AmqpConnection::sendMethodFrame(uint16_t channel, uint16_t classId,
                                      uint16_t methodId,
                                      std::function<void(Buffer&)> writeArgs) {
    Buffer payload;
    payload.writeUint16(classId);
    payload.writeUint16(methodId);
    if (writeArgs) writeArgs(payload);

    Buffer frame;
    frame.writeUint8(FRAME_METHOD);
    frame.writeUint16(channel);
    frame.writeUint32(static_cast<uint32_t>(payload.size()));
    frame.writeBytes(payload.data(), payload.size());
    frame.writeUint8(FRAME_END);

    sendFrame(frame.raw());
}

void AmqpConnection::sendConnectionClose(uint16_t replyCode,
                                           const std::string& replyText,
                                           uint16_t classId, uint16_t methodId) {
    if (state_ == State::CLOSING || state_ == State::CLOSED)
        return;

    state_ = State::CLOSING;
    sendMethodFrame(0, class_id::CONNECTION, connection_method::CLOSE, [&](Buffer& b) {
        b.writeUint16(replyCode);
        b.writeShortString(replyText);
        b.writeUint16(classId);
        b.writeUint16(methodId);
    });
}

void AmqpConnection::sendFrame(const std::vector<uint8_t>& data) {
    bool startWrite = false;
    {
        std::lock_guard lock(writeMu_);
        writeQueue_.push_back(data);
        if (!writing_) {
            writing_ = true;
            startWrite = true;
        }
    }
    if (startWrite)
        doWrite();
}

void AmqpConnection::doWrite() {
    auto self = shared_from_this();
    auto data = std::make_shared<std::vector<uint8_t>>();
    {
        std::lock_guard lock(writeMu_);
        if (writeQueue_.empty()) {
            writing_ = false;
            return;
        }
        *data = std::move(writeQueue_.front());
        writeQueue_.pop_front();
    }

    boost::asio::async_write(socket_, boost::asio::buffer(*data),
        boost::asio::bind_executor(strand_,
        [self, data](const boost::system::error_code& ec, size_t) {
            if (ec) { self->shutdown(); return; }
            self->doWrite();
        }));
}

void AmqpConnection::startHeartbeat() {
    sendHeartbeat();
    checkHeartbeat();
}

void AmqpConnection::sendHeartbeat() {
    auto self = shared_from_this();
    heartbeatTimer_.expires_after(std::chrono::seconds(heartbeatInterval_));
    heartbeatTimer_.async_wait([self](const boost::system::error_code& ec) {
        if (ec) return;
        if (self->state_ == State::CLOSED) return;

        Buffer hb;
        hb.writeUint8(FRAME_HEARTBEAT);
        hb.writeUint16(0);
        hb.writeUint32(0);
        hb.writeUint8(FRAME_END);
        self->sendFrame(hb.raw());

        self->sendHeartbeat();
    });
}

void AmqpConnection::checkHeartbeat() {
    auto self = shared_from_this();
    heartbeatCheckTimer_.expires_after(std::chrono::seconds(heartbeatInterval_ * 2));
    heartbeatCheckTimer_.async_wait([self](const boost::system::error_code& ec) {
        if (ec) return;
        if (self->state_ == State::CLOSED) return;

        if (!self->receivedData_) {
            std::cerr << std::format("[conn-{}] Heartbeat timeout, closing\n", self->id_);
            self->shutdown();
            return;
        }
        self->receivedData_ = false;
        self->checkHeartbeat();
    });
}

void AmqpConnection::shutdown() {
    if (state_ == State::CLOSED) return;
    state_ = State::CLOSED;

    heartbeatTimer_.cancel();
    heartbeatCheckTimer_.cancel();

    boost::system::error_code ec;
    socket_.shutdown(tcp::socket::shutdown_both, ec);
    socket_.close(ec);

    cleanupAllChannels();

    vhost_->removeConnectionQueues(id_);

    std::cerr << std::format("[conn-{}] Disconnected\n", id_);

    if (onClose_) onClose_(id_);
}

} // namespace broko::broker
