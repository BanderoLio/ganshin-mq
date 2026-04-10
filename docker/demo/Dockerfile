FROM node:22-slim

RUN useradd -r -s /usr/sbin/nologin broko

WORKDIR /app
COPY package.json .
RUN npm install --production

COPY publisher/ publisher/
COPY subscriber/ subscriber/
COPY rpc-server/ rpc-server/

USER broko
