'use strict';

const { EventEmitter } = require('events');
const { Codec } = require('./types');
const {
    CLASS, CHANNEL, EXCHANGE, QUEUE, BASIC, CONFIRM,
} = require('./methods');
const {
    encodeMethodFrame, encodeHeaderFrame, encodeBodyFrame, decodeHeader,
} = require('./frame');

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

class Channel extends EventEmitter {
    constructor(conn, id) {
        super();
        this.conn = conn;
        this.id = id;
        this.open = false;
        this.consumers = new Map(); // consumerTag -> callback
        this.replyWaiters = new Map(); // "classId:methodId" -> deferred
        this.pendingDelivery = null;   // { kind:'deliver', method:{...}, props, body, accumulated }
    }

    _send(buf) { this.conn._send(buf); }

    _sendMethod(classId, methodId, writeArgs) {
        this._send(encodeMethodFrame(this.id, classId, methodId, writeArgs));
    }

    _waitFor(classId, methodId) {
        const key = `${classId}:${methodId}`;
        const d = deferred();
        this.replyWaiters.set(key, d);
        return d.promise;
    }

    _resolveWait(classId, methodId, value) {
        const key = `${classId}:${methodId}`;
        const d = this.replyWaiters.get(key);
        if (d) {
            this.replyWaiters.delete(key);
            d.resolve(value);
        }
    }

    _rejectAllWaits(err) {
        for (const d of this.replyWaiters.values()) d.reject(err);
        this.replyWaiters.clear();
    }

    async _open() {
        this._sendMethod(CLASS.CHANNEL, CHANNEL.OPEN, (c) => {
            c.writeShortString('');
        });
        await this._waitFor(CLASS.CHANNEL, CHANNEL.OPEN_OK);
        this.open = true;
    }

