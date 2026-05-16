#include "broker/server.h"
#include "broker/stats_writer.h"
#include <cstdlib>
#include <iostream>
#include <thread>
#include <vector>

int main(int argc, char* argv[]) {
    uint16_t port = 5672;
    if (argc > 1) {
        port = static_cast<uint16_t>(std::stoi(argv[1]));
    }

    boost::asio::io_context ioContext;
    auto workGuard = boost::asio::make_work_guard(ioContext);

    std::string dataDir = "./data";
    if (argc > 2) dataDir = argv[2];

    // Users file: 3rd CLI arg > env BROKO_USERS_FILE > default <dataDir>/broker.users.
    // If file missing, broker falls back to "guest:guest only" permissive mode.
    std::string usersFile;
    if (argc > 3) usersFile = argv[3];
    else if (const char* env = std::getenv("BROKO_USERS_FILE")) usersFile = env;
    else usersFile = dataDir + "/broker.users";

    broko::broker::AmqpServer server(ioContext, port, dataDir, usersFile);
    server.start();

    // Stats writer for Web UI: every 1.5s dump snapshot to <dataDir>/stats.json
    broko::broker::StatsWriter statsWriter(ioContext, server, dataDir + "/stats.json");
    statsWriter.start();

    boost::asio::signal_set signals(ioContext, SIGINT, SIGTERM);
    signals.async_wait([&](const boost::system::error_code&, int) {
        server.stop();
        workGuard.reset();
    });

    unsigned threadCount = std::max(1u, std::thread::hardware_concurrency());
    std::vector<std::thread> threads;
    for (unsigned i = 1; i < threadCount; ++i) {
        threads.emplace_back([&ioContext]() { ioContext.run(); });
    }

    ioContext.run();

    for (auto& t : threads) t.join();
    std::cerr << "Broko shut down.\n";
}
