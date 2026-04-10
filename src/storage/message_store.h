#pragma once

#include "../amqp/content.h"
#include "../amqp/types.h"
#include "../broker/message.h"
#include <cstdint>
#include <fcntl.h>
#include <filesystem>
#include <fstream>
#include <functional>
#include <mutex>
#include <string>
#include <unistd.h>
#include <unordered_map>
#include <vector>

namespace broko::storage {

// Simple binary format for WAL entries:
//   [4 bytes: total_entry_size]
//   [1 byte: entry_type] (1=message, 2=ack, 3=queue_declare, 4=exchange_declare, 5=binding)
//   [payload]
//   [4 bytes: checksum (CRC32 of payload)]

constexpr uint8_t ENTRY_MESSAGE         = 1;
constexpr uint8_t ENTRY_ACK             = 2;
constexpr uint8_t ENTRY_QUEUE_DECLARE   = 3;
constexpr uint8_t ENTRY_EXCHANGE_DECLARE = 4;
constexpr uint8_t ENTRY_BINDING         = 5;
constexpr uint8_t ENTRY_QUEUE_DELETE    = 6;
constexpr uint8_t ENTRY_EXCHANGE_DELETE = 7;
constexpr uint8_t ENTRY_UNBIND         = 8;

struct StoredMessage {
    uint64_t id;
    std::string queue_name;
    std::string exchange;
    std::string routing_key;
    amqp::BasicProperties properties;
    std::vector<uint8_t> body;
};

struct StoredQueueDecl {
    std::string name;
    bool durable;
    bool auto_delete;
};

struct StoredExchangeDecl {
    std::string name;
    std::string type;
    bool durable;
    bool auto_delete;
    bool internal;
};

struct StoredBinding {
    std::string queue;
    std::string exchange;
    std::string routing_key;
};

class MessageStore {
public:
    explicit MessageStore(const std::string& dataDir)
        : dataDir_(dataDir) {
        std::filesystem::create_directories(dataDir_);
        walPath_ = dataDir_ + "/broko.wal";
    }

    ~MessageStore() { close(); }

    bool open() {
        std::lock_guard lock(mu_);
        if (walStream_.is_open()) walStream_.close();
        if (walFd_ >= 0) { ::close(walFd_); walFd_ = -1; }

        walStream_.open(walPath_, std::ios::binary | std::ios::app);
        if (!walStream_.is_open()) return false;

        walFd_ = ::open(walPath_.c_str(), O_WRONLY | O_APPEND);
        if (walFd_ < 0) {
            walStream_.close();
            return false;
        }
        return true;
    }

    void close() {
        std::lock_guard lock(mu_);
        if (walStream_.is_open()) walStream_.close();
        if (walFd_ >= 0) { ::close(walFd_); walFd_ = -1; }
    }

    uint64_t storeMessage(const std::string& queueName,
                          const broker::MessagePtr& msg) {
        std::lock_guard lock(mu_);
        uint64_t id = nextMsgId_++;

        amqp::Buffer buf;
        buf.writeUint64(id);
        writeString(buf, queueName);
        writeString(buf, msg->exchange);
        writeString(buf, msg->routing_key);
        // Encode properties
        amqp::Buffer propBuf;
        msg->properties.encode(propBuf);
        buf.writeUint32(static_cast<uint32_t>(propBuf.size()));
        buf.writeBytes(propBuf.data(), propBuf.size());
        // Body
        buf.writeUint32(static_cast<uint32_t>(msg->body.size()));
        buf.writeBytes(msg->body.data(), msg->body.size());

        writeEntry(ENTRY_MESSAGE, buf);
        return id;
    }

    void storeAck(const std::string& queueName, uint64_t messageId) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        buf.writeUint64(messageId);
        writeString(buf, queueName);
        writeEntry(ENTRY_ACK, buf);
    }

