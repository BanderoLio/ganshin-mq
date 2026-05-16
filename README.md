# Broko — AMQP 0-9-1 Message Broker

Брокер сообщений, написанный на C++ с полной поддержкой протокола AMQP 0-9-1. Совместим с клиентской библиотекой `amqplib` для Node.js и другими AMQP-клиентами. **Этапы 1–4 готовы к сдаче.**

## TL;DR — запуск демо

```bash
make demo                              # поднять брокер + 7 микросервисов + Web UI
open http://localhost:15672            # Web UI (admin / admin)
make demo-logs                         # логи реал-тайм
make demo-down                         # остановить и убрать volumes
```

Сценарий показа — в [DEMO.md](DEMO.md).

## Документация

| Документ | Содержание |
|----------|------------|
| [MessageBrokerRequirements.md](MessageBrokerRequirements.md) | Цели курса, обязательные требования, этапы сдачи. |
| [DEMO.md](DEMO.md) | Пошаговый сценарий финальной демонстрации (этап 4). |
| [FINAL_REPORT.md](FINAL_REPORT.md) | Отчет по системе оценивания: критерии → файлы → как реализовано. |
| [docs/ARCHITECTURE_AND_DESIGN.md](docs/ARCHITECTURE_AND_DESIGN.md) | Архитектура, структура данных, обоснование стека, план реализации (этап 1). |
| [sdk/broko-client-js/README.md](sdk/broko-client-js/README.md) | Самописный AMQP-клиент на Node.js (требование этапа 3). |

**Цель проекта** (сводка): асинхронный обмен сообщениями между сервисами через AMQP, с очередями и персистентностью; **обязательная** совместимость с клиентом **amqplib** на Node.js. Подробные требования — в `MessageBrokerRequirements.md`.

## Архитектура

```mermaid
graph TB
    subgraph Клиенты
        P1[Publisher / amqplib]
        P2[Publisher / broko-client SDK]
        S1[Subscriber]
        R1[RPC client / SDK]
        B[Browser]
    end

    subgraph "Broko Broker (C++)"
        NET["TCP / Boost.Asio<br/>(многопоточный io_context)"]
        CONN["Connection Manager<br/>(handshake, heartbeat,<br/>SASL + UserStore ACL)"]
        CH["Channel Multiplexer<br/>(до 2047 каналов)"]

        subgraph "AMQ Model"
            EX["Exchanges<br/>(direct, fanout, topic, headers)"]
            Q["Queues<br/>(TTL, приоритеты, DLX)"]
            BIND["Bindings<br/>(routing key + arguments)"]
        end

        WAL["WAL Persistence<br/>(broko.wal)"]
        STATS["StatsWriter<br/>(stats.json каждые 1.5с)"]
    end

    subgraph "Web UI sidecar (Node.js)"
        EX_API["Express + /api/*<br/>+ Basic Auth"]
        UI["Dashboard<br/>(HTML / JS)"]
    end

    P1 & P2 -->|AMQP 0-9-1| NET
    S1 & R1 -->|AMQP 0-9-1| NET
    NET --> CONN --> CH
    CH --> EX
    EX -->|route| BIND
    BIND --> Q
    Q -->|deliver| CH
    Q -.->|durable| WAL
    EX -.->|durable| WAL
    Q & EX & CONN -.->|snapshot| STATS
    STATS -.->|stats.json| EX_API
    EX_API --> UI
    B -->|HTTPS 15672| EX_API
```

## Технологический стек

| Компонент | Технология |
|-----------|-----------|
| Язык | C++23 |
| Асинхронный I/O | Boost.Asio (многопоточный пул) |
| Протокол | AMQP 0-9-1 (wire protocol) |
| Персистентность | Собственный Write-Ahead Log (WAL) |
| Сборка | CMake 3.16+ |
| Контейнеризация | Docker + Docker Compose |
| Клиент для тестов | Node.js + amqplib |

Обоснование выбора технологий и протокола — в [docs/ARCHITECTURE_AND_DESIGN.md](docs/ARCHITECTURE_AND_DESIGN.md), раздел 4.

## Реализованные функции

