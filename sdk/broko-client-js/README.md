# broko-client-js

Минимальный самописный AMQP 0-9-1 клиент для брокера Broko на чистом Node.js. **Не зависит от `amqplib`** — реализует wire-протокол с нуля поверх `net.Socket`.

Назначение — закрыть требование этапа 3 ТЗ: «SDK для любого ЯП (amqplib уже есть, но нужно простенький самописный SDK в финальной стадии)».

## Установка (локально)

```bash
cd sdk/broko-client-js
npm install   # без рантайм-зависимостей
```

## API

```js
const broko = require('broko-client-js');

(async () => {
    const conn = await broko.connect('amqp://guest:guest@localhost:5672/');
    const ch = await conn.createChannel();

    // Очередь
    await ch.assertQueue('hello', { durable: false });
    ch.sendToQueue('hello', Buffer.from('Привет из самописного SDK!'));

    // Exchange + binding
    await ch.assertExchange('demo.topic', 'topic', { durable: true });
    await ch.bindQueue('hello', 'demo.topic', 'hello.*');
    ch.publish('demo.topic', 'hello.world', Buffer.from('routed'), {
        persistent: true,
        priority: 5,
        contentType: 'text/plain',
    });

    // Consume
    await ch.consume('hello', (msg) => {
        console.log('Получено:', msg.content.toString());
        ch.ack(msg);
    });

    // Закрытие через ~3с
    setTimeout(async () => {
        await ch.close();
        await conn.close();
    }, 3000);
})();
```

## Поддерживаемые методы AMQP

| Класс | Методы |
|-------|--------|
| Connection | Start / Start-Ok / Tune / Tune-Ok / Open / Open-Ok / Close / Close-Ok |
| Channel | Open / Open-Ok / Close / Close-Ok |
| Exchange | Declare / Declare-Ok / Delete / Delete-Ok |
| Queue | Declare / Declare-Ok / Bind / Bind-Ok / Unbind / Unbind-Ok / Purge / Purge-Ok / Delete / Delete-Ok |
| Basic | Publish / Consume / Consume-Ok / Cancel / Cancel-Ok / Deliver / Return / Ack / Reject / Nack / Qos / Qos-Ok |
| Confirm | Select / Select-Ok |

Heartbeat — автоматическое поддержание соединения (отправка + детекция таймаута).

## Ограничения

- Нет встроенного `prefetch-size` (только `prefetch-count`).
- Нет `basic.get` (pull-режим) — только push через `consume`.
- Нет `tx.*` (транзакции) — на стороне брокера тоже stub.
- AMQP-механизм аутентификации — только PLAIN.

Для production-нагрузок используйте `amqplib`. Этот SDK — учебная реализация, демонстрирующая совместимость брокера.

## Файлы

- [index.js](index.js) — публичный API
- [lib/connection.js](lib/connection.js) — TCP, handshake, мультиплексирование, heartbeat
- [lib/channel.js](lib/channel.js) — методы Exchange/Queue/Basic/Confirm
- [lib/frame.js](lib/frame.js) — кодек кадров AMQP, parser
- [lib/methods.js](lib/methods.js) — константы class/method IDs (зеркало `src/amqp/methods.h`)
- [lib/types.js](lib/types.js) — кодек полей AMQP (big-endian, field tables)
- [examples/](examples/) — минимальные publisher/subscriber/smoke-тест
