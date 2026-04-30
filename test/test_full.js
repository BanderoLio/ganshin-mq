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
    console.log('Broko AMQP Integration Tests\n');

    const conn = await amqp.connect('amqp://guest:guest@localhost:5672/');

    // --- Test 1: Basic pub/sub ---
    await test('Basic pub/sub on direct queue', async () => {
        const ch = await conn.createChannel();
        const q = await ch.assertQueue('', { exclusive: true });
        ch.sendToQueue(q.queue, Buffer.from('hello'));
        const msg = await new Promise(resolve => {
            ch.consume(q.queue, resolve, { noAck: true });
        });
        if (msg.content.toString() !== 'hello') throw new Error('content mismatch');
        await ch.close();
    });

    // --- Test 2: Named exchange (fanout) ---
    await test('Fanout exchange', async () => {
        const ch = await conn.createChannel();
        await ch.assertExchange('test.fanout', 'fanout', { durable: false });
        const q1 = await ch.assertQueue('', { exclusive: true });
        const q2 = await ch.assertQueue('', { exclusive: true });
        await ch.bindQueue(q1.queue, 'test.fanout', '');
        await ch.bindQueue(q2.queue, 'test.fanout', '');

        const received = { q1: null, q2: null };
        await new Promise(resolve => {
            let count = 0;
            ch.consume(q1.queue, (msg) => { received.q1 = msg.content.toString(); if (++count === 2) resolve(); }, { noAck: true });
            ch.consume(q2.queue, (msg) => { received.q2 = msg.content.toString(); if (++count === 2) resolve(); }, { noAck: true });
            ch.publish('test.fanout', '', Buffer.from('fanout-msg'));
        });

        if (received.q1 !== 'fanout-msg' || received.q2 !== 'fanout-msg')
            throw new Error('fanout delivery failed');
        await ch.deleteExchange('test.fanout');
        await ch.close();
    });

    // --- Test 3: Topic exchange ---
    await test('Topic exchange with wildcards', async () => {
        const ch = await conn.createChannel();
        await ch.assertExchange('test.topic', 'topic', { durable: false });
        const q = await ch.assertQueue('', { exclusive: true });
        await ch.bindQueue(q.queue, 'test.topic', 'stock.*.nyse');

        const msgs = [];
        await new Promise(resolve => {
            ch.consume(q.queue, (msg) => {
                msgs.push(msg.content.toString());
                if (msgs.length === 1) resolve();
            }, { noAck: true });
            ch.publish('test.topic', 'stock.usd.nyse', Buffer.from('matched'));
            ch.publish('test.topic', 'stock.usd.nasdaq', Buffer.from('no-match'));
        });

        if (msgs.length !== 1 || msgs[0] !== 'matched')
            throw new Error('topic routing failed');
        await ch.deleteExchange('test.topic');
        await ch.close();
    });

    // --- Test 4: Message properties ---
    await test('Message properties preserved', async () => {
        const ch = await conn.createChannel();
        const q = await ch.assertQueue('', { exclusive: true });
        ch.sendToQueue(q.queue, Buffer.from('with-props'), {
            contentType: 'application/json',
            correlationId: 'abc-123',
            replyTo: 'reply-queue',
            headers: { 'x-custom': 'value' }
        });

        const msg = await new Promise(resolve => {
            ch.consume(q.queue, resolve, { noAck: true });
        });

        if (msg.properties.contentType !== 'application/json') throw new Error('contentType');
        if (msg.properties.correlationId !== 'abc-123') throw new Error('correlationId');
        if (msg.properties.replyTo !== 'reply-queue') throw new Error('replyTo');
        await ch.close();
    });

    // --- Test 5: Explicit ack ---
    await test('Explicit acknowledgement', async () => {
        const ch = await conn.createChannel();
        await ch.prefetch(1);
        const q = await ch.assertQueue('ack-test', { durable: false });
        await ch.purgeQueue('ack-test');
        ch.sendToQueue('ack-test', Buffer.from('ack-me'));

        const msg = await new Promise(resolve => {
            ch.consume('ack-test', resolve);
        });
        ch.ack(msg);

        if (msg.content.toString() !== 'ack-me') throw new Error('content mismatch');
        await ch.deleteQueue('ack-test');
        await ch.close();
    });

    // --- Test 6: Basic.get ---
    await test('Basic.get (synchronous pull)', async () => {
        const ch = await conn.createChannel();
        const q = await ch.assertQueue('get-test', { durable: false });
        ch.sendToQueue('get-test', Buffer.from('get-me'));

        // Small delay for message to be enqueued
        await new Promise(r => setTimeout(r, 100));

        const msg = await ch.get('get-test');
        if (!msg) throw new Error('get returned false');
        if (msg.content.toString() !== 'get-me') throw new Error('content mismatch');
        ch.ack(msg);
        await ch.deleteQueue('get-test');
        await ch.close();
    });

    // --- Test 7: Multiple channels ---
    await test('Multiple channels on one connection', async () => {
        const ch1 = await conn.createChannel();
        const ch2 = await conn.createChannel();
        const q1 = await ch1.assertQueue('', { exclusive: true });
        const q2 = await ch2.assertQueue('', { exclusive: true });

        ch1.sendToQueue(q2.queue, Buffer.from('ch1->ch2'));
        ch2.sendToQueue(q1.queue, Buffer.from('ch2->ch1'));

        const [msg1, msg2] = await Promise.all([
            new Promise(resolve => ch1.consume(q1.queue, resolve, { noAck: true })),
            new Promise(resolve => ch2.consume(q2.queue, resolve, { noAck: true })),
        ]);

        if (msg1.content.toString() !== 'ch2->ch1') throw new Error('ch1 msg wrong');
        if (msg2.content.toString() !== 'ch1->ch2') throw new Error('ch2 msg wrong');
        await ch1.close();
        await ch2.close();
    });

    // --- Test 8: Unacked requeue on channel close ---
    await test('Unacked messages are requeued when channel closes', async () => {
        const ch1 = await conn.createChannel();
        const ch2 = await conn.createChannel();
        await ch1.assertQueue('requeue-on-close-test', { durable: false });
        await ch1.purgeQueue('requeue-on-close-test');
        await ch1.prefetch(1);

        ch1.sendToQueue('requeue-on-close-test', Buffer.from('must-return'));

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('no delivery to first consumer')), 2000);
            ch1.consume('requeue-on-close-test', async (msg) => {
                clearTimeout(timer);
                if (!msg) return reject(new Error('null message'));
                try {
                    await ch1.close(); // close without ACK: broker must requeue
                    resolve();
                } catch (err) {
                    reject(err);
                }
            }, { noAck: false }).catch(reject);
        });

        await new Promise(r => setTimeout(r, 150));

        const redelivered = await ch2.get('requeue-on-close-test');
        if (!redelivered) throw new Error('message was not requeued');
        if (redelivered.content.toString() !== 'must-return')
            throw new Error('content mismatch after requeue');
        if (!redelivered.fields.redelivered)
            throw new Error('expected redelivered flag after requeue');

        ch2.ack(redelivered);
        await ch2.deleteQueue('requeue-on-close-test');
        await ch2.close();
    });

    await conn.close();

    console.log(`\nResults: ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

setTimeout(() => { console.error('Timed out'); process.exit(1); }, 30000);
main().catch(err => { console.error('Fatal:', err); process.exit(1); });
