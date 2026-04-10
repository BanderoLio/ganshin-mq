const amqp = require('amqplib');

async function main() {
    console.log('Connecting to Broko...');
    try {
        const conn = await amqp.connect('amqp://guest:guest@localhost:5672/');
        console.log('Connected!');

        const ch = await conn.createChannel();
        console.log('Channel created!');

        const queueName = 'test-queue';
        await ch.assertQueue(queueName, { durable: false });
        console.log(`Queue "${queueName}" declared.`);

        const msg = 'Hello from amqplib!';
        ch.sendToQueue(queueName, Buffer.from(msg));
        console.log(`Sent: "${msg}"`);

        const received = await new Promise((resolve) => {
            ch.consume(queueName, (msg) => {
                resolve(msg.content.toString());
                ch.ack(msg);
            });
        });
        console.log(`Received: "${received}"`);

        await ch.close();
        await conn.close();
        console.log('Test passed!');
        process.exit(0);
    } catch (err) {
        console.error('Test failed:', err.message);
        if (err.stack) console.error(err.stack);
        process.exit(1);
    }
}

setTimeout(() => {
    console.error('Test timed out after 10s');
    process.exit(1);
}, 10000);

main();
