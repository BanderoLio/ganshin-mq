# Broko — сценарий финального демо

Цель: за 8–10 минут показать соответствие требованиям ТЗ (этапы 1–4) и работающую инфраструктуру.

Отчет для финальной сдачи: [FINAL_REPORT.md](FINAL_REPORT.md) (критерии системы оценивания, привязка к файлам, допфункционал).

**Минимум для запуска:** Docker + Docker Compose. Всё остальное (брокер, демо-микросервисы, Web UI) поднимается из контейнеров.

```bash
make demo            # запуск
make demo-logs       # логи в реальном времени
make demo-down       # остановка + очистка volumes
```

Web UI: <http://localhost:15672> (логин `admin` / пароль `admin`).
AMQP: `amqp://guest:guest@localhost:5672/`.

---

## Состав демо-стенда (`docker compose up`)

| Сервис | Назначение | Клиентская библиотека |
|--------|------------|------------------------|
| **broko** | Брокер сообщений (C++, AMQP 0-9-1) на порту 5672 | — |
| **publisher** | Каждые 2с шлёт заказы в topic exchange `demo.orders` | amqplib |
| **subscriber-all** | Получает все заказы (`order.#`) | amqplib |
| **subscriber-high** | Получает только high-priority заказы (`order.high`) | amqplib |
| **rpc-server** | Calculator RPC-сервис | amqplib |
| **rpc-client** | Шлёт RPC-запросы в `rpc.calculate` | **broko-client (самописный SDK)** |
| **publisher-sdk** | Аналог publisher, но на самописном SDK | **broko-client** |
| **subscriber-sdk** | Аналог subscriber на самописном SDK | **broko-client** |
| **webui** | HTTP UI на порту 15672 | — |

---

## Шаги демо

### 1. Запуск (~1 мин)

```bash
make demo
```

Что произойдёт:
- Соберётся образ брокера (multi-stage Docker, C++23 + Boost.Asio).
- Соберётся образ демо-сервисов (Node.js 22, amqplib + самописный `broko-client`).
- Соберётся образ webui sidecar.
- Поднимутся 9 контейнеров.
- Брокер дойдёт до состояния `healthy`.

### 2. Web UI (~1.5 мин)

Открыть <http://localhost:15672>, авторизоваться (admin / admin).

Показать:
- **Overview** — KPI: соединения, очереди, exchanges, сообщения. «Top очереди по глубине» — видно, как заказы накапливаются.
- **Queues** — очереди `all-orders`, `high-priority-orders`, `sdk-order-processor`, `rpc.calculate`, плюс `amq.gen-*` от RPC-клиента. Указатели `durable`, `consumers`, `messages`.
- **Exchanges** — `demo.orders` (topic), все стандартные `amq.*`.
- **Connections** — 5+ активных соединений: видно, кто подключён, под каким user, peer-адрес.

UI автообновляется каждые 2 секунды (читает `stats.json`, который брокер дампит каждые 1.5с).

### 3. Логи (~2 мин)

В другом терминале:

```bash
make demo-logs
```

Прокомментировать:
- `[Publisher]` — отправка заказов с приоритетами и routing key.
- `[Subscriber:all-orders]` — Processing → Completed.
- `[Subscriber:high-priority-orders]` — обрабатывает только `order.high` (показывает работу topic-маршрутизации).
- `[RPC Client]` — Request/Response через correlation_id + reply_to.
- `[Publisher/SDK]`, `[Subscriber/SDK]` — то же самое, но через самописный SDK.

### 4. Демонстрация персистентности (~1 мин)

```bash
docker compose -f docker/docker-compose.yml restart broko
```

В логах брокера будет:
```
Recovered N exchanges, M queues, ... bindings, ... messages
```

В Web UI status-индикатор кратко уйдёт в offline и вернётся. Publisher/subscriber переподключаются автоматически. Сообщения durable не теряются.

### 5. TTL / DLX / Приоритеты (~1.5 мин)

В отдельном терминале:

```bash
cd test && npm install
node test_advanced.js
```

Покажет 7 пройденных кейсов: per-queue TTL, DLX, per-message TTL, priorities, reject→DLX, tx-stubs, publisher confirms.

### 6. Аутентификация (~1 мин)

