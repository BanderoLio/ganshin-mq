'use strict';

// RPC-клиент. Шлёт случайные арифметические запросы в `rpc.calculate` и логирует ответы.
// Использует САМОПИСНЫЙ SDK `broko-client` (не amqplib) — это часть демо обязательного
// требования этапа 3 ТЗ ("самописный SDK в финальной стадии").

const broko = require('broko-client');

const BROKER_URL = process.env.BROKER_URL || 'amqp://guest:guest@broko:5672/';
const RPC_QUEUE = 'rpc.calculate';
const INTERVAL_MS = parseInt(process.env.INTERVAL_MS || '3000', 10);

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

function randInt(n) { return Math.floor(Math.random() * n); }
const OPERATIONS = ['add', 'subtract', 'multiply', 'divide'];

async function main() {
    console.log('[RPC Client] Starting (SDK=broko-client)...');
    const conn = await connectWithRetry(BROKER_URL);
    const ch = await conn.createChannel();

    // Эксклюзивная reply-queue (имя сгенерирует сервер)
    const decl = await ch.assertQueue('', { exclusive: true, autoDelete: true });
    const replyQueue = decl.queue;
    console.log(`[RPC Client] reply queue: ${replyQueue}`);

    const pending = new Map();   // correlationId -> { resolve, reject, timer }
    let seq = 0;

    await ch.consume(replyQueue, (msg) => {
        const cid = msg.properties && msg.properties.correlationId;
        ch.ack(msg);
        const slot = cid && pending.get(cid);
        if (!slot) return;
        pending.delete(cid);
        clearTimeout(slot.timer);
        slot.resolve(JSON.parse(msg.content.toString()));
    }, { noAck: false });

    function rpcCall(op, a, b) {
        return new Promise((resolve, reject) => {
            seq++;
            const cid = `rpc-${process.pid}-${seq}`;
            const timer = setTimeout(() => {
                pending.delete(cid);
                reject(new Error('timeout'));
            }, 5000);
            pending.set(cid, { resolve, reject, timer });
            ch.publish('', RPC_QUEUE, Buffer.from(JSON.stringify({ operation: op, a, b })), {
                contentType: 'application/json',
                correlationId: cid,
                replyTo: replyQueue,
            });
        });
    }

    setInterval(async () => {
        const op = OPERATIONS[randInt(OPERATIONS.length)];
        const a = randInt(100), b = randInt(10) + 1;
        try {
            const t0 = Date.now();
            const res = await rpcCall(op, a, b);
            console.log(`[RPC Client] ${op}(${a}, ${b}) = ${res.result}  (${Date.now() - t0}ms)`);
        } catch (e) {
            console.error('[RPC Client] error:', e.message);
        }
    }, INTERVAL_MS);

    process.on('SIGINT', async () => {
        try { await ch.close(); await conn.close(); } catch { /* ignore */ }
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('[RPC Client] Fatal:', err.message);
    process.exit(1);
});
