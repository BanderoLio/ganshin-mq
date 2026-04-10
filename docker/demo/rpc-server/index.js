const amqp = require('amqplib');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@broko:5672/';
const RPC_QUEUE = 'rpc.calculate';

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
    console.log('[RPC Server] Starting...');
    const conn = await connectWithRetry(BROKER_URL);
    const ch = await conn.createChannel();
    await ch.prefetch(1);

    await ch.assertQueue(RPC_QUEUE, { durable: false });
    console.log(`[RPC Server] Awaiting requests on "${RPC_QUEUE}"`);

    ch.consume(RPC_QUEUE, (msg) => {
        if (!msg) return;

        const request = JSON.parse(msg.content.toString());
        console.log(`[RPC Server] Request: ${request.operation}(${request.a}, ${request.b})`);

        let result;
        switch (request.operation) {
            case 'add':      result = request.a + request.b; break;
            case 'subtract': result = request.a - request.b; break;
            case 'multiply': result = request.a * request.b; break;
            case 'divide':   result = request.b !== 0 ? request.a / request.b : null; break;
            default:         result = null;
        }

        const response = JSON.stringify({ result, operation: request.operation });

        ch.sendToQueue(msg.properties.replyTo, Buffer.from(response), {
            correlationId: msg.properties.correlationId,
            contentType: 'application/json'
        });
        ch.ack(msg);
        console.log(`[RPC Server] Response: ${result}`);
    });

    process.on('SIGINT', async () => {
        await ch.close();
        await conn.close();
        process.exit(0);
    });
}

main().catch(err => { console.error('[RPC Server] Fatal:', err.message); process.exit(1); });