### Базовая функциональность
- [x] Полная реализация wire-протокола AMQP 0-9-1 (big-endian framing, field tables, bit packing)
- [x] Паттерн Publisher / Subscriber
- [x] Очереди сообщений (FIFO с поддержкой приоритетов)
- [x] Публикация сообщений в exchanges / очереди
- [x] Подписка на очереди (push — `basic.consume`, pull — `basic.get`)
- [x] Множественные подписчики (round-robin)

### Exchanges
- [x] **Direct** — маршрутизация по точному совпадению routing key
- [x] **Fanout** — широковещательная рассылка во все привязанные очереди
- [x] **Topic** — маршрутизация по паттернам (`*` и `#` wildcards)
- [x] **Headers** — маршрутизация по заголовкам сообщений (`x-match: all/any`)
- [x] Предустановленные exchanges: `""`, `amq.direct`, `amq.fanout`, `amq.topic`, `amq.headers`, `amq.match`

### Соединение и каналы
- [x] AMQP handshake (Connection.Start / Tune / Open)
- [x] SASL аутентификация (PLAIN и AMQPLAIN)
- [x] Мультиплексирование каналов (до 2047 на соединение)
- [x] Heartbeat (настраиваемый интервал, автоматическое отключение по таймауту)
- [x] Graceful shutdown (Connection.Close / Close-Ok)

### Подтверждения и надёжность
- [x] Явное подтверждение (`basic.ack`, `basic.reject`, `basic.nack`)
- [x] Multiple ack (подтверждение нескольких сообщений разом)
- [x] `basic.recover` — переотправка неподтверждённых сообщений
- [x] Publisher Confirms (`confirm.select`) — подтверждение доставки от брокера
- [x] Mandatory-флаг с `basic.return` для неразмаршрутизированных сообщений

### Персистентность
- [x] Write-Ahead Log (WAL) для durable-сообщений
- [x] Персистентность exchange, queue и binding деклараций
- [x] Восстановление состояния после перезапуска
- [x] WAL compaction
- [x] CRC32 валидация записей при восстановлении
- [x] Персистентность ack-подтверждений (сообщения не переотправляются после рестарта)

### Дополнительные функции
- [x] **TTL сообщений** — per-queue (`x-message-ttl`) и per-message (`expiration`)
- [x] **Dead Letter Exchange (DLX)** — перенаправление expired и rejected сообщений
- [x] **Dead Letter Routing Key** — настраиваемый routing key для DLX
- [x] **Приоритеты сообщений** — `x-max-priority` на очереди, `priority` на сообщении
- [x] **Транзакции** — `tx.select` / `tx.commit` / `tx.rollback` (stub)
- [x] **QoS / Prefetch** — `basic.qos` (prefetch-count, prefetch-size)
- [x] **Exclusive queues** — очереди, привязанные к соединению
- [x] **Auto-delete queues** — автоматическое удаление при отключении последнего потребителя
- [x] **Аутентификация** — валидация SASL PLAIN/AMQPLAIN credentials против `broker.users` (отказ → `403 ACCESS_REFUSED`)
- [x] **Web UI (sidecar)** — HTTP-панель на порту 15672 с realtime-метриками (читает `stats.json` от брокера)
- [x] **Самописный SDK** — `sdk/broko-client-js/` (минимальный Node.js клиент без зависимости от `amqplib`)

## Структура проекта

