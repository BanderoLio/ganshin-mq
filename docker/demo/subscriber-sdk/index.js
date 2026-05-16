'use strict';

// Дублёр subscriber/index.js, использующий САМОПИСНЫЙ SDK вместо amqplib.

const broko = require('broko-client');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@broko:5672/';
const EXCHANGE = 'demo.orders';
const QUEUE = process.env.QUEUE_NAME || 'sdk-order-processor';
const BINDING_KEY = process.env.BINDING_KEY || 'order.#';

async function connectWithRetry(url, maxRetries = 15) {
    for (let i = 0; i < maxRetries; i++) {
        try { return await broko.connect(url); }
        catch (e) {
            console.log(`Waiting for broker... (attempt ${i + 1}/${maxRetries}: ${e.message})`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error('Could not connect to broker');
}

async function main() {
    console.log(`[Subscriber/SDK:${QUEUE}] Starting (using broko-client, not amqplib)...`);
    const conn = await connectWithRetry(BROKER_URL);
    const ch = await conn.createChannel();
    await ch.prefetch(5);

    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(QUEUE, {
        durable: true,
        arguments: { 'x-max-priority': 10 },
    });
    await ch.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);

    console.log(`[Subscriber/SDK:${QUEUE}] Consuming (binding="${BINDING_KEY}")`);

    let count = 0;
    await ch.consume(QUEUE, (msg) => {
        if (!msg) return;
        count++;
        let order;
        try { order = JSON.parse(msg.content.toString()); }
        catch { order = { id: '<bad-json>', product: '?', quantity: 0, priority: 0 }; }
        const processingTime = Math.floor(Math.random() * 500) + 100;

        console.log(`[Subscriber/SDK:${QUEUE}] Processing ${order.id}: ${order.quantity}x ${order.product} (priority=${order.priority})`);

        setTimeout(() => {
            ch.ack(msg);
            console.log(`[Subscriber/SDK:${QUEUE}] Completed ${order.id} (${processingTime}ms)`);
        }, processingTime);
    });

    process.on('SIGINT', async () => {
        console.log(`[Subscriber/SDK:${QUEUE}] Shutting down (${count} processed)`);
        try { await ch.close(); await conn.close(); } catch { /* ignore */ }
        process.exit(0);
    });
}

main().catch((err) => {
    console.error(`[Subscriber/SDK:${QUEUE}] Fatal:`, err.message);
    process.exit(1);
});