    _handleMethod(classId, methodId, args) {
        // Common: server-initiated channel close → reply CloseOk, surface error
        if (classId === CLASS.CHANNEL && methodId === CHANNEL.CLOSE) {
            const codec = new Codec(args);
            const code = codec.readUInt16();
            const text = codec.readShortString();
            codec.readUInt16(); codec.readUInt16();
            this._sendMethod(CLASS.CHANNEL, CHANNEL.CLOSE_OK);
            const err = new Error(`Channel closed by server: ${code} ${text}`);
            err.code = code;
            this._rejectAllWaits(err);
            this.open = false;
            this.emit('error', err);
            this.emit('close');
            this.conn._removeChannel(this.id);
            return;
        }
        if (classId === CLASS.CHANNEL && methodId === CHANNEL.CLOSE_OK) {
            this._resolveWait(CLASS.CHANNEL, CHANNEL.CLOSE_OK);
            return;
        }

        // *-Ok responses
        if (classId === CLASS.CHANNEL && methodId === CHANNEL.OPEN_OK)
            return this._resolveWait(CLASS.CHANNEL, CHANNEL.OPEN_OK);
        if (classId === CLASS.EXCHANGE && methodId === EXCHANGE.DECLARE_OK)
            return this._resolveWait(CLASS.EXCHANGE, EXCHANGE.DECLARE_OK);
        if (classId === CLASS.EXCHANGE && methodId === EXCHANGE.DELETE_OK)
            return this._resolveWait(CLASS.EXCHANGE, EXCHANGE.DELETE_OK);
        if (classId === CLASS.QUEUE && methodId === QUEUE.DECLARE_OK) {
            const codec = new Codec(args);
            const name = codec.readShortString();
            const messageCount = codec.readUInt32();
            const consumerCount = codec.readUInt32();
            return this._resolveWait(CLASS.QUEUE, QUEUE.DECLARE_OK,
                { queue: name, messageCount, consumerCount });
        }
        if (classId === CLASS.QUEUE && methodId === QUEUE.BIND_OK)
            return this._resolveWait(CLASS.QUEUE, QUEUE.BIND_OK);
        if (classId === CLASS.QUEUE && methodId === QUEUE.UNBIND_OK)
            return this._resolveWait(CLASS.QUEUE, QUEUE.UNBIND_OK);
        if (classId === CLASS.QUEUE && methodId === QUEUE.DELETE_OK)
            return this._resolveWait(CLASS.QUEUE, QUEUE.DELETE_OK);
        if (classId === CLASS.QUEUE && methodId === QUEUE.PURGE_OK)
            return this._resolveWait(CLASS.QUEUE, QUEUE.PURGE_OK);
        if (classId === CLASS.BASIC && methodId === BASIC.QOS_OK)
            return this._resolveWait(CLASS.BASIC, BASIC.QOS_OK);
        if (classId === CLASS.BASIC && methodId === BASIC.CANCEL_OK) {
            const codec = new Codec(args);
            const tag = codec.readShortString();
            this.consumers.delete(tag);
            return this._resolveWait(CLASS.BASIC, BASIC.CANCEL_OK);
        }
        if (classId === CLASS.BASIC && methodId === BASIC.CONSUME_OK) {
            const codec = new Codec(args);
            const tag = codec.readShortString();
            return this._resolveWait(CLASS.BASIC, BASIC.CONSUME_OK, tag);
        }
        if (classId === CLASS.CONFIRM && methodId === CONFIRM.SELECT_OK)
            return this._resolveWait(CLASS.CONFIRM, CONFIRM.SELECT_OK);

        // Basic.Deliver — prelude to content header + body
        if (classId === CLASS.BASIC && methodId === BASIC.DELIVER) {
            const codec = new Codec(args);
            const consumerTag = codec.readShortString();
            const deliveryTag = codec.readUInt64();
            const redelivered = (codec.readUInt8() & 1) !== 0;
            const exchange    = codec.readShortString();
            const routingKey  = codec.readShortString();
            this.pendingDelivery = {
                kind: 'deliver',
                method: { consumerTag, deliveryTag, redelivered, exchange, routingKey },
                props: null, body: null, accumulated: 0,
            };
            return;
        }

        // Basic.Return — unroutable
        if (classId === CLASS.BASIC && methodId === BASIC.RETURN) {
            const codec = new Codec(args);
            const replyCode = codec.readUInt16();
            const replyText = codec.readShortString();
            const exchange = codec.readShortString();
            const routingKey = codec.readShortString();
            this.pendingDelivery = {
                kind: 'return',
                method: { replyCode, replyText, exchange, routingKey },
                props: null, body: null, accumulated: 0,
            };
            return;
        }
    }

    _handleHeader(payload) {
        if (!this.pendingDelivery) return;
        const { props, bodySize } = decodeHeader(payload);
        this.pendingDelivery.props = props;
        this.pendingDelivery.bodySize = Number(bodySize);
        this.pendingDelivery.body = Buffer.alloc(0);
        if (this.pendingDelivery.bodySize === 0) {
            this._finishDelivery();
        }
    }

    _handleBody(payload) {
        if (!this.pendingDelivery) return;
        this.pendingDelivery.body = this.pendingDelivery.body.length === 0
            ? Buffer.from(payload)
            : Buffer.concat([this.pendingDelivery.body, payload]);
        this.pendingDelivery.accumulated += payload.length;
        if (this.pendingDelivery.accumulated >= this.pendingDelivery.bodySize) {
            this._finishDelivery();
        }
    }

    _finishDelivery() {
        const d = this.pendingDelivery;
        this.pendingDelivery = null;
        if (d.kind === 'deliver') {
            const cb = this.consumers.get(d.method.consumerTag);
            if (cb) {
                const msg = {
                    fields: d.method,
                    properties: d.props,
                    content: d.body,
                };
                try { cb(msg); } catch (err) { this.emit('error', err); }
            }
        } else if (d.kind === 'return') {
            this.emit('return', { fields: d.method, properties: d.props, content: d.body });
        }
    }

    _onConnectionClose() {
        this.open = false;
        const err = new Error('Connection closed');
        this._rejectAllWaits(err);
        this.emit('close');
    }

    // --- Public API ---