```
Broko/
├── docs/
│   └── ARCHITECTURE_AND_DESIGN.md  # Этап 1: архитектура, данные, стек, план
├── src/
│   ├── main.cpp                    # Точка входа: io_context + AmqpServer + StatsWriter
│   ├── amqp/                       # Wire-протокол AMQP 0-9-1
│   │   ├── types.h, frame.h, methods.h, content.h
│   ├── broker/
│   │   ├── server.h/cpp            # TCP acceptor, snapshot соединений
│   │   ├── connection.h/cpp        # AMQP state machine, heartbeat, framing
│   │   ├── channel.h/cpp           # Обработка методов Exchange/Queue/Basic/Confirm/Tx
│   │   ├── vhost.h                 # Virtual Host + snapshot для UI
│   │   ├── exchange.h              # Direct, Fanout, Topic, Headers exchanges
│   │   ├── queue.h                 # MessageQueue с TTL, DLX, priorities
│   │   ├── consumer.h, message.h
│   │   ├── auth.h                  # UserStore (users-файл, валидация SASL)
│   │   └── stats_writer.h          # Дамп stats.json для Web UI
│   └── storage/
│       └── message_store.h         # WAL-персистентность
├── sdk/
│   └── broko-client-js/            # Самописный AMQP-клиент (этап 3, обязательно)
│       ├── lib/                    # connection, channel, frame, types, methods
│       ├── examples/smoke.js       # Smoke-тест
│       └── README.md
├── test/                           # Интеграционные тесты на amqplib
│   ├── test_full.js, test_advanced.js, test_persistence.js, test_connect.js
├── docker/
│   ├── Dockerfile                  # Multi-stage брокер (Ubuntu + C++23 + Boost)
│   ├── docker-compose.yml          # broker + 7 демо-сервисов + webui
│   ├── demo/                       # Node.js демо-микросервисы
│   │   ├── publisher/, subscriber/, rpc-server/      # на amqplib
│   │   ├── publisher-sdk/, subscriber-sdk/, rpc-client/  # на самописном SDK
│   └── webui/                      # Web UI sidecar (Node.js + Express)
│       ├── server.js, Dockerfile, package.json
│       └── public/index.html, style.css, app.js
├── scripts/
│   └── run-demo.sh                 # One-command demo runner
├── Makefile                        # build / test / demo / clean
├── CMakeLists.txt
├── DEMO.md                         # Сценарий финальной демонстрации (этап 4)
├── MessageBrokerRequirements.md    # ТЗ курса и этапы
└── README.md
```

## Сборка и запуск

### Зависимости

- C++23-совместимый компилятор (GCC 13+, Clang 17+)
- CMake 3.16+
- Boost (headers only — Asio)
- Node.js 18+ (для тестов)

### Сборка

```bash
cmake -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

### Запуск

```bash
# По умолчанию: порт 5672, данные в ./data
./build/Broko

# С указанием порта и директории данных
./build/Broko 5672 ./data
```

Брокер слушает на `0.0.0.0:5672` и готов принимать AMQP-подключения.

### Docker (рекомендуемый способ запуска демо)

```bash
make demo           # docker compose up: брокер + 7 микросервисов + Web UI
make demo-logs      # tail логов всех сервисов
make demo-down      # docker compose down -v
```

После запуска:
- AMQP-брокер: `localhost:5672` (guest/guest)
- Web UI: <http://localhost:15672> (admin/admin)

Состав compose:

| Сервис | Что делает | Клиент |
|--------|-----------|--------|
| `broko` | Брокер | — |
| `publisher` | Заказы каждые 2с в `demo.orders` | amqplib |
| `subscriber-all` | Получает `order.#` | amqplib |
| `subscriber-high` | Получает только `order.high` | amqplib |
| `rpc-server` | Calculator RPC | amqplib |
| `rpc-client` | RPC-вызовы каждые 3с | **broko-client (свой SDK)** |
| `publisher-sdk` | Дублёр publisher на своём SDK | **broko-client** |
| `subscriber-sdk` | Дублёр subscriber на своём SDK | **broko-client** |
| `webui` | HTTP management UI на :15672 | — |

## Тестирование

### Установка зависимостей для тестов

```bash
cd test
npm install
cd ..
```

### Запуск тестов

Убедитесь, что брокер запущен на `localhost:5672`.

```bash
# Базовый тест подключения
node test/test_connect.js

# Полные интеграционные тесты (7 кейсов)
node test/test_full.js

# Продвинутые функции: TTL, DLX, приоритеты, confirms (7 кейсов)
node test/test_advanced.js

# Тест персистентности (перезапускает брокер)
node test/test_persistence.js
```

### Быстрая проверка через amqplib

Пример минимального publisher/subscriber:

