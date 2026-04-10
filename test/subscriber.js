const amqp = require('amqplib');

const EXCHANGE = process.env.EXCHANGE || 'demo.exchange';
const ROUTING_KEY = process.env.ROUTING_KEY || 'demo.key';
const QUEUE = process.env.QUEUE || 'demo.queue';
const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672/';

async function main() {
    const conn = await amqp.connect(BROKER_URL);
    const ch = await conn.createChannel();
    await ch.prefetch(10);

    await ch.assertExchange(EXCHANGE, 'direct', { durable: true });
    await ch.assertQueue(QUEUE, { durable: true });
    await ch.bindQueue(QUEUE, EXCHANGE, ROUTING_KEY);

    console.log(`Consuming from queue="${QUEUE}" (exchange="${EXCHANGE}" key="${ROUTING_KEY}")`);

    let count = 0;
    ch.consume(QUEUE, (msg) => {
        if (!msg) return;
        count++;
        const body = JSON.parse(msg.content.toString());
        console.log(`[${new Date().toISOString()}] Received #${body.seq}: ${body.payload}`);
        ch.ack(msg);
    });

    process.on('SIGINT', async () => {
        console.log(`Shutting down subscriber (${count} messages received)...`);
        await ch.close();
        await conn.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Subscriber error:', err.message);
    process.exit(1);
});
