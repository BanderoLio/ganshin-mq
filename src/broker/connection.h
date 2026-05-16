#pragma once

#include "../amqp/frame.h"
#include "../amqp/methods.h"
#include "../amqp/types.h"
#include "auth.h"
#include "channel.h"
#include "vhost.h"
#include <boost/asio.hpp>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>

namespace broko::broker {

using CloseCallback = std::function<void(uint32_t)>;

class AmqpConnection : public std::enable_shared_from_this<AmqpConnection> {
public:
    static constexpr uint32_t HARD_FRAME_MAX = 16 * 1024 * 1024; // 16 MB

    AmqpConnection(boost::asio::ip::tcp::socket socket,
                   VirtualHostPtr defaultVhost,
                   uint32_t id,
                   CloseCallback onClose,
                   UserStore* userStore = nullptr);

    void start();
    void close();
    uint32_t id() const { return id_; }
    const std::string& authUser() const { return authUser_; }
    std::string peerAddress() const { return peerAddress_; }
    int64_t connectedAtMs() const { return connectedAtMs_; }
    size_t channelCount() const { return channels_.size(); }

    void postToStrand(std::function<void()> fn);

private:
    using Strand = boost::asio::strand<boost::asio::any_io_executor>;

    enum class State {
        AWAITING_PROTOCOL_HEADER,
        AWAITING_START_OK,
        AWAITING_TUNE_OK,
        AWAITING_OPEN,
        OPEN,
        CLOSING,
        CLOSED
    };

    uint32_t id_;
    boost::asio::ip::tcp::socket socket_;
    Strand strand_;
    boost::asio::steady_timer heartbeatTimer_;
    boost::asio::steady_timer heartbeatCheckTimer_;
    VirtualHostPtr vhost_;
    State state_ = State::AWAITING_PROTOCOL_HEADER;
    CloseCallback onClose_;

    uint16_t channelMax_ = 2047;
    uint32_t frameMax_ = 131072;
    uint16_t heartbeatInterval_ = 60;

    std::unordered_map<uint16_t, std::shared_ptr<Channel>> channels_;

    std::vector<uint8_t> readBuf_;

    std::mutex writeMu_;
    std::deque<std::vector<uint8_t>> writeQueue_;
    bool writing_ = false;

    bool receivedData_ = false;

    std::string authUser_;
    std::string peerAddress_;
    int64_t connectedAtMs_ = 0;
    UserStore* userStore_ = nullptr;

    void readProtocolHeader();
    void readFrameHeader();
    void readFramePayload(uint8_t type, uint16_t channel, uint32_t size);

    void handleFrame(const amqp::Frame& frame);
    void handleMethodFrame(uint16_t channel, amqp::Buffer& buf);
    void handleConnectionMethod(uint16_t methodId, amqp::Buffer& buf);

    void sendConnectionStart();
    void handleStartOk(amqp::Buffer& buf);
    void sendConnectionTune();
    void handleTuneOk(amqp::Buffer& buf);
    void handleConnectionOpen(amqp::Buffer& buf);
    void handleConnectionClose(amqp::Buffer& buf);
    void handleConnectionCloseOk();

    void handleChannelOpen(uint16_t channelNum, amqp::Buffer& buf);
    void handleChannelClose(uint16_t channelNum, amqp::Buffer& buf);
    void handleChannelCloseOk(uint16_t channelNum);
    void handleChannelFlow(uint16_t channelNum, amqp::Buffer& buf);

    void cleanupChannel(uint16_t channelNum);
    void cleanupAllChannels();

    void sendFrame(const std::vector<uint8_t>& data);
    void doWrite();

    void sendMethodFrame(uint16_t channel, uint16_t classId, uint16_t methodId,
                         std::function<void(amqp::Buffer&)> writeArgs);
    void sendConnectionClose(uint16_t replyCode, const std::string& replyText,
                             uint16_t classId, uint16_t methodId);

    void startHeartbeat();
    void sendHeartbeat();
    void checkHeartbeat();

    void shutdown();
};

using AmqpConnectionPtr = std::shared_ptr<AmqpConnection>;

} // namespace broko::broker
