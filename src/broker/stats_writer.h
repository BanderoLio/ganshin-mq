#pragma once

#include "server.h"
#include <boost/asio.hpp>
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>

namespace broko::broker {

// StatsWriter: периодически (по таймеру) собирает снапшот состояния брокера
// и атомарно записывает его в JSON-файл. Web UI sidecar читает этот файл.
//
// Атомарность достигается через write-to-temp + rename: stats.json никогда
// не «полу-записан» с точки зрения reader'а.
class StatsWriter {
public:
    StatsWriter(boost::asio::io_context& io,
                AmqpServer& server,
                std::string outputPath,
                std::chrono::milliseconds interval = std::chrono::milliseconds(1500))
        : timer_(io),
          server_(server),
          outputPath_(std::move(outputPath)),
          interval_(interval),
          startedAtMs_(_nowMs()) {}

    void start() {
        // Ensure parent dir exists
        try {
            std::filesystem::path p(outputPath_);
            if (p.has_parent_path())
                std::filesystem::create_directories(p.parent_path());
        } catch (...) { /* ignore */ }

        std::cerr << "[stats] writing snapshots to " << outputPath_
                  << " every " << interval_.count() << "ms\n";
        schedule();
    }

    void stop() {
        timer_.cancel();
    }

private:
    boost::asio::steady_timer timer_;
    AmqpServer& server_;
    std::string outputPath_;
    std::chrono::milliseconds interval_;
    int64_t startedAtMs_;

    static int64_t _nowMs() {
        return std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
    }

    void schedule() {
        timer_.expires_after(interval_);
        timer_.async_wait([this](const boost::system::error_code& ec) {
            if (ec) return;
            try { writeSnapshot(); }
            catch (const std::exception& e) {
                std::cerr << "[stats] write error: " << e.what() << "\n";
            }
            schedule();
        });
    }

    static std::string jsonEscape(const std::string& s) {
        std::string out;
        out.reserve(s.size() + 2);
        for (char c : s) {
            switch (c) {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\b': out += "\\b"; break;
                case '\f': out += "\\f"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (static_cast<unsigned char>(c) < 0x20) {
                        char tmp[8];
                        std::snprintf(tmp, sizeof tmp, "\\u%04x", c);
                        out += tmp;
                    } else {
                        out += c;
                    }
            }
        }
        return out;
    }

    void writeSnapshot() {
        std::ostringstream s;
        const int64_t now = _nowMs();
        const int64_t uptimeMs = now - startedAtMs_;

        auto queues = server_.defaultVhost()->snapshotQueues();
        auto exchanges = server_.defaultVhost()->snapshotExchanges();
        auto conns = server_.snapshotConnections();

        uint32_t totalMessages = 0;
        for (auto& q : queues) totalMessages += q.message_count;

        s << "{";
        s << "\"version\":\"1.0\",";
        s << "\"timestamp_ms\":" << now << ",";
        s << "\"uptime_ms\":" << uptimeMs << ",";
        s << "\"stats\":{";
        s << "\"connections\":" << conns.size() << ",";
        s << "\"queues\":" << queues.size() << ",";
        s << "\"exchanges\":" << exchanges.size() << ",";
        s << "\"messages_ready\":" << totalMessages;
        s << "},";

        // queues
        s << "\"queues\":[";
        for (size_t i = 0; i < queues.size(); ++i) {
            auto& q = queues[i];
            if (i) s << ",";
            s << "{"
              << "\"name\":\""        << jsonEscape(q.name) << "\","
              << "\"durable\":"       << (q.durable ? "true" : "false") << ","
              << "\"exclusive\":"     << (q.exclusive ? "true" : "false") << ","
              << "\"auto_delete\":"   << (q.auto_delete ? "true" : "false") << ","
              << "\"messages\":"      << q.message_count << ","
              << "\"consumers\":"     << q.consumer_count
              << "}";
        }
        s << "],";

        // exchanges
        s << "\"exchanges\":[";
        for (size_t i = 0; i < exchanges.size(); ++i) {
            auto& ex = exchanges[i];
            if (i) s << ",";
            s << "{"
              << "\"name\":\""        << jsonEscape(ex.name.empty() ? "(default)" : ex.name) << "\","
              << "\"type\":\""        << jsonEscape(ex.type) << "\","
              << "\"durable\":"       << (ex.durable ? "true" : "false") << ","
              << "\"auto_delete\":"   << (ex.auto_delete ? "true" : "false") << ","
              << "\"bindings\":"      << ex.binding_count
              << "}";
        }
        s << "],";

        // connections
        s << "\"connections\":[";
        for (size_t i = 0; i < conns.size(); ++i) {
            auto& c = conns[i];
            if (i) s << ",";
            s << "{"
              << "\"id\":"            << c.id << ","
              << "\"user\":\""        << jsonEscape(c.user) << "\","
              << "\"peer\":\""        << jsonEscape(c.peer) << "\","
              << "\"connected_at_ms\":" << c.connectedAtMs << ","
              << "\"channels\":"      << c.channels
              << "}";
        }
        s << "]";

        s << "}";

        // Atomic write: write to .tmp, then rename
        const std::string tmpPath = outputPath_ + ".tmp";
        {
            std::ofstream out(tmpPath, std::ios::binary | std::ios::trunc);
            if (!out.is_open()) {
                std::cerr << "[stats] cannot open " << tmpPath << "\n";
                return;
            }
            out << s.str();
        }
        std::error_code rc;
        std::filesystem::rename(tmpPath, outputPath_, rc);
        if (rc) {
            std::cerr << "[stats] rename failed: " << rc.message() << "\n";
        }
    }
};

} // namespace broko::broker
