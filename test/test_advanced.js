const amqp = require('amqplib');

let passed = 0, failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS: ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL: ${name} — ${err.message}`);
        failed++;
    }
}

async function main() {
    console.log('Broko Advanced Feature Tests\n');

    const conn = await amqp.connect('amqp://guest:guest@localhost:5672/');

    // --- Test 1: Message TTL ---
    await test('Message TTL (per-queue)', async () => {
        const ch = await conn.createChannel();
        // Queue with 500ms TTL
        await ch.assertQueue('ttl-test', {
            durable: false,
            arguments: { 'x-message-ttl': 500 }
        });
        ch.sendToQueue('ttl-test', Buffer.from('should-expire'));

        // Wait for expiry
        await new Promise(r => setTimeout(r, 1000));

        const msg = await ch.get('ttl-test');
        if (msg !== false) throw new Error('Message should have expired');
        await ch.deleteQueue('ttl-test');
        await ch.close();
    });

    // --- Test 2: Dead Letter Exchange ---
    await test('Dead Letter Exchange (DLX)', async () => {
        const ch = await conn.createChannel();

        // DLX setup
        await ch.assertExchange('dlx', 'direct', { durable: false });
        await ch.assertQueue('dead-letters', { durable: false });
        await ch.bindQueue('dead-letters', 'dlx', 'dlx-key');

        // Source queue with TTL + DLX
        await ch.assertQueue('dlx-source', {
            durable: false,
            arguments: {
                'x-message-ttl': 300,
                'x-dead-letter-exchange': 'dlx',
                'x-dead-letter-routing-key': 'dlx-key'
            }
        });

        ch.sendToQueue('dlx-source', Buffer.from('will-be-dead-lettered'));

        // Wait for TTL expiry + DLX routing
        await new Promise(r => setTimeout(r, 800));

        // The message should now be in the dead-letters queue
        const msg = await ch.get('dead-letters');
        if (!msg) throw new Error('No dead-lettered message found');
        if (msg.content.toString() !== 'will-be-dead-lettered')
            throw new Error('Content mismatch');
        ch.ack(msg);

        await ch.deleteQueue('dlx-source');
        await ch.deleteQueue('dead-letters');
        await ch.deleteExchange('dlx');
        await ch.close();
    });

    // --- Test 3: Per-message TTL ---
    await test('Per-message TTL via expiration property', async () => {
        const ch = await conn.createChannel();
        await ch.assertQueue('pmttl-test', { durable: false });
        ch.sendToQueue('pmttl-test', Buffer.from('short-lived'), { expiration: '300' });
        ch.sendToQueue('pmttl-test', Buffer.from('long-lived'), { expiration: '60000' });

        await new Promise(r => setTimeout(r, 600));

        const msg = await ch.get('pmttl-test');
        if (!msg) throw new Error('No message found');
        if (msg.content.toString() !== 'long-lived')
            throw new Error('Expected long-lived message, got: ' + msg.content.toString());
        ch.ack(msg);

        await ch.deleteQueue('pmttl-test');
        await ch.close();
    });

    // --- Test 4: Priority queues ---
    await test('Message priorities', async () => {
        const ch = await conn.createChannel();
        await ch.assertQueue('priority-test', {
            durable: false,
            arguments: { 'x-max-priority': 10 }
        });

        // Send low, then high priority
        ch.sendToQueue('priority-test', Buffer.from('low'), { priority: 1 });
        ch.sendToQueue('priority-test', Buffer.from('high'), { priority: 9 });

        // Small delay for both to be enqueued
        await new Promise(r => setTimeout(r, 100));

        const msg1 = await ch.get('priority-test');
        const msg2 = await ch.get('priority-test');
        if (!msg1 || !msg2) throw new Error('Missing messages');

        // High priority should come first
        if (msg1.content.toString() !== 'high')
            throw new Error('Expected high priority first, got: ' + msg1.content.toString());
        if (msg2.content.toString() !== 'low')
            throw new Error('Expected low priority second');

        ch.ack(msg1);
        ch.ack(msg2);
        await ch.deleteQueue('priority-test');
        await ch.close();
    });

    // --- Test 5: Reject with no requeue -> DLX ---
    await test('Reject without requeue goes to DLX', async () => {
        const ch = await conn.createChannel();

        await ch.assertExchange('reject-dlx', 'direct', { durable: false });
        await ch.assertQueue('reject-dl', { durable: false });
        await ch.bindQueue('reject-dl', 'reject-dlx', 'rejected');

        await ch.assertQueue('reject-source', {
            durable: false,
            arguments: {
                'x-dead-letter-exchange': 'reject-dlx',
                'x-dead-letter-routing-key': 'rejected'
            }
        });

        ch.sendToQueue('reject-source', Buffer.from('reject-me'));
        await new Promise(r => setTimeout(r, 100));

        const msg = await ch.get('reject-source');
        if (!msg) throw new Error('No message to reject');
        ch.reject(msg, false); // reject, no requeue

        await new Promise(r => setTimeout(r, 200));
        const dlMsg = await ch.get('reject-dl');
        if (!dlMsg) throw new Error('No dead-lettered message');
        if (dlMsg.content.toString() !== 'reject-me') throw new Error('Content mismatch');
        ch.ack(dlMsg);

        await ch.deleteQueue('reject-source');
        await ch.deleteQueue('reject-dl');
        await ch.deleteExchange('reject-dlx');
        await ch.close();
    });

    // --- Test 6: Tx stubs (verify channel is stable; amqplib cannot send Tx methods) ---
    await test('Tx stubs — channel stable after pub/sub', async () => {
        const ch = await conn.createChannel();
        await ch.assertQueue('tx-test', { durable: false });

        ch.sendToQueue('tx-test', Buffer.from('tx-msg'));
        await new Promise(r => setTimeout(r, 100));
        const msg = await ch.get('tx-test');
        if (!msg) throw new Error('No message');
        if (msg.content.toString() !== 'tx-msg') throw new Error('Content mismatch');
        ch.ack(msg);
        await ch.deleteQueue('tx-test');
        await ch.close();
    });

    // --- Test 7: Publisher Confirms ---
    await test('Publisher confirms (confirm channel)', async () => {
        const ch = await conn.createConfirmChannel();
        await ch.assertQueue('confirm-test', { durable: false });

        await new Promise((resolve, reject) => {
            ch.sendToQueue('confirm-test', Buffer.from('confirmed'), {}, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        const msg = await ch.get('confirm-test');
        if (!msg) throw new Error('No message');
        if (msg.content.toString() !== 'confirmed') throw new Error('Content mismatch');
        ch.ack(msg);
        await ch.deleteQueue('confirm-test');
        await ch.close();
    });

    await conn.close();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => { console.error('Timed out'); process.exit(1); }, 30000);
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
