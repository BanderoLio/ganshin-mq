FROM node:22-slim

RUN useradd -r -s /usr/sbin/nologin broko

WORKDIR /app

COPY docker/webui/package.json .
RUN npm install --omit=dev

COPY docker/webui/server.js .
COPY docker/webui/public/ public/

USER broko

EXPOSE 15672

CMD ["node", "server.js"]
