'use strict';

// Дублёр publisher/index.js, использующий САМОПИСНЫЙ SDK вместо amqplib.
// Цель — продемонстрировать, что брокер совместим как с эталонным amqplib,
// так и с собственным минимальным AMQP-клиентом из sdk/broko-client-js/.

const broko = require('broko-client');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@broko:5672/';
const EXCHANGE = 'demo.orders';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '2000', 10);

const products = ['Widget A', 'Gadget B', 'Doohickey C', 'Thingamajig D'];

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
    console.log('[Publisher/SDK] Starting (using broko-client, not amqplib)...');
    const conn = await connectWithRetry(BROKER_URL);
    const ch = await conn.createChannel();

    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    console.log(`[Publisher/SDK] Exchange "${EXCHANGE}" ready`);

    let seq = 0;
    setInterval(() => {
        seq++;
        const product = products[seq % products.length];
        const priority = Math.floor(Math.random() * 5) + 1;
        const routingKey = `order.${priority > 3 ? 'high' : 'normal'}`;
        const order = {
            id: `SDK-${seq.toString().padStart(5, '0')}`,
            product,
            quantity: Math.floor(Math.random() * 10) + 1,
            priority,
            sentBy: 'broko-client-sdk',
            timestamp: new Date().toISOString(),
        };

        ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(order)), {
            persistent: true,
            contentType: 'application/json',
            priority,
            messageId: order.id,
        });

        console.log(`[Publisher/SDK] Sent order ${order.id}: ${order.quantity}x ${product} (${routingKey})`);
    }, INTERVAL_MS);

    process.on('SIGINT', async () => {
        try { await ch.close(); await conn.close(); } catch { /* ignore */ }
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('[Publisher/SDK] Fatal:', err.message);
    process.exit(1);
});
