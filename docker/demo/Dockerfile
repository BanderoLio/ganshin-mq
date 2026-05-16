FROM node:22-slim

RUN useradd -r -s /usr/sbin/nologin broko

WORKDIR /app

# Build context is the project root, so paths are full.
# Local custom SDK package (used by *-sdk services and rpc-client)
COPY sdk/broko-client-js/ broko-client/

COPY docker/demo/package.json .
RUN npm install --omit=dev

COPY docker/demo/publisher/         publisher/
COPY docker/demo/subscriber/        subscriber/
COPY docker/demo/rpc-server/        rpc-server/
COPY docker/demo/rpc-client/        rpc-client/
COPY docker/demo/publisher-sdk/     publisher-sdk/
COPY docker/demo/subscriber-sdk/    subscriber-sdk/

USER broko
