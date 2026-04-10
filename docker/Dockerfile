FROM ubuntu:24.04 AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake libboost-dev && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /src
COPY CMakeLists.txt .
COPY src/ src/

RUN cmake -B build -DCMAKE_BUILD_TYPE=Release && \
    cmake --build build -j$(nproc)

FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -r -s /usr/sbin/nologin broko

COPY --from=builder /src/build/Broko /usr/local/bin/broko

RUN mkdir -p /var/lib/broko && chown broko:broko /var/lib/broko
VOLUME /var/lib/broko

EXPOSE 5672

USER broko
ENTRYPOINT ["broko"]
CMD ["5672", "/var/lib/broko"]
