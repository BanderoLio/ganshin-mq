# Broko — отчет для финального этапа

Документ фиксирует, какие технологии и требования из системы оценивания реализованы, в каких файлах это сделано и как именно применено.

## 1) Обязательные критерии (этапы 2-3)

| Критерий из системы оценивания | Технологии / подход | Файлы | Как применено |
|---|---|---|---|
| Publisher/Subscriber | AMQP `basic.publish`, `basic.consume`, `basic.get` | `src/broker/channel.cpp`, `src/broker/queue.h`, `docker/demo/publisher/index.js`, `docker/demo/subscriber/index.js` | На стороне брокера обработаны методы Basic и доставка в consumers; в демо-сервисах показан рабочий pub/sub поток через `amqplib`. |
| Поддержка очередей | Очереди AMQP + lifecycle операций | `src/broker/vhost.h`, `src/broker/channel.cpp`, `src/broker/queue.h` | Реализованы declare/bind/unbind/purge/delete, хранение очередей в `VirtualHost`, выдача сообщений и обслуживание потребителей. |
| Публикация/подписка в топики | Exchange-модель AMQP: direct/fanout/topic/headers | `src/broker/exchange.h`, `src/broker/vhost.h`, `src/broker/channel.cpp`, `docker/demo/publisher/index.js`, `docker/demo/subscriber/index.js` | Маршрутизация идет через exchange + binding; для topic применено wildcard-сопоставление `*` и `#`. |
| Множественные подписчики | Round-robin + QoS/prefetch | `src/broker/queue.h`, `src/broker/consumer.h`, `src/broker/channel.cpp` | `dispatchLocked()` распределяет сообщения между подписчиками; prefetch ограничивает in-flight сообщения на consumer. |
| Персистентность на диск | Собственный WAL (append-only) | `src/storage/message_store.h`, `src/broker/channel.cpp`, `src/broker/vhost.h`, `src/broker/server.cpp` | Durable сообщения/декларации пишутся в `broko.wal`, для записи используется `fdatasync`, после рестарта выполняется recovery состояния и сообщений. |
| Восстановление после перезапуска | Replay WAL + восстановление модели AMQ | `src/storage/message_store.h`, `src/broker/vhost.h`, `src/broker/server.cpp` | При старте вызывается `recoverFromStore()`: поднимаются exchanges, queues, bindings и недоставленные durable сообщения. |
| Гарантия доставки (at-least-once) | `ack/reject/nack`, requeue, персистентный ACK в WAL | `src/broker/channel.cpp`, `src/broker/queue.h`, `src/storage/message_store.h` | Сообщение хранится как unacked до ACK; при закрытии канала unacked requeue; при ACK durable сообщения пишется `storeAck`, чтобы не вернуть подтвержденное после рестарта. |
| Совместимость с `amqplib` + собственный SDK | AMQP 0-9-1 wire protocol + отдельный JS SDK | `src/amqp/types.h`, `src/amqp/frame.h`, `src/amqp/methods.h`, `src/amqp/content.h`, `sdk/broko-client-js/lib/connection.js`, `sdk/broko-client-js/lib/channel.js`, `sdk/broko-client-js/lib/frame.js`, `docker/demo/rpc-client/index.js`, `docker/demo/publisher-sdk/index.js`, `docker/demo/subscriber-sdk/index.js` | Брокер и SDK реализуют один и тот же AMQP wire-уровень; в демо параллельно используются `amqplib` и `broko-client`, что подтверждает совместимость и выполнение требования про самописный SDK. |

## 2) Дополнительные функции (этап 4)

| Допфункция | Файлы | Как реализовано |
|---|---|---|
| TTL (per-queue + per-message) | `src/broker/queue.h`, `test/test_advanced.js` | Очередь читает `x-message-ttl`, сообщение читает `expiration`; `effectiveTtl()` выбирает минимальное значение, просроченные сообщения удаляются/перенаправляются. |
| Dead Letter Exchange (DLX) | `src/broker/queue.h`, `src/broker/vhost.h`, `test/test_advanced.js` | Поддержаны `x-dead-letter-exchange` и `x-dead-letter-routing-key`; expired/rejected сообщения уходят в DLX через `deadLetterFn_`. |
| Приоритеты сообщений | `src/broker/queue.h`, `docker/demo/subscriber/index.js`, `test/test_advanced.js` | Поддержаны `x-max-priority` на очереди и `priority` у сообщения; при enqueue используется сортировка по эффективному приоритету. |
| Аутентификация | `src/broker/auth.h`, `src/broker/connection.cpp`, `src/main.cpp`, `docker/docker-compose.yml` | `UserStore` загружает `broker.users`, `handleStartOk()` валидирует PLAIN/AMQPLAIN и при ошибке закрывает соединение с `403 ACCESS_REFUSED`. |
| Web UI мониторинг | `src/broker/stats_writer.h`, `src/main.cpp`, `docker/webui/server.js`, `docker/webui/public/app.js`, `docker/docker-compose.yml` | Брокер периодически пишет `stats.json`; sidecar webui читает его и показывает overview/queues/exchanges/connections с автообновлением. |

## 3) Технические требования

| Требование | Файлы | Как закрыто |
|---|---|---|
| Язык C++ | `CMakeLists.txt`, `src/main.cpp`, `src/broker/server.cpp`, `src/broker/connection.cpp`, `src/broker/channel.cpp`, `src/broker/vhost.h` | В сборке зафиксирован стандарт `CMAKE_CXX_STANDARD 23`; серверная часть полностью реализована на C++. |
| Хранение данных на ФС | `src/storage/message_store.h`, `src/broker/server.cpp` | WAL хранится в директории данных (`data/broko.wal` / volume `/var/lib/broko`). |
| Протокол AMQP | `src/amqp/types.h`, `src/amqp/frame.h`, `src/amqp/methods.h`, `src/amqp/content.h`, `src/broker/connection.cpp`, `src/broker/channel.cpp` | Реализованы кадры, классы/методы AMQP 0-9-1, handshake, multiplexed channels, delivery headers/properties. |
| Документация | `README.md`, `docs/ARCHITECTURE_AND_DESIGN.md`, `DEMO.md`, `FINAL_REPORT.md` | Есть архитектурный документ, инструкция запуска/демо и отчет привязки критериев к коду. |
| Docker + docker-compose деплой | `docker/Dockerfile`, `docker/docker-compose.yml`, `docker/demo/Dockerfile`, `docker/webui/Dockerfile`, `scripts/run-demo.sh`, `Makefile` | Multi-stage образ брокера, compose-стенд с сервисами демо и webui, автоматизированный запуск/остановка. |

## 4) Допфункционал сверх минимального базового набора

- `Publisher confirms`: `src/broker/channel.cpp` (`confirm.select`, ACK для publish), тест `test/test_advanced.js`.
- `Mandatory + basic.return`: `src/broker/channel.cpp` (возврат unroutable сообщений).
- `QoS/prefetch`: `src/broker/channel.cpp`, `src/broker/queue.h`.
- `Heartbeat`: `src/broker/connection.cpp` и `sdk/broko-client-js/lib/connection.js`.
- `Headers exchange`: `src/broker/exchange.h`.
- `WAL compaction + CRC32`: `src/storage/message_store.h`.

## 5) Проверка реализации (файлы тестов)

- Базовая AMQP совместимость и pub/sub: `test/test_connect.js`, `test/test_full.js`.
- Допфункции: `test/test_advanced.js`.
- Персистентность и recovery: `test/test_persistence.js`.