    async assertExchange(name, type, options = {}) {
        this._sendMethod(CLASS.EXCHANGE, EXCHANGE.DECLARE, (c) => {
            c.writeUInt16(0);
            c.writeShortString(name);
            c.writeShortString(type);
            const bits = (options.passive ? 1 : 0)
                       | (options.durable ? 2 : 0)
                       | (options.autoDelete ? 4 : 0)
                       | (options.internal ? 8 : 0)
                       | 0; // no-wait=0
            c.writeUInt8(bits);
            c.writeFieldTable(options.arguments || {});
        });
        await this._waitFor(CLASS.EXCHANGE, EXCHANGE.DECLARE_OK);
    }

    async deleteExchange(name, options = {}) {
        this._sendMethod(CLASS.EXCHANGE, EXCHANGE.DELETE, (c) => {
            c.writeUInt16(0);
            c.writeShortString(name);
            const bits = (options.ifUnused ? 1 : 0) | 0;
            c.writeUInt8(bits);
        });
        await this._waitFor(CLASS.EXCHANGE, EXCHANGE.DELETE_OK);
    }

    async assertQueue(name, options = {}) {
        this._sendMethod(CLASS.QUEUE, QUEUE.DECLARE, (c) => {
            c.writeUInt16(0);
            c.writeShortString(name || '');
            const bits = (options.passive ? 1 : 0)
                       | (options.durable ? 2 : 0)
                       | (options.exclusive ? 4 : 0)
                       | (options.autoDelete ? 8 : 0)
                       | 0; // no-wait=0
            c.writeUInt8(bits);
            c.writeFieldTable(options.arguments || {});
        });
        return await this._waitFor(CLASS.QUEUE, QUEUE.DECLARE_OK);
    }

    async deleteQueue(name, options = {}) {
        this._sendMethod(CLASS.QUEUE, QUEUE.DELETE, (c) => {
            c.writeUInt16(0);
            c.writeShortString(name);
            const bits = (options.ifUnused ? 1 : 0)
                       | (options.ifEmpty ? 2 : 0)
                       | 0;
            c.writeUInt8(bits);
        });
        await this._waitFor(CLASS.QUEUE, QUEUE.DELETE_OK);
    }

    async bindQueue(queue, exchange, routingKey, args = {}) {
        this._sendMethod(CLASS.QUEUE, QUEUE.BIND, (c) => {
            c.writeUInt16(0);
            c.writeShortString(queue);
            c.writeShortString(exchange);
            c.writeShortString(routingKey || '');
            c.writeUInt8(0); // no-wait=0
            c.writeFieldTable(args);
        });
        await this._waitFor(CLASS.QUEUE, QUEUE.BIND_OK);
    }

    async unbindQueue(queue, exchange, routingKey, args = {}) {
        this._sendMethod(CLASS.QUEUE, QUEUE.UNBIND, (c) => {
            c.writeUInt16(0);
            c.writeShortString(queue);
            c.writeShortString(exchange);
            c.writeShortString(routingKey || '');
            c.writeFieldTable(args);
        });
        await this._waitFor(CLASS.QUEUE, QUEUE.UNBIND_OK);
    }

    async purgeQueue(queue) {
        this._sendMethod(CLASS.QUEUE, QUEUE.PURGE, (c) => {
            c.writeUInt16(0);
            c.writeShortString(queue);
            c.writeUInt8(0);
        });
        await this._waitFor(CLASS.QUEUE, QUEUE.PURGE_OK);
    }

    async prefetch(count, global = false) {
        this._sendMethod(CLASS.BASIC, BASIC.QOS, (c) => {
            c.writeUInt32(0);                      // prefetch-size
            c.writeUInt16(count & 0xFFFF);        // prefetch-count
            c.writeUInt8(global ? 1 : 0);
        });
        await this._waitFor(CLASS.BASIC, BASIC.QOS_OK);
    }

