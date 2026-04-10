const amqp = require('amqplib');

const EXCHANGE = process.env.EXCHANGE || 'demo.exchange';
const ROUTING_KEY = process.env.ROUTING_KEY || 'demo.key';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '1000');
const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@localhost:5672/';

async function main() {
    const conn = await amqp.connect(BROKER_URL);
    const ch = await conn.createChannel();

    await ch.assertExchange(EXCHANGE, 'direct', { durable: true });
    console.log(`Publishing to exchange="${EXCHANGE}" key="${ROUTING_KEY}" every ${INTERVAL_MS}ms`);

    let seq = 0;
    setInterval(() => {
        seq++;
        const msg = JSON.stringify({
            seq,
            timestamp: new Date().toISOString(),
            payload: `Message #${seq}`
        });
        ch.publish(EXCHANGE, ROUTING_KEY, Buffer.from(msg), {
            persistent: true,
            contentType: 'application/json',
            messageId: `msg-${seq}`
        });
        console.log(`[${new Date().toISOString()}] Published #${seq}`);
    }, INTERVAL_MS);

    process.on('SIGINT', async () => {
        console.log('Shutting down publisher...');
        await ch.close();
        await conn.close();
        process.exit(0);
    });
}

main().catch(err => {
    console.error('Publisher error:', err.message);
    process.exit(1);
});
