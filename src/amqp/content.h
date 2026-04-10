#pragma once

#include "types.h"
#include <cstdint>
#include <optional>
#include <string>

namespace broko::amqp {

// Basic content header property flags (bit 15 = first property, bit 0 = continuation)
constexpr uint16_t PROP_CONTENT_TYPE     = 1 << 15;
constexpr uint16_t PROP_CONTENT_ENCODING = 1 << 14;
constexpr uint16_t PROP_HEADERS          = 1 << 13;
constexpr uint16_t PROP_DELIVERY_MODE    = 1 << 12;
constexpr uint16_t PROP_PRIORITY         = 1 << 11;
constexpr uint16_t PROP_CORRELATION_ID   = 1 << 10;
constexpr uint16_t PROP_REPLY_TO         = 1 << 9;
constexpr uint16_t PROP_EXPIRATION       = 1 << 8;
constexpr uint16_t PROP_MESSAGE_ID       = 1 << 7;
constexpr uint16_t PROP_TIMESTAMP        = 1 << 6;
constexpr uint16_t PROP_TYPE             = 1 << 5;
constexpr uint16_t PROP_USER_ID          = 1 << 4;
constexpr uint16_t PROP_APP_ID           = 1 << 3;
constexpr uint16_t PROP_CLUSTER_ID       = 1 << 2;

struct BasicProperties {
    std::optional<std::string> content_type;
    std::optional<std::string> content_encoding;
    std::optional<FieldTable>  headers;
    std::optional<uint8_t>     delivery_mode;
    std::optional<uint8_t>     priority;
    std::optional<std::string> correlation_id;
    std::optional<std::string> reply_to;
    std::optional<std::string> expiration;
    std::optional<std::string> message_id;
    std::optional<uint64_t>    timestamp;
    std::optional<std::string> type;
    std::optional<std::string> user_id;
    std::optional<std::string> app_id;
    std::optional<std::string> cluster_id;

    static BasicProperties decode(Buffer& buf) {
        BasicProperties props;
        uint16_t flags = buf.readUint16();

        if (flags & PROP_CONTENT_TYPE)     props.content_type     = buf.readShortString();
        if (flags & PROP_CONTENT_ENCODING) props.content_encoding = buf.readShortString();
        if (flags & PROP_HEADERS)          props.headers          = buf.readFieldTable();
        if (flags & PROP_DELIVERY_MODE)    props.delivery_mode    = buf.readUint8();
        if (flags & PROP_PRIORITY)         props.priority         = buf.readUint8();
        if (flags & PROP_CORRELATION_ID)   props.correlation_id   = buf.readShortString();
        if (flags & PROP_REPLY_TO)         props.reply_to         = buf.readShortString();
        if (flags & PROP_EXPIRATION)       props.expiration       = buf.readShortString();
        if (flags & PROP_MESSAGE_ID)       props.message_id       = buf.readShortString();
        if (flags & PROP_TIMESTAMP)        props.timestamp        = buf.readUint64();
        if (flags & PROP_TYPE)             props.type             = buf.readShortString();
        if (flags & PROP_USER_ID)          props.user_id          = buf.readShortString();
        if (flags & PROP_APP_ID)           props.app_id           = buf.readShortString();
        if (flags & PROP_CLUSTER_ID)       props.cluster_id       = buf.readShortString();

        return props;
    }

    void encode(Buffer& buf) const {
        uint16_t flags = 0;
        if (content_type)     flags |= PROP_CONTENT_TYPE;
        if (content_encoding) flags |= PROP_CONTENT_ENCODING;
        if (headers)          flags |= PROP_HEADERS;
        if (delivery_mode)    flags |= PROP_DELIVERY_MODE;
        if (priority)         flags |= PROP_PRIORITY;
        if (correlation_id)   flags |= PROP_CORRELATION_ID;
        if (reply_to)         flags |= PROP_REPLY_TO;
        if (expiration)       flags |= PROP_EXPIRATION;
        if (message_id)       flags |= PROP_MESSAGE_ID;
        if (timestamp)        flags |= PROP_TIMESTAMP;
        if (type)             flags |= PROP_TYPE;
        if (user_id)          flags |= PROP_USER_ID;
        if (app_id)           flags |= PROP_APP_ID;
        if (cluster_id)       flags |= PROP_CLUSTER_ID;

        buf.writeUint16(flags);

        if (content_type)     buf.writeShortString(*content_type);
        if (content_encoding) buf.writeShortString(*content_encoding);
        if (headers)          buf.writeFieldTable(*headers);
        if (delivery_mode)    buf.writeUint8(*delivery_mode);
        if (priority)         buf.writeUint8(*priority);
        if (correlation_id)   buf.writeShortString(*correlation_id);
        if (reply_to)         buf.writeShortString(*reply_to);
        if (expiration)       buf.writeShortString(*expiration);
        if (message_id)       buf.writeShortString(*message_id);
        if (timestamp)        buf.writeUint64(*timestamp);
        if (type)             buf.writeShortString(*type);
        if (user_id)          buf.writeShortString(*user_id);
        if (app_id)           buf.writeShortString(*app_id);
        if (cluster_id)       buf.writeShortString(*cluster_id);
    }
};

} // namespace broko::amqp
