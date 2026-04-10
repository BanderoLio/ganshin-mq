const amqp = require('amqplib');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@broko:5672/';
const EXCHANGE = 'demo.orders';
const QUEUE = process.env.QUEUE_NAME || 'order-processor';
const BINDING_KEY = process.env.BINDING_KEY || 'order.#';

async function connectWithRetry(url, maxRetries = 15) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await amqp.connect(url);
        } catch {
            console.log(`Waiting for broker... (attempt ${i + 1}/${maxRetries})`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }
    throw new Error('Could not connect to broker');
}

async function main() {
    console.log(`[Subscriber:${QUEUE}] Starting...`);
    const conn = await connectWithRetry(BROKER_URL);
    const ch = await conn.createChannel();
    await ch.prefetch(5);

    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(QUEUE, {
        durable: true,
        arguments: { 'x-max-priority': 10 }
    });
    await ch.bindQueue(QUEUE, EXCHANGE, BINDING_KEY);

    console.log(`[Subscriber:${QUEUE}] Consuming (binding="${BINDING_KEY}")`);

    let count = 0;
    ch.consume(QUEUE, (msg) => {
        if (!msg) return;
        count++;
        const order = JSON.parse(msg.content.toString());
        const processingTime = Math.floor(Math.random() * 500) + 100;

        console.log(`[Subscriber:${QUEUE}] Processing ${order.id}: ${order.quantity}x ${order.product} (priority=${order.priority})`);

        setTimeout(() => {
            ch.ack(msg);
            console.log(`[Subscriber:${QUEUE}] Completed ${order.id} (${processingTime}ms)`);
        }, processingTime);
    });

    process.on('SIGINT', async () => {
        console.log(`[Subscriber:${QUEUE}] Shutting down (${count} processed)`);
        await ch.close();
        await conn.close();
        process.exit(0);
    });
}

main().catch(err => { console.error(`[Subscriber:${QUEUE}] Fatal:`, err.message); process.exit(1); });