```bash
# Корректные creds — успех
node -e "require('amqplib').connect('amqp://guest:guest@localhost:5672/').then(() => console.log('OK'))"

# Неверный пароль — отказ с 403
node -e "require('amqplib').connect('amqp://guest:wrong@localhost:5672/').catch(e => console.log('REJECTED:', e.message))"
```

Ответ:
```
REJECTED: Handshake terminated by server: 403 (ACCESS-REFUSED) with message "ACCESS_REFUSED - Login was refused using authentication mechanism PLAIN"
```

В docker-compose пользователи задаются файлом `data/broker.users` (формат `user:password` на строку, fallback на `guest:guest` если файл отсутствует).

### 7. Демонстрация самописного SDK (~1 мин)

Подсветить:
- В `docker-compose.yml` сервисы `publisher` и `publisher-sdk` идентичны по поведению, но используют разные клиентские библиотеки:
  - `publisher/index.js`: `require('amqplib')` — эталонный AMQP-клиент.
  - `publisher-sdk/index.js`: `require('broko-client')` — собственный SDK из `sdk/broko-client-js/`, реализующий AMQP 0-9-1 с нуля поверх `net.Socket`.
- Оба коннектятся к одному и тому же брокеру и получают одинаковый результат.
- `rpc-client` — полностью на самописном SDK, демонстрирует request/response с `correlationId` + `replyTo`.
- В Web UI на вкладке **Connections** видно одновременно соединения от обеих библиотек.

### 8. Резюме (~1 мин)

Чек-лист требований ТЗ:

**Обязательные (этап 2 + 3):**
- ✅ Pub/Sub паттерн
- ✅ Очереди (FIFO + priorities)
- ✅ Топики (через exchanges direct/fanout/topic/headers)
- ✅ Multiple subscribers (round-robin)
- ✅ Персистентность на диск (WAL), recovery после restart
- ✅ AMQP 0-9-1 совместимость с `amqplib`
- ✅ Гарантия доставки at-least-once (через ack + persistent flag)
- ✅ **Самописный SDK** (`sdk/broko-client-js/`)

**Дополнительные:**
- ✅ TTL сообщений (per-queue + per-message)
- ✅ Dead Letter Exchange (DLX)
- ✅ Приоритеты сообщений
- ✅ Аутентификация (`broker.users` + 403 reject)
- ✅ Web UI с реалтайм-метриками

**Технические:**
- ✅ Язык: C++23
- ✅ Хранение: собственный WAL на ФС
- ✅ Протокол: AMQP 0-9-1
- ✅ Документация: [README.md](README.md), [docs/ARCHITECTURE_AND_DESIGN.md](docs/ARCHITECTURE_AND_DESIGN.md)
- ✅ Деплой: Docker + docker-compose (Linux)

---

## Сценарии вопросов и ответов

**Q: Почему «свой» SDK, а не просто amqplib?**
А: ТЗ требует именно собственный SDK в финальной стадии. amqplib используется в тестах и части демо-сервисов для подтверждения совместимости с эталонным клиентом, а `broko-client` (мин. 500 строк JS) — самостоятельная реализация wire-протокола поверх `net.Socket`.

**Q: Где гарантия at-least-once?**
А: Сообщение записывается в WAL (`storeMessage` с `fdatasync`) ДО отправки `basic.deliver` потребителю. Ack от потребителя пишется в WAL только после receive. При рестарте незаконфирмированные сообщения восстанавливаются из WAL.

**Q: Безопасность паролей?**
А: В текущей реализации plaintext в `broker.users` — для demo достаточно. В production стоит заменить на хеширование (bcrypt/argon2 + соль). Структура `UserStore` ([src/broker/auth.h](src/broker/auth.h)) изолирована и легко расширяется.

**Q: Как Web UI узнаёт о состоянии брокера, если они на разных языках?**
А: Брокер пишет JSON-снапшот `stats.json` в shared volume каждые 1.5с (атомарно через `write + rename`). Web UI sidecar читает его при каждом HTTP-запросе. Никаких языковых/протокольных привязок между ними нет — это намеренное решение для развязки.

**Q: Что осталось «на потом»?**
А: Кластеризация/репликация (single-node), Prometheus metrics endpoint, хешированные пароли, Tx-транзакции (сейчас accept-stubs), Protobuf-схемы сообщений.
