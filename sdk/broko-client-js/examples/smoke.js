'use strict';

// Smoke-тест самописного SDK против запущенного Broko.
// Запуск: BROKER_URL=amqp://guest:guest@localhost:5672/ node smoke.js

const broko = require('..');

const URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672/';

async function main() {
    console.log('[smoke] connecting to', URL);
    const conn = await broko.connect(URL);
    console.log('[smoke] connected');

    const ch = await conn.createChannel();
    console.log('[smoke] channel opened');

    const queue = 'broko-sdk-smoke-' + process.pid;

    // 1. Объявление очереди
    const decl = await ch.assertQueue(queue, { durable: false, autoDelete: true });
    console.log('[smoke] queue declared:', decl);

    // 2. Topic exchange + binding
    await ch.assertExchange('broko-sdk-topic', 'topic', { autoDelete: true });
    await ch.bindQueue(queue, 'broko-sdk-topic', 'sdk.*');

    // 3. Один consumer, ждём 2 сообщения
    const received = [];
    let resolveAll;
    const done = new Promise((r) => { resolveAll = r; });

    await ch.consume(queue, (m) => {
        received.push({
            content: m.content.toString(),
            routingKey: m.fields.routingKey,
            priority: m.properties.priority,
        });
        ch.ack(m);
        if (received.length === 2) resolveAll();
    });

    // 4. Publish #1 — напрямую в очередь через default exchange
    ch.sendToQueue(queue, Buffer.from('hello direct'),
        { contentType: 'text/plain', priority: 3 });
    console.log('[smoke] published direct');

    // 5. Publish #2 — через topic exchange
    ch.publish('broko-sdk-topic', 'sdk.test', Buffer.from('hello via topic'),
        { persistent: false });
    console.log('[smoke] published via topic');

    // 6. Ждём оба
    const timer = setTimeout(() => {
        throw new Error('Timeout waiting for messages');
    }, 5000);
    await done;
    clearTimeout(timer);

    console.log('[smoke] received', received.length, 'messages:');
    for (const m of received) console.log('  -', JSON.stringify(m));

    await ch.close();
    await conn.close();
    console.log('[smoke] OK');
}

main().catch((err) => {
    console.error('[smoke] FAIL:', err.message);
    process.exit(1);
});
