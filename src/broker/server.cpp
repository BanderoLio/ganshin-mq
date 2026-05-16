#include "server.h"
#include "../storage/message_store.h"
#include <format>
#include <iostream>

namespace broko::broker {

using boost::asio::ip::tcp;

AmqpServer::AmqpServer(boost::asio::io_context& ioContext, uint16_t port,
                       const std::string& dataDir,
                       const std::string& usersFile)
    : ioContext_(ioContext),
      acceptor_(ioContext, tcp::endpoint(tcp::v4(), port)),
      tickTimer_(ioContext),
      compactTimer_(ioContext) {
    acceptor_.set_option(boost::asio::socket_base::reuse_address(true));

    std::shared_ptr<storage::MessageStore> store;
    if (!dataDir.empty()) {
        store = std::make_shared<storage::MessageStore>(dataDir);
        store->open();
    }
    defaultVhost_ = std::make_shared<VirtualHost>("/", store);
    defaultVhost_->recoverFromStore();

    if (!usersFile.empty()) {
        userStore_.loadFromFile(usersFile);
    }
}

void AmqpServer::start() {
    std::cerr << std::format("Broko AMQP broker listening on port {}\n",
                             acceptor_.local_endpoint().port());
    accept();
    scheduleTick();
    scheduleCompaction();
}

void AmqpServer::stop() {
    tickTimer_.cancel();
    compactTimer_.cancel();
    acceptor_.close();
    std::lock_guard lock(connectionsMu_);
    for (auto& [id, conn] : connections_)
        conn->close();
    connections_.clear();
}

void AmqpServer::accept() {
    acceptor_.async_accept([this](const boost::system::error_code& ec, tcp::socket socket) {
        if (ec) {
            if (ec != boost::asio::error::operation_aborted)
                std::cerr << "Accept error: " << ec.message() << "\n";
            return;
        }

        socket.set_option(tcp::no_delay(true));

        uint32_t connId = nextConnectionId_++;
        auto conn = std::make_shared<AmqpConnection>(
            std::move(socket), defaultVhost_, connId,
            [this](uint32_t id) { removeConnection(id); },
            &userStore_);

        {
            std::lock_guard lock(connectionsMu_);
            connections_[connId] = conn;
        }

        std::cerr << std::format("[conn-{}] New TCP connection\n", connId);
        conn->start();

        accept();
    });
}

void AmqpServer::removeConnection(uint32_t id) {
    std::lock_guard lock(connectionsMu_);
    connections_.erase(id);
}

std::vector<AmqpServer::ConnectionInfo> AmqpServer::snapshotConnections() {
    std::vector<ConnectionInfo> out;
    std::lock_guard lock(connectionsMu_);
    out.reserve(connections_.size());
    for (auto& [id, conn] : connections_) {
        out.push_back({
            id,
            conn->authUser(),
            conn->peerAddress(),
            conn->connectedAtMs(),
            conn->channelCount(),
        });
    }
    return out;
}

void AmqpServer::scheduleTick() {
    tickTimer_.expires_after(std::chrono::milliseconds(100));
    tickTimer_.async_wait([this](const boost::system::error_code& ec) {
        if (ec) return;
        defaultVhost_->tick();
        scheduleTick();
    });
}

void AmqpServer::scheduleCompaction() {
    compactTimer_.expires_after(std::chrono::seconds(60));
    compactTimer_.async_wait([this](const boost::system::error_code& ec) {
        if (ec) return;
        if (auto store = defaultVhost_->store())
            store->compactIfNeeded();
        scheduleCompaction();
    });
}

} // namespace broko::broker
