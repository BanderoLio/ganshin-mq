'use strict';

// AMQP 0-9-1 wire-format codec primitives.
// Big-endian, short-string (uint8 len + bytes), long-string (uint32 len + bytes),
// field table (uint32 size + entries). Mirrors src/amqp/types.h in the broker.

class Codec {
    constructor(buf, offset = 0) {
        this.buf = buf || Buffer.alloc(0);
        this.offset = offset;
        this.chunks = [];
        this.writing = !buf;
    }

    // --- Read ---
    readUInt8()  { const v = this.buf.readUInt8(this.offset); this.offset += 1; return v; }
    readUInt16() { const v = this.buf.readUInt16BE(this.offset); this.offset += 2; return v; }
    readUInt32() { const v = this.buf.readUInt32BE(this.offset); this.offset += 4; return v; }
    readInt8()   { const v = this.buf.readInt8(this.offset); this.offset += 1; return v; }
    readInt16()  { const v = this.buf.readInt16BE(this.offset); this.offset += 2; return v; }
    readInt32()  { const v = this.buf.readInt32BE(this.offset); this.offset += 4; return v; }
    readUInt64() {
        const v = this.buf.readBigUInt64BE(this.offset);
        this.offset += 8;
        return v;
    }
    readInt64() {
        const v = this.buf.readBigInt64BE(this.offset);
        this.offset += 8;
        return v;
    }
    readFloat()  { const v = this.buf.readFloatBE(this.offset); this.offset += 4; return v; }
    readDouble() { const v = this.buf.readDoubleBE(this.offset); this.offset += 8; return v; }

    readShortString() {
        const len = this.readUInt8();
        const s = this.buf.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return s;
    }

    readLongString() {
        const len = this.readUInt32();
        const s = this.buf.toString('utf8', this.offset, this.offset + len);
        this.offset += len;
        return s;
    }

    readBytes(n) {
        const slice = this.buf.subarray(this.offset, this.offset + n);
        this.offset += n;
        return slice;
    }

    readFieldTable() {
        const len = this.readUInt32();
        const end = this.offset + len;
        const table = {};
        while (this.offset < end) {
            const name = this.readShortString();
            table[name] = this.readFieldValue();
        }
        return table;
    }

    readFieldValue() {
        const tag = String.fromCharCode(this.readUInt8());
        switch (tag) {
            case 't': return this.readUInt8() !== 0;
            case 'b': return this.readInt8();
            case 'B': return this.readUInt8();
            case 'U': return this.readInt16();
            case 'u': return this.readUInt16();
            case 'I': return this.readInt32();
            case 'i': return this.readUInt32();
            case 'L': return this.readInt64();
            case 'l': return this.readUInt64();
            case 'f': return this.readFloat();
            case 'd': return this.readDouble();
            case 's': return this.readShortString();
            case 'S': return this.readLongString();
            case 'T': return this.readUInt64();
            case 'F': return this.readFieldTable();
            case 'A': {
                const len = this.readUInt32();
                const end = this.offset + len;
                const arr = [];
                while (this.offset < end) arr.push(this.readFieldValue());
                return arr;
            }
            case 'V': return null;
            case 'x': {
                const len = this.readUInt32();
                return this.readBytes(len);
            }
            default:
                throw new Error('Unknown AMQP field type: ' + tag);
        }
    }

    // --- Write (accumulate chunks, finalize via .toBuffer()) ---
    _push(buf) { this.chunks.push(buf); }

    writeUInt8(v)  { const b = Buffer.alloc(1); b.writeUInt8(v, 0); this._push(b); }
    writeUInt16(v) { const b = Buffer.alloc(2); b.writeUInt16BE(v, 0); this._push(b); }
    writeUInt32(v) { const b = Buffer.alloc(4); b.writeUInt32BE(v, 0); this._push(b); }
    writeInt8(v)   { const b = Buffer.alloc(1); b.writeInt8(v, 0); this._push(b); }
    writeInt16(v)  { const b = Buffer.alloc(2); b.writeInt16BE(v, 0); this._push(b); }
    writeInt32(v)  { const b = Buffer.alloc(4); b.writeInt32BE(v, 0); this._push(b); }
    writeUInt64(v) {
        const b = Buffer.alloc(8);
        b.writeBigUInt64BE(BigInt(v), 0);
        this._push(b);
    }
    writeInt64(v) {
        const b = Buffer.alloc(8);
        b.writeBigInt64BE(BigInt(v), 0);
        this._push(b);
    }
    writeFloat(v)  { const b = Buffer.alloc(4); b.writeFloatBE(v, 0); this._push(b); }
    writeDouble(v) { const b = Buffer.alloc(8); b.writeDoubleBE(v, 0); this._push(b); }

    writeShortString(s) {
        const str = String(s || '');
        const buf = Buffer.from(str, 'utf8');
        const len = Math.min(buf.length, 255);
        this.writeUInt8(len);
        this._push(buf.subarray(0, len));
    }

    writeLongString(s) {
        const str = s == null ? '' : (Buffer.isBuffer(s) ? s : String(s));
        const buf = Buffer.isBuffer(str) ? str : Buffer.from(str, 'utf8');
        this.writeUInt32(buf.length);
        this._push(buf);
    }

    writeBytes(buf) {
        const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
        this._push(b);
    }

    writeFieldTable(table) {
        const inner = new Codec();
        for (const [name, value] of Object.entries(table || {})) {
            inner.writeShortString(name);
            inner.writeFieldValue(value);
        }
        const innerBuf = inner.toBuffer();
        this.writeUInt32(innerBuf.length);
        this._push(innerBuf);
    }

    writeFieldValue(v) {
        if (v === null || v === undefined) {
            this.writeUInt8('V'.charCodeAt(0));
            return;
        }
        if (typeof v === 'boolean') {
            this.writeUInt8('t'.charCodeAt(0));
            this.writeUInt8(v ? 1 : 0);
            return;
        }
        if (typeof v === 'bigint') {
            this.writeUInt8('l'.charCodeAt(0));
            this.writeUInt64(v);
            return;
        }
        if (typeof v === 'number') {
            if (Number.isInteger(v)) {
                this.writeUInt8('I'.charCodeAt(0));
                this.writeInt32(v | 0);
            } else {
                this.writeUInt8('d'.charCodeAt(0));
                this.writeDouble(v);
            }
            return;
        }
        if (typeof v === 'string') {
            this.writeUInt8('S'.charCodeAt(0));
            this.writeLongString(v);
            return;
        }
        if (Buffer.isBuffer(v)) {
            this.writeUInt8('x'.charCodeAt(0));
            this.writeUInt32(v.length);
            this._push(v);
            return;
        }
        if (Array.isArray(v)) {
            const inner = new Codec();
            for (const e of v) inner.writeFieldValue(e);
            const buf = inner.toBuffer();
            this.writeUInt8('A'.charCodeAt(0));
            this.writeUInt32(buf.length);
            this._push(buf);
            return;
        }
        if (typeof v === 'object') {
            this.writeUInt8('F'.charCodeAt(0));
            this.writeFieldTable(v);
            return;
        }
        throw new Error('Cannot encode field value: ' + typeof v);
    }

    toBuffer() {
        return Buffer.concat(this.chunks);
    }
}

module.exports = { Codec };
