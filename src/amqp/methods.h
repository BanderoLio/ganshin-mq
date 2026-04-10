#pragma once

#include <cstdint>

namespace broko::amqp {

namespace class_id {
    constexpr uint16_t CONNECTION = 10;
    constexpr uint16_t CHANNEL    = 20;
    constexpr uint16_t EXCHANGE   = 40;
    constexpr uint16_t QUEUE      = 50;
    constexpr uint16_t BASIC      = 60;
    constexpr uint16_t CONFIRM    = 85;
    constexpr uint16_t TX         = 90;
}

namespace connection_method {
    constexpr uint16_t START     = 10;
    constexpr uint16_t START_OK  = 11;
    constexpr uint16_t SECURE    = 20;
    constexpr uint16_t SECURE_OK = 21;
    constexpr uint16_t TUNE      = 30;
    constexpr uint16_t TUNE_OK   = 31;
    constexpr uint16_t OPEN      = 40;
    constexpr uint16_t OPEN_OK   = 41;
    constexpr uint16_t CLOSE     = 50;
    constexpr uint16_t CLOSE_OK  = 51;
}

namespace channel_method {
    constexpr uint16_t OPEN      = 10;
    constexpr uint16_t OPEN_OK   = 11;
    constexpr uint16_t FLOW      = 20;
    constexpr uint16_t FLOW_OK   = 21;
    constexpr uint16_t CLOSE     = 40;
    constexpr uint16_t CLOSE_OK  = 41;
}

namespace exchange_method {
    constexpr uint16_t DECLARE    = 10;
    constexpr uint16_t DECLARE_OK = 11;
    constexpr uint16_t DELETE     = 20;
    constexpr uint16_t DELETE_OK  = 21;
}

namespace queue_method {
    constexpr uint16_t DECLARE    = 10;
    constexpr uint16_t DECLARE_OK = 11;
    constexpr uint16_t BIND       = 20;
    constexpr uint16_t BIND_OK    = 21;
    constexpr uint16_t PURGE      = 30;
    constexpr uint16_t PURGE_OK   = 31;
    constexpr uint16_t DELETE     = 40;
    constexpr uint16_t DELETE_OK  = 41;
    constexpr uint16_t UNBIND     = 50;
    constexpr uint16_t UNBIND_OK  = 51;
}

namespace basic_method {
    constexpr uint16_t QOS           = 10;
    constexpr uint16_t QOS_OK        = 11;
    constexpr uint16_t CONSUME       = 20;
    constexpr uint16_t CONSUME_OK    = 21;
    constexpr uint16_t CANCEL        = 30;
    constexpr uint16_t CANCEL_OK     = 31;
    constexpr uint16_t PUBLISH       = 40;
    constexpr uint16_t RETURN        = 50;
    constexpr uint16_t DELIVER       = 60;
    constexpr uint16_t GET           = 70;
    constexpr uint16_t GET_OK        = 71;
    constexpr uint16_t GET_EMPTY     = 72;
    constexpr uint16_t ACK           = 80;
    constexpr uint16_t REJECT        = 90;
    constexpr uint16_t RECOVER_ASYNC = 100;
    constexpr uint16_t RECOVER       = 110;
    constexpr uint16_t RECOVER_OK    = 111;
    constexpr uint16_t NACK          = 120;
}

namespace confirm_method {
    constexpr uint16_t SELECT    = 10;
    constexpr uint16_t SELECT_OK = 11;
}

namespace tx_method {
    constexpr uint16_t SELECT      = 10;
    constexpr uint16_t SELECT_OK   = 11;
    constexpr uint16_t COMMIT      = 20;
    constexpr uint16_t COMMIT_OK   = 21;
    constexpr uint16_t ROLLBACK    = 30;
    constexpr uint16_t ROLLBACK_OK = 31;
}

// AMQP reply codes
namespace reply_code {
    constexpr uint16_t SUCCESS            = 200;
    constexpr uint16_t CONTENT_TOO_LARGE  = 311;
    constexpr uint16_t NO_ROUTE           = 312;
    constexpr uint16_t NO_CONSUMERS       = 313;
    constexpr uint16_t CONNECTION_FORCED  = 320;
    constexpr uint16_t INVALID_PATH       = 402;
    constexpr uint16_t ACCESS_REFUSED     = 403;
    constexpr uint16_t NOT_FOUND          = 404;
    constexpr uint16_t RESOURCE_LOCKED    = 405;
    constexpr uint16_t PRECONDITION_FAILED = 406;
    constexpr uint16_t FRAME_ERROR        = 501;
    constexpr uint16_t SYNTAX_ERROR       = 502;
    constexpr uint16_t COMMAND_INVALID    = 503;
    constexpr uint16_t CHANNEL_ERROR      = 504;
    constexpr uint16_t UNEXPECTED_FRAME   = 505;
    constexpr uint16_t RESOURCE_ERROR     = 506;
    constexpr uint16_t NOT_ALLOWED        = 530;
    constexpr uint16_t NOT_IMPLEMENTED    = 540;
    constexpr uint16_t INTERNAL_ERROR     = 541;
}

} // namespace broko::amqp
