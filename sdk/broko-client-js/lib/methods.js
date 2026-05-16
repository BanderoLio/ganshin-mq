'use strict';

// AMQP 0-9-1 class / method IDs. Mirrors src/amqp/methods.h.

const CLASS = {
    CONNECTION: 10,
    CHANNEL:    20,
    EXCHANGE:   40,
    QUEUE:      50,
    BASIC:      60,
    CONFIRM:    85,
    TX:         90,
};

const CONNECTION = {
    START:    10, START_OK:  11,
    SECURE:   20, SECURE_OK: 21,
    TUNE:     30, TUNE_OK:   31,
    OPEN:     40, OPEN_OK:   41,
    CLOSE:    50, CLOSE_OK:  51,
};

const CHANNEL = {
    OPEN:  10, OPEN_OK:  11,
    FLOW:  20, FLOW_OK:  21,
    CLOSE: 40, CLOSE_OK: 41,
};

const EXCHANGE = {
    DECLARE: 10, DECLARE_OK: 11,
    DELETE:  20, DELETE_OK:  21,
};

const QUEUE = {
    DECLARE: 10, DECLARE_OK: 11,
    BIND:    20, BIND_OK:    21,
    PURGE:   30, PURGE_OK:   31,
    DELETE:  40, DELETE_OK:  41,
    UNBIND:  50, UNBIND_OK:  51,
};

const BASIC = {
    QOS:        10, QOS_OK:     11,
    CONSUME:    20, CONSUME_OK: 21,
    CANCEL:     30, CANCEL_OK:  31,
    PUBLISH:    40,
    RETURN:     50,
    DELIVER:    60,
    GET:        70, GET_OK:     71, GET_EMPTY: 72,
    ACK:        80,
    REJECT:     90,
    RECOVER:    110, RECOVER_OK: 111,
    NACK:       120,
};

const CONFIRM = {
    SELECT: 10, SELECT_OK: 11,
};

const FRAME = {
    METHOD:    1,
    HEADER:    2,
    BODY:      3,
    HEARTBEAT: 8,
    END:    0xCE,
};

const PROTOCOL_HEADER = Buffer.from([0x41, 0x4D, 0x51, 0x50, 0x00, 0x00, 0x09, 0x01]);

const PROP_FLAGS = {
    CONTENT_TYPE:     1 << 15,
    CONTENT_ENCODING: 1 << 14,
    HEADERS:          1 << 13,
    DELIVERY_MODE:    1 << 12,
    PRIORITY:         1 << 11,
    CORRELATION_ID:   1 << 10,
    REPLY_TO:         1 << 9,
    EXPIRATION:       1 << 8,
    MESSAGE_ID:       1 << 7,
    TIMESTAMP:        1 << 6,
    TYPE:             1 << 5,
    USER_ID:          1 << 4,
    APP_ID:           1 << 3,
    CLUSTER_ID:       1 << 2,
};

module.exports = {
    CLASS, CONNECTION, CHANNEL, EXCHANGE, QUEUE, BASIC, CONFIRM,
    FRAME, PROTOCOL_HEADER, PROP_FLAGS,
};