    publish(exchange, routingKey, content, options = {}) {
        const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

        // Method frame (Basic.Publish)
        this._sendMethod(CLASS.BASIC, BASIC.PUBLISH, (c) => {
            c.writeUInt16(0);
            c.writeShortString(exchange || '');
            c.writeShortString(routingKey || '');
            const bits = (options.mandatory ? 1 : 0) | (options.immediate ? 2 : 0);
            c.writeUInt8(bits);
        });

        // Header frame
        this._send(encodeHeaderFrame(this.id, CLASS.BASIC, body.length, options));

        // Body (split if exceeds frame-max — frame-max includes 8 byte overhead)
        const maxBody = Math.max(1, (this.conn.frameMax || 131072) - 8);
        for (let i = 0; i < body.length; i += maxBody) {
            const chunk = body.subarray(i, Math.min(i + maxBody, body.length));
            this._send(encodeBodyFrame(this.id, chunk));
        }
        return true;
    }

    sendToQueue(queue, content, options = {}) {
        return this.publish('', queue, content, options);
    }

    async consume(queue, callback, options = {}) {
        const consumerTag = options.consumerTag || '';
        this._sendMethod(CLASS.BASIC, BASIC.CONSUME, (c) => {
            c.writeUInt16(0);
            c.writeShortString(queue);
            c.writeShortString(consumerTag);
            const bits = (options.noLocal ? 1 : 0)
                       | (options.noAck ? 2 : 0)
                       | (options.exclusive ? 4 : 0)
                       | 0; // no-wait
            c.writeUInt8(bits);
            c.writeFieldTable(options.arguments || {});
        });
        const tag = await this._waitFor(CLASS.BASIC, BASIC.CONSUME_OK);
        this.consumers.set(tag, callback);
        return { consumerTag: tag };
    }

    async cancel(consumerTag) {
        this._sendMethod(CLASS.BASIC, BASIC.CANCEL, (c) => {
            c.writeShortString(consumerTag);
            c.writeUInt8(0);
        });
        await this._waitFor(CLASS.BASIC, BASIC.CANCEL_OK);
    }

    ack(msg, allUpTo = false) {
        const deliveryTag = msg.fields ? msg.fields.deliveryTag : msg;
        this._sendMethod(CLASS.BASIC, BASIC.ACK, (c) => {
            c.writeUInt64(typeof deliveryTag === 'bigint' ? deliveryTag : BigInt(deliveryTag));
            c.writeUInt8(allUpTo ? 1 : 0);
        });
    }

    nack(msg, allUpTo = false, requeue = true) {
        const deliveryTag = msg.fields ? msg.fields.deliveryTag : msg;
        this._sendMethod(CLASS.BASIC, BASIC.NACK, (c) => {
            c.writeUInt64(typeof deliveryTag === 'bigint' ? deliveryTag : BigInt(deliveryTag));
            const bits = (allUpTo ? 1 : 0) | (requeue ? 2 : 0);
            c.writeUInt8(bits);
        });
    }

    reject(msg, requeue = true) {
        const deliveryTag = msg.fields ? msg.fields.deliveryTag : msg;
        this._sendMethod(CLASS.BASIC, BASIC.REJECT, (c) => {
            c.writeUInt64(typeof deliveryTag === 'bigint' ? deliveryTag : BigInt(deliveryTag));
            c.writeUInt8(requeue ? 1 : 0);
        });
    }

    async confirmSelect() {
        this._sendMethod(CLASS.CONFIRM, CONFIRM.SELECT, (c) => {
            c.writeUInt8(0); // no-wait
        });
        await this._waitFor(CLASS.CONFIRM, CONFIRM.SELECT_OK);
    }

    async close() {
        if (!this.open) return;
        this._sendMethod(CLASS.CHANNEL, CHANNEL.CLOSE, (c) => {
            c.writeUInt16(200);
            c.writeShortString('Normal shutdown');
            c.writeUInt16(0);
            c.writeUInt16(0);
        });
        try {
            await this._waitFor(CLASS.CHANNEL, CHANNEL.CLOSE_OK);
        } catch { /* connection already gone */ }
        this.open = false;
        this.conn._removeChannel(this.id);
    }
}

module.exports = { Channel };
