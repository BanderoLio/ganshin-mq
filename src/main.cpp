#include "broker/server.h"
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

    broko::broker::AmqpServer server(ioContext, port, dataDir);
    server.start();

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