    void storeQueueDeclare(const std::string& name, bool durable, bool autoDelete) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        writeString(buf, name);
        buf.writeUint8(durable ? 1 : 0);
        buf.writeUint8(autoDelete ? 1 : 0);
        writeEntry(ENTRY_QUEUE_DECLARE, buf);
    }

    void storeExchangeDeclare(const std::string& name, const std::string& type,
                              bool durable, bool autoDelete, bool internal) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        writeString(buf, name);
        writeString(buf, type);
        buf.writeUint8(durable ? 1 : 0);
        buf.writeUint8(autoDelete ? 1 : 0);
        buf.writeUint8(internal ? 1 : 0);
        writeEntry(ENTRY_EXCHANGE_DECLARE, buf);
    }

    void storeBinding(const std::string& queue, const std::string& exchange,
                      const std::string& routingKey) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        writeString(buf, queue);
        writeString(buf, exchange);
        writeString(buf, routingKey);
        writeEntry(ENTRY_BINDING, buf);
    }

    void storeQueueDelete(const std::string& name) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        writeString(buf, name);
        writeEntry(ENTRY_QUEUE_DELETE, buf);
    }

    void storeExchangeDelete(const std::string& name) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        writeString(buf, name);
        writeEntry(ENTRY_EXCHANGE_DELETE, buf);
    }

    void storeUnbind(const std::string& queue, const std::string& exchange,
                     const std::string& routingKey) {
        std::lock_guard lock(mu_);
        amqp::Buffer buf;
        writeString(buf, queue);
        writeString(buf, exchange);
        writeString(buf, routingKey);
        writeEntry(ENTRY_UNBIND, buf);
    }

    struct RecoveryData {
        std::vector<StoredExchangeDecl> exchanges;
        std::vector<StoredQueueDecl> queues;
        std::vector<StoredBinding> bindings;
        std::vector<StoredMessage> messages;
        std::unordered_map<std::string, std::vector<uint64_t>> ackedMessages;
    };

    static constexpr uint32_t MAX_ENTRY_SIZE = 64 * 1024 * 1024; // 64 MB

    RecoveryData recover() {
        std::lock_guard lock(mu_);
        return recoverLocked();
    }

    // Atomically recover + compact the WAL under a single lock
    void compactIfNeeded() {
        std::lock_guard lock(mu_);

        // Recover under the lock so no writes can interleave
        RecoveryData liveData = recoverLocked();

        if (walStream_.is_open()) walStream_.close();
        if (walFd_ >= 0) { ::close(walFd_); walFd_ = -1; }

        std::string tmpPath = walPath_ + ".tmp";
        walStream_.open(tmpPath, std::ios::binary | std::ios::trunc);
        walFd_ = ::open(tmpPath.c_str(), O_WRONLY | O_APPEND);

        for (auto& ed : liveData.exchanges) {
            amqp::Buffer buf;
            writeString(buf, ed.name);
            writeString(buf, ed.type);
            buf.writeUint8(ed.durable ? 1 : 0);
            buf.writeUint8(ed.auto_delete ? 1 : 0);
            buf.writeUint8(ed.internal ? 1 : 0);
            writeEntry(ENTRY_EXCHANGE_DECLARE, buf);
        }
        for (auto& qd : liveData.queues) {
            amqp::Buffer buf;
            writeString(buf, qd.name);
            buf.writeUint8(qd.durable ? 1 : 0);
            buf.writeUint8(qd.auto_delete ? 1 : 0);
            writeEntry(ENTRY_QUEUE_DECLARE, buf);
        }
        for (auto& sb : liveData.bindings) {
            amqp::Buffer buf;
            writeString(buf, sb.queue);
            writeString(buf, sb.exchange);
            writeString(buf, sb.routing_key);
            writeEntry(ENTRY_BINDING, buf);
        }
        for (auto& sm : liveData.messages) {
            amqp::Buffer buf;
            buf.writeUint64(sm.id);
            writeString(buf, sm.queue_name);
            writeString(buf, sm.exchange);
            writeString(buf, sm.routing_key);
            amqp::Buffer propBuf;
            sm.properties.encode(propBuf);
            buf.writeUint32(static_cast<uint32_t>(propBuf.size()));
            buf.writeBytes(propBuf.data(), propBuf.size());
            buf.writeUint32(static_cast<uint32_t>(sm.body.size()));
            buf.writeBytes(sm.body.data(), sm.body.size());
            writeEntry(ENTRY_MESSAGE, buf);
        }

        walStream_.close();
        if (walFd_ >= 0) { ::close(walFd_); walFd_ = -1; }
        std::filesystem::rename(tmpPath, walPath_);
        walStream_.open(walPath_, std::ios::binary | std::ios::app);
        walFd_ = ::open(walPath_.c_str(), O_WRONLY | O_APPEND);
    }

