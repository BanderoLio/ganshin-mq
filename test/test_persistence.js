const amqp = require('amqplib');
const { execSync } = require('child_process');
const path = require('path');

const PROJECT_DIR = path.resolve(__dirname, '..');
const BROKER_BIN = path.join(PROJECT_DIR, 'build', 'Broko');
const DATA_DIR = path.join(PROJECT_DIR, 'data');

function startBroker() {
    execSync(`${BROKER_BIN} 5672 ${DATA_DIR} &`, {
        stdio: 'ignore', shell: '/bin/bash', cwd: PROJECT_DIR
    });
}

function stopBroker() {
    try { execSync('pkill -TERM -f "build/Broko"', { stdio: 'ignore' }); }
    catch {}
}

async function main() {
    console.log('Persistence Test\n');

    // --- Part A: Unacked persistent message survives restart ---

    console.log('Part A: Unacked persistent message survives restart');
    console.log('  Step 1: Publishing persistent message...');
    let conn = await amqp.connect('amqp://guest:guest@localhost:5672/');
    let ch = await conn.createChannel();
    await ch.assertQueue('durable-test', { durable: true });
    ch.sendToQueue('durable-test', Buffer.from('survive-restart'), {
        persistent: true
    });
    await new Promise(r => setTimeout(r, 200));
    await ch.close();
    await conn.close();
    console.log('  Published. Closing connection.\n');

    console.log('  Step 2: Restarting broker...');
    stopBroker();
    await new Promise(r => setTimeout(r, 1000));
    startBroker();
    await new Promise(r => setTimeout(r, 2000));
    console.log('  Broker restarted.\n');

    console.log('  Step 3: Consuming message after restart...');
    conn = await amqp.connect('amqp://guest:guest@localhost:5672/');
    ch = await conn.createChannel();
    await ch.checkQueue('durable-test');

    const msg = await ch.get('durable-test');
    if (!msg) {
        console.error('  FAIL: No message found after restart');
        await conn.close();
        process.exit(1);
    }
    console.log(`  Got: "${msg.content.toString()}"`);
    if (msg.content.toString() !== 'survive-restart') {
        console.error('  FAIL: Content mismatch');
        await conn.close();
        process.exit(1);
    }
    ch.ack(msg);
    console.log('  Part A PASSED: unacked message survived restart\n');

    // --- Part B: ACKed persistent message must NOT be redelivered ---

    console.log('Part B: ACKed message must NOT reappear after restart');
    console.log('  Step 1: Publishing and ACKing a persistent message...');
    ch.sendToQueue('durable-test', Buffer.from('acked-before-restart'), {
        persistent: true
    });
    await new Promise(r => setTimeout(r, 200));

    const msg2 = await ch.get('durable-test');
    if (!msg2) {
        console.error('  FAIL: No message to ack');
        await conn.close();
        process.exit(1);
    }
    ch.ack(msg2);
    await new Promise(r => setTimeout(r, 200));
    await ch.close();
    await conn.close();
    console.log('  Message ACKed. Closing connection.\n');

    console.log('  Step 2: Restarting broker...');
    stopBroker();
    await new Promise(r => setTimeout(r, 1000));
    startBroker();
    await new Promise(r => setTimeout(r, 2000));
    console.log('  Broker restarted.\n');

    console.log('  Step 3: Verifying queue is empty...');
    conn = await amqp.connect('amqp://guest:guest@localhost:5672/');
    ch = await conn.createChannel();
    await ch.checkQueue('durable-test');

    const msg3 = await ch.get('durable-test');
    if (msg3 !== false) {
        console.error('  FAIL: ACKed message was redelivered after restart!');
        await conn.close();
        process.exit(1);
    }
    console.log('  Part B PASSED: ACKed message was not redelivered\n');

    await ch.deleteQueue('durable-test');
    await ch.close();
    await conn.close();

    console.log('Persistence test PASSED!');
    process.exit(0);
}

setTimeout(() => { console.error('Timed out'); process.exit(1); }, 30000);
main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
