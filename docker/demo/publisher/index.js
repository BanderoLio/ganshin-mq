const amqp = require('amqplib');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@broko:5672/';
const EXCHANGE = 'demo.orders';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '2000');

const products = ['Widget A', 'Gadget B', 'Doohickey C', 'Thingamajig D'];

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
    console.log('[Publisher] Starting...');
    const conn = await connectWithRetry(BROKER_URL);
    const ch = await conn.createChannel();

    await ch.assertExchange(EXCHANGE, 'topic', { durable: true });
    console.log(`[Publisher] Exchange "${EXCHANGE}" ready`);

    let seq = 0;
    setInterval(() => {
        seq++;
        const product = products[seq % products.length];
        const priority = Math.floor(Math.random() * 5) + 1;
        const routingKey = `order.${priority > 3 ? 'high' : 'normal'}`;
        const order = {
            id: `ORD-${seq.toString().padStart(5, '0')}`,
            product,
            quantity: Math.floor(Math.random() * 10) + 1,
            priority,
            timestamp: new Date().toISOString()
        };

        ch.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(order)), {
            persistent: true,
            contentType: 'application/json',
            priority,
            messageId: order.id
        });

        console.log(`[Publisher] Sent order ${order.id}: ${order.quantity}x ${product} (${routingKey})`);
    }, INTERVAL_MS);

    process.on('SIGINT', async () => {
        await ch.close();
        await conn.close();
        process.exit(0);
    });
}

main().catch(err => { console.error('[Publisher] Fatal:', err.message); process.exit(1); });