**publisher.js:**
```javascript
const amqp = require('amqplib');

(async () => {
    const conn = await amqp.connect('amqp://guest:guest@localhost:5672');
    const ch = await conn.createChannel();

    await ch.assertQueue('hello', { durable: false });
    ch.sendToQueue('hello', Buffer.from('Привет из Broko!'));
    console.log('Сообщение отправлено');

    setTimeout(() => conn.close(), 500);
})();
```

**subscriber.js:**
```javascript
const amqp = require('amqplib');

(async () => {
    const conn = await amqp.connect('amqp://guest:guest@localhost:5672');
    const ch = await conn.createChannel();

    await ch.assertQueue('hello', { durable: false });
    ch.consume('hello', (msg) => {
        console.log('Получено:', msg.content.toString());
        ch.ack(msg);
    });
})();
```

## Совместимость с AMQP 0-9-1

Broko реализует подмножество AMQP 0-9-1, достаточное для полноценной работы с `amqplib` и аналогичными клиентами:

| Класс | Методы | Статус |
|-------|--------|--------|
| Connection | Start, Start-Ok, Tune, Tune-Ok, Open, Open-Ok, Close, Close-Ok | Полная поддержка |
| Channel | Open, Open-Ok, Close, Close-Ok, Flow, Flow-Ok | Полная поддержка |
| Exchange | Declare, Declare-Ok, Delete, Delete-Ok | Полная поддержка |
| Queue | Declare, Declare-Ok, Bind, Bind-Ok, Unbind, Unbind-Ok, Purge, Purge-Ok, Delete, Delete-Ok | Полная поддержка |
| Basic | Qos, Qos-Ok, Consume, Consume-Ok, Cancel, Cancel-Ok, Publish, Return, Deliver, Get, Get-Ok, Get-Empty, Ack, Reject, Recover, Recover-Ok, Nack | Полная поддержка |
| Confirm | Select, Select-Ok | Полная поддержка |
| Tx | Select, Select-Ok, Commit, Commit-Ok, Rollback, Rollback-Ok | Stub (accept/ack) |

### Ограничения

- Один virtual host (`/`)
- Tx-транзакции не атомарны (stub — select/commit/rollback принимаются, но не откатывают)
- Нет кластеризации и репликации
- Аутентификация: пароли в plaintext в `broker.users` (для production стоит добавить хеширование)
- Web UI и `/api/*` не имеют write-операций (read-only, через snapshot-файл `stats.json`)

## Аутентификация

Файл `broker.users` (по умолчанию `<data_dir>/broker.users`, переопределяется переменной окружения `BROKO_USERS_FILE` или 3-м CLI-аргументом):

```
# user:password — по одной паре на строку
guest:guest
admin:secret123
```

Если файл отсутствует — брокер работает в «permissive» режиме: принимает только `guest:guest`. Это сохраняет совместимость с дефолтами `amqplib` для тестов и быстрого старта.

## Web UI

Отдельный sidecar-контейнер `docker/webui/`:
- Express + статика, без AMQP-зависимостей
- Защищён HTTP Basic Auth (по умолчанию `admin` / `admin`, настраивается через `WEBUI_USER` / `WEBUI_PASS`)
- Эндпоинты `/api/overview`, `/api/queues`, `/api/exchanges`, `/api/connections`, `/api/stats`
- Frontend: vanilla JS, без сборщика, авто-обновление каждые 2с
- Источник данных: `stats.json`, который брокер пишет атомарно (`write + rename`) каждые 1.5с

## Самописный SDK

Минимальный Node.js клиент в [sdk/broko-client-js/](sdk/broko-client-js/), реализующий AMQP 0-9-1 wire-протокол с нуля поверх `net.Socket`. **Не зависит от `amqplib`.**

Используется в демо-сервисах `rpc-client`, `publisher-sdk`, `subscriber-sdk` параллельно с amqplib-версиями — это подтверждает совместимость брокера с обоими клиентами.

```js
const broko = require('broko-client');
const conn = await broko.connect('amqp://guest:guest@localhost:5672/');
const ch = await conn.createChannel();
await ch.assertQueue('hello');
ch.sendToQueue('hello', Buffer.from('hi'));
await ch.consume('hello', m => { console.log(m.content.toString()); ch.ack(m); });
```
