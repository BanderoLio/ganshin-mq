# Broko — AMQP 0-9-1 Message Broker

Брокер сообщений, написанный на C++ с полной поддержкой протокола AMQP 0-9-1. Совместим с клиентской библиотекой `amqplib` для Node.js и другими AMQP-клиентами.

## Документация и цели (этап 1: проектирование)

| Документ | Содержание |
|----------|------------|
| [MessageBrokerRequirements.md](MessageBrokerRequirements.md) | Цели курса, обязательные требования, этапы сдачи (в т.ч. **этап 1** — полный набор проектной документации). |
| [docs/ARCHITECTURE_AND_DESIGN.md](docs/ARCHITECTURE_AND_DESIGN.md) | Архитектура (слои монолита), **структура данных** (сообщения, метаданные, exchanges/queues, WAL), **обоснование стека**, **план реализации** модулей, чек-лист этапа 1. |

**Цель проекта** (сводка): асинхронный обмен сообщениями между сервисами через AMQP, с очередями и персистентностью; **обязательная** совместимость с клиентом **amqplib** на Node.js. Подробные требования — в `MessageBrokerRequirements.md`.

## Архитектура

```mermaid
graph TB
    subgraph Клиенты
        P1[Publisher]
        P2[Publisher]
        S1[Subscriber]
        S2[Subscriber]
    end

    subgraph "Broko Broker"
        NET["TCP / Boost.Asio<br/>(многопоточный io_context)"]
        CONN["Connection Manager<br/>(AMQP handshake, heartbeat,<br/>SASL аутентификация)"]
        CH["Channel Multiplexer<br/>(до 2047 каналов на соединение)"]

        subgraph "AMQ Model"
            EX["Exchanges<br/>(direct, fanout, topic, headers)"]
            Q["Queues<br/>(TTL, приоритеты, DLX)"]
            BIND["Bindings<br/>(routing key + arguments)"]
        end

        WAL["WAL Persistence<br/>(файловая система)"]
    end

    P1 & P2 -->|AMQP 0-9-1| NET
    S1 & S2 -->|AMQP 0-9-1| NET
    NET --> CONN --> CH
    CH --> EX
    EX -->|route| BIND
    BIND --> Q
    Q -->|deliver| CH
    Q -.->|durable messages| WAL
    EX -.->|durable exchanges| WAL
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

## Структура проекта

```
Broko/
├── docs/
│   └── ARCHITECTURE_AND_DESIGN.md  # Этап 1: архитектура, данные, стек, план
├── src/
│   ├── main.cpp                    # Точка входа, настройка io_context
│   ├── amqp/
│   │   ├── types.h                 # FieldTable, FieldValue, Buffer (big-endian I/O)
│   │   ├── frame.h                 # Типы фреймов, константы протокола
│   │   ├── methods.h               # ID классов и методов AMQP
│   │   └── content.h               # BasicProperties (14 полей content header)
│   ├── broker/
│   │   ├── server.h/cpp            # TCP acceptor, tick-таймер
│   │   ├── connection.h/cpp        # AMQP state machine, heartbeat, framing
│   │   ├── channel.h/cpp            # Обработка методов Exchange/Queue/Basic/Confirm/Tx
│   │   ├── vhost.h                 # Virtual Host — контейнер exchanges/queues
│   │   ├── exchange.h              # Direct, Fanout, Topic, Headers exchanges
│   │   ├── queue.h                 # MessageQueue с TTL, DLX, priorities
│   │   ├── consumer.h              # Структура Consumer
│   │   └── message.h               # Структура Message
│   └── storage/
│       └── message_store.h         # WAL-персистентность (бинарный формат)
├── test/
│   ├── test_connect.js             # Базовый тест подключения
│   ├── test_full.js                # 7 интеграционных тестов
│   ├── test_advanced.js            # 7 тестов (TTL, DLX, приоритеты, confirms)
│   ├── test_persistence.js         # Тест персистентности (перезапуск брокера)
│   ├── publisher.js                # Демо publisher
│   └── subscriber.js               # Демо subscriber
├── docker/
│   ├── Dockerfile                  # Multi-stage сборка брокера
│   ├── docker-compose.yml          # Брокер + демо-микросервисы
│   └── demo/                       # Node.js демо-сервисы
├── CMakeLists.txt
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

### Docker

```bash
cd docker

# Собрать и запустить только брокер
docker compose up broko

# Запустить брокер + демо-микросервисы (publisher, 2 subscribers, RPC server)
docker compose up
```

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
- Аутентификация принимает любые credentials (нет ACL)
- Tx-транзакции не атомарны (stub — select/commit/rollback принимаются, но не откатывают)
- Нет кластеризации и репликации
- Нет Management API / Web UI
