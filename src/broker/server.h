#pragma once

#include "auth.h"
#include "connection.h"
#include "vhost.h"
#include <atomic>
#include <boost/asio.hpp>
#include <cstdint>
#include <memory>
#include <mutex>
#include <unordered_map>
#include <vector>

namespace broko::broker {

class AmqpServer {
public:
    AmqpServer(boost::asio::io_context& ioContext, uint16_t port,
               const std::string& dataDir = "",
               const std::string& usersFile = "");

    void start();
    void stop();

    VirtualHostPtr defaultVhost() const { return defaultVhost_; }
    UserStore& userStore() { return userStore_; }

    // Snapshot живых соединений для stats writer / web UI.
    struct ConnectionInfo {
        uint32_t id;
        std::string user;
        std::string peer;
        int64_t connectedAtMs;
        size_t channels;
    };
    std::vector<ConnectionInfo> snapshotConnections();

private:
    boost::asio::io_context& ioContext_;
    boost::asio::ip::tcp::acceptor acceptor_;
    VirtualHostPtr defaultVhost_;
    UserStore userStore_;

    std::atomic<uint32_t> nextConnectionId_{1};
    std::mutex connectionsMu_;
    std::unordered_map<uint32_t, AmqpConnectionPtr> connections_;
    boost::asio::steady_timer tickTimer_;
    boost::asio::steady_timer compactTimer_;

    void accept();
    void scheduleTick();
    void scheduleCompaction();
    void removeConnection(uint32_t id);
};

} // namespace broko::broker