private:
    std::string dataDir_;
    std::string walPath_;
    std::mutex mu_;
    std::ofstream walStream_;
    int walFd_ = -1;
    uint64_t nextMsgId_ = 1;

    RecoveryData recoverLocked() {
        RecoveryData data;
        std::ifstream in(walPath_, std::ios::binary);
        if (!in.is_open()) return data;

        while (in.peek() != EOF) {
            uint32_t totalSize = 0;
            in.read(reinterpret_cast<char*>(&totalSize), 4);
            if (in.gcount() != 4) break;
            totalSize = fromBE32(totalSize);

            if (totalSize < 5 || totalSize > MAX_ENTRY_SIZE) break;

            std::vector<uint8_t> entry(totalSize);
            in.read(reinterpret_cast<char*>(entry.data()), totalSize);
            if (static_cast<size_t>(in.gcount()) != totalSize) break;

            uint32_t storedCrc = (static_cast<uint32_t>(entry[totalSize - 4]) << 24)
                               | (static_cast<uint32_t>(entry[totalSize - 3]) << 16)
                               | (static_cast<uint32_t>(entry[totalSize - 2]) << 8)
                               | static_cast<uint32_t>(entry[totalSize - 1]);
            uint32_t computedCrc = crc32(entry.data() + 1, totalSize - 5);
            if (storedCrc != computedCrc) break;

            uint8_t entryType = entry[0];
            amqp::Buffer buf(std::vector<uint8_t>(entry.begin() + 1,
                                                   entry.end() - 4));

            try {
                switch (entryType) {
                case ENTRY_MESSAGE: {
                    StoredMessage sm;
                    sm.id = buf.readUint64();
                    sm.queue_name = readString(buf);
                    sm.exchange = readString(buf);
                    sm.routing_key = readString(buf);
                    uint32_t propLen = buf.readUint32();
                    auto propBytes = buf.readBytes(propLen);
                    amqp::Buffer propBuf(std::move(propBytes));
                    sm.properties = amqp::BasicProperties::decode(propBuf);
                    uint32_t bodyLen = buf.readUint32();
                    sm.body = buf.readBytes(bodyLen);
                    if (sm.id >= nextMsgId_) nextMsgId_ = sm.id + 1;
                    data.messages.push_back(std::move(sm));
                    break;
                }
                case ENTRY_ACK: {
                    uint64_t msgId = buf.readUint64();
                    std::string queue = readString(buf);
                    data.ackedMessages[queue].push_back(msgId);
                    break;
                }
                case ENTRY_QUEUE_DECLARE: {
                    StoredQueueDecl qd;
                    qd.name = readString(buf);
                    qd.durable = buf.readUint8() != 0;
                    qd.auto_delete = buf.readUint8() != 0;
                    data.queues.push_back(std::move(qd));
                    break;
                }
                case ENTRY_EXCHANGE_DECLARE: {
                    StoredExchangeDecl ed;
                    ed.name = readString(buf);
                    ed.type = readString(buf);
                    ed.durable = buf.readUint8() != 0;
                    ed.auto_delete = buf.readUint8() != 0;
                    ed.internal = buf.readUint8() != 0;
                    data.exchanges.push_back(std::move(ed));
                    break;
                }
                case ENTRY_BINDING: {
                    StoredBinding sb;
                    sb.queue = readString(buf);
                    sb.exchange = readString(buf);
                    sb.routing_key = readString(buf);
                    data.bindings.push_back(std::move(sb));
                    break;
                }
                case ENTRY_QUEUE_DELETE: {
                    std::string name = readString(buf);
                    std::erase_if(data.queues, [&](const auto& q) { return q.name == name; });
                    std::erase_if(data.messages, [&](const auto& m) { return m.queue_name == name; });
                    std::erase_if(data.bindings, [&](const auto& b) { return b.queue == name; });
                    break;
                }
                case ENTRY_EXCHANGE_DELETE: {
                    std::string name = readString(buf);
                    std::erase_if(data.exchanges, [&](const auto& e) { return e.name == name; });
                    std::erase_if(data.bindings, [&](const auto& b) { return b.exchange == name; });
                    break;
                }
                case ENTRY_UNBIND: {
                    std::string queue = readString(buf);
                    std::string exchange = readString(buf);
                    std::string routingKey = readString(buf);
                    std::erase_if(data.bindings, [&](const auto& b) {
                        return b.queue == queue && b.exchange == exchange && b.routing_key == routingKey;
                    });
                    break;
                }
                }
            } catch (...) {
                break;
            }
        }

        for (auto& [queue, ackIds] : data.ackedMessages) {
            std::erase_if(data.messages, [&](const StoredMessage& m) {
                if (m.queue_name != queue) return false;
                for (auto id : ackIds) {
                    if (m.id == id) return true;
                }
                return false;
            });
        }

        return data;
    }

    static uint32_t fromBE32(uint32_t v) {
        auto p = reinterpret_cast<uint8_t*>(&v);
        return (static_cast<uint32_t>(p[0]) << 24)
             | (static_cast<uint32_t>(p[1]) << 16)
             | (static_cast<uint32_t>(p[2]) << 8)
             | static_cast<uint32_t>(p[3]);
    }

    void writeString(amqp::Buffer& buf, const std::string& s) {
        buf.writeUint32(static_cast<uint32_t>(s.size()));
        buf.writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }

    std::string readString(amqp::Buffer& buf) {
        uint32_t len = buf.readUint32();
        auto bytes = buf.readBytes(len);
        return std::string(bytes.begin(), bytes.end());
    }

    uint32_t crc32(const uint8_t* data, size_t len) {
        uint32_t crc = 0xFFFFFFFF;
        for (size_t i = 0; i < len; ++i) {
            crc ^= data[i];
            for (int j = 0; j < 8; ++j)
                crc = (crc >> 1) ^ (0xEDB88320 & -(crc & 1));
        }
        return ~crc;
    }

    void writeEntry(uint8_t entryType, const amqp::Buffer& payload) {
        uint32_t checksum = crc32(payload.data(), payload.size());

        // total_size = 1 (type) + payload_size + 4 (checksum)
        uint32_t totalSize = 1 + static_cast<uint32_t>(payload.size()) + 4;

        // Write big-endian size
        uint8_t sizeBE[4] = {
            uint8_t(totalSize >> 24), uint8_t(totalSize >> 16),
            uint8_t(totalSize >> 8), uint8_t(totalSize)
        };
        walStream_.write(reinterpret_cast<const char*>(sizeBE), 4);
        walStream_.write(reinterpret_cast<const char*>(&entryType), 1);
        walStream_.write(reinterpret_cast<const char*>(payload.data()), payload.size());

        uint8_t crcBE[4] = {
            uint8_t(checksum >> 24), uint8_t(checksum >> 16),
            uint8_t(checksum >> 8), uint8_t(checksum)
        };
        walStream_.write(reinterpret_cast<const char*>(crcBE), 4);
        walStream_.flush();
        if (walFd_ >= 0)
            ::fdatasync(walFd_);
    }
};

} // namespace broko::storage
