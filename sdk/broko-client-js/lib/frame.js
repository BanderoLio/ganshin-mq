'use strict';

const { Codec } = require('./types');
const { FRAME, PROP_FLAGS } = require('./methods');

// Frame: [type:1][channel:2][size:4][payload:size][end:1=0xCE].

function encodeMethodFrame(channel, classId, methodId, writeArgs) {
    const payload = new Codec();
    payload.writeUInt16(classId);
    payload.writeUInt16(methodId);
    if (writeArgs) writeArgs(payload);
    return _frame(FRAME.METHOD, channel, payload.toBuffer());
}

function encodeHeaderFrame(channel, classId, bodySize, props) {
    const payload = new Codec();
    payload.writeUInt16(classId);
    payload.writeUInt16(0);            // weight (always 0)
    payload.writeUInt64(BigInt(bodySize));
    _encodeBasicProperties(payload, props || {});
    return _frame(FRAME.HEADER, channel, payload.toBuffer());
}

function encodeBodyFrame(channel, body) {
    return _frame(FRAME.BODY, channel, body);
}

function encodeHeartbeat() {
    return _frame(FRAME.HEARTBEAT, 0, Buffer.alloc(0));
}

function _frame(type, channel, payload) {
    const out = Buffer.alloc(7 + payload.length + 1);
    out.writeUInt8(type, 0);
    out.writeUInt16BE(channel, 1);
    out.writeUInt32BE(payload.length, 3);
    payload.copy(out, 7);
    out.writeUInt8(FRAME.END, 7 + payload.length);
    return out;
}

// Streaming decoder. Feed it bytes via .feed(buf); call .next() to pull a complete frame
// (or null if not enough data yet). Throws on protocol errors.
class FrameParser {
    constructor() {
        this.buf = Buffer.alloc(0);
    }

    feed(chunk) {
        this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    }

    next() {
        if (this.buf.length < 7) return null;
        const size = this.buf.readUInt32BE(3);
        if (this.buf.length < 7 + size + 1) return null;
        const type = this.buf.readUInt8(0);
        const channel = this.buf.readUInt16BE(1);
        const end = this.buf.readUInt8(7 + size);
        if (end !== FRAME.END) {
            throw new Error('AMQP framing error: invalid frame-end byte 0x' + end.toString(16));
        }
        const payload = this.buf.subarray(7, 7 + size);
        this.buf = this.buf.subarray(7 + size + 1);
        return { type, channel, payload };
    }
}

// Decode a method frame payload into { classId, methodId, args:Buffer-slice }.
function decodeMethod(payload) {
    return {
        classId:  payload.readUInt16BE(0),
        methodId: payload.readUInt16BE(2),
        args:     payload.subarray(4),
    };
}

// Decode a content header frame: { classId, bodySize:BigInt, props:{...} }.
function decodeHeader(payload) {
    const codec = new Codec(payload);
    const classId = codec.readUInt16();
    codec.readUInt16(); // weight
    const bodySize = codec.readUInt64();
    const props = _decodeBasicProperties(codec);
    return { classId, bodySize, props };
}

function _decodeBasicProperties(codec) {
    const flags = codec.readUInt16();
    const props = {};
    if (flags & PROP_FLAGS.CONTENT_TYPE)     props.contentType     = codec.readShortString();
    if (flags & PROP_FLAGS.CONTENT_ENCODING) props.contentEncoding = codec.readShortString();
    if (flags & PROP_FLAGS.HEADERS)          props.headers         = codec.readFieldTable();
    if (flags & PROP_FLAGS.DELIVERY_MODE)    props.deliveryMode    = codec.readUInt8();
    if (flags & PROP_FLAGS.PRIORITY)         props.priority        = codec.readUInt8();
    if (flags & PROP_FLAGS.CORRELATION_ID)   props.correlationId   = codec.readShortString();
    if (flags & PROP_FLAGS.REPLY_TO)         props.replyTo         = codec.readShortString();
    if (flags & PROP_FLAGS.EXPIRATION)       props.expiration      = codec.readShortString();
    if (flags & PROP_FLAGS.MESSAGE_ID)       props.messageId       = codec.readShortString();
    if (flags & PROP_FLAGS.TIMESTAMP)        props.timestamp       = codec.readUInt64();
    if (flags & PROP_FLAGS.TYPE)             props.type            = codec.readShortString();
    if (flags & PROP_FLAGS.USER_ID)          props.userId          = codec.readShortString();
    if (flags & PROP_FLAGS.APP_ID)           props.appId           = codec.readShortString();
    if (flags & PROP_FLAGS.CLUSTER_ID)       props.clusterId       = codec.readShortString();
    return props;
}

function _encodeBasicProperties(codec, p) {
    let flags = 0;
    if (p.contentType     != null) flags |= PROP_FLAGS.CONTENT_TYPE;
    if (p.contentEncoding != null) flags |= PROP_FLAGS.CONTENT_ENCODING;
    if (p.headers         != null) flags |= PROP_FLAGS.HEADERS;
    if (p.deliveryMode    != null || p.persistent != null) flags |= PROP_FLAGS.DELIVERY_MODE;
    if (p.priority        != null) flags |= PROP_FLAGS.PRIORITY;
    if (p.correlationId   != null) flags |= PROP_FLAGS.CORRELATION_ID;
    if (p.replyTo         != null) flags |= PROP_FLAGS.REPLY_TO;
    if (p.expiration      != null) flags |= PROP_FLAGS.EXPIRATION;
    if (p.messageId       != null) flags |= PROP_FLAGS.MESSAGE_ID;
    if (p.timestamp       != null) flags |= PROP_FLAGS.TIMESTAMP;
    if (p.type            != null) flags |= PROP_FLAGS.TYPE;
    if (p.userId          != null) flags |= PROP_FLAGS.USER_ID;
    if (p.appId           != null) flags |= PROP_FLAGS.APP_ID;
    if (p.clusterId       != null) flags |= PROP_FLAGS.CLUSTER_ID;

    codec.writeUInt16(flags);

    if (p.contentType     != null) codec.writeShortString(p.contentType);
    if (p.contentEncoding != null) codec.writeShortString(p.contentEncoding);
    if (p.headers         != null) codec.writeFieldTable(p.headers);
    if (p.deliveryMode    != null || p.persistent != null)
        codec.writeUInt8(p.deliveryMode != null ? p.deliveryMode : (p.persistent ? 2 : 1));
    if (p.priority        != null) codec.writeUInt8(p.priority);
    if (p.correlationId   != null) codec.writeShortString(p.correlationId);
    if (p.replyTo         != null) codec.writeShortString(p.replyTo);
    if (p.expiration      != null) codec.writeShortString(String(p.expiration));
    if (p.messageId       != null) codec.writeShortString(p.messageId);
    if (p.timestamp       != null) codec.writeUInt64(p.timestamp);
    if (p.type            != null) codec.writeShortString(p.type);
    if (p.userId          != null) codec.writeShortString(p.userId);
    if (p.appId           != null) codec.writeShortString(p.appId);
    if (p.clusterId       != null) codec.writeShortString(p.clusterId);
}

module.exports = {
    encodeMethodFrame,
    encodeHeaderFrame,
    encodeBodyFrame,
    encodeHeartbeat,
    FrameParser,
    decodeMethod,
    decodeHeader,
};
