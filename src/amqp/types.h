#pragma once

#include <algorithm>
#include <cstdint>
#include <cstring>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace broko::amqp {

struct FieldValue;
using FieldTable = std::map<std::string, FieldValue>;
using FieldArray = std::vector<FieldValue>;

struct FieldValue {
    char type_tag = 'V';
    bool bool_val = false;
    int64_t int_val = 0;
    double double_val = 0.0;
    std::string string_val;
    std::shared_ptr<FieldTable> table_val;
    std::shared_ptr<FieldArray> array_val;

    static FieldValue boolean(bool v) {
        FieldValue f;
        f.type_tag = 't';
        f.bool_val = v;
        return f;
    }
    static FieldValue shortShortInt(int8_t v) {
        FieldValue f;
        f.type_tag = 'b';
        f.int_val = v;
        return f;
    }
    static FieldValue shortShortUint(uint8_t v) {
        FieldValue f;
        f.type_tag = 'B';
        f.int_val = v;
        return f;
    }
    static FieldValue shortInt(int16_t v) {
        FieldValue f;
        f.type_tag = 'U';
        f.int_val = v;
        return f;
    }
    static FieldValue shortUint(uint16_t v) {
        FieldValue f;
        f.type_tag = 'u';
        f.int_val = v;
        return f;
    }
    static FieldValue longInt(int32_t v) {
        FieldValue f;
        f.type_tag = 'I';
        f.int_val = v;
        return f;
    }
    static FieldValue longUint(uint32_t v) {
        FieldValue f;
        f.type_tag = 'i';
        f.int_val = v;
        return f;
    }
    static FieldValue longLongInt(int64_t v) {
        FieldValue f;
        f.type_tag = 'L';
        f.int_val = v;
        return f;
    }
    static FieldValue longLongUint(uint64_t v) {
        FieldValue f;
        f.type_tag = 'l';
        f.int_val = static_cast<int64_t>(v);
        return f;
    }
    static FieldValue floatVal(float v) {
        FieldValue f;
        f.type_tag = 'f';
        f.double_val = v;
        return f;
    }
    static FieldValue doubleVal(double v) {
        FieldValue f;
        f.type_tag = 'd';
        f.double_val = v;
        return f;
    }
    static FieldValue shortString(std::string v) {
        FieldValue f;
        f.type_tag = 's';
        f.string_val = std::move(v);
        return f;
    }
    static FieldValue longString(std::string v) {
        FieldValue f;
        f.type_tag = 'S';
        f.string_val = std::move(v);
        return f;
    }
    static FieldValue timestamp(uint64_t v) {
        FieldValue f;
        f.type_tag = 'T';
        f.int_val = static_cast<int64_t>(v);
        return f;
    }
    static FieldValue table(FieldTable t) {
        FieldValue f;
        f.type_tag = 'F';
        f.table_val = std::make_shared<FieldTable>(std::move(t));
        return f;
    }
    static FieldValue array(FieldArray a) {
        FieldValue f;
        f.type_tag = 'A';
        f.array_val = std::make_shared<FieldArray>(std::move(a));
        return f;
    }
    static FieldValue voidVal() {
        FieldValue f;
        f.type_tag = 'V';
        return f;
    }
};

class Buffer {
    std::vector<uint8_t> data_;
    size_t pos_ = 0;

public:
    Buffer() = default;
    explicit Buffer(std::vector<uint8_t> data) : data_(std::move(data)) {}
    Buffer(const uint8_t* data, size_t len) : data_(data, data + len) {}

    size_t position() const { return pos_; }
    size_t remaining() const { return data_.size() - pos_; }
    size_t size() const { return data_.size(); }
    const uint8_t* data() const { return data_.data(); }
    std::vector<uint8_t>& raw() { return data_; }
    const std::vector<uint8_t>& raw() const { return data_; }
    void reset() { pos_ = 0; }
    void clear() { data_.clear(); pos_ = 0; }

    void ensure(size_t n) const {
        if (n > data_.size() || pos_ > data_.size() - n)
            throw std::runtime_error("Buffer underflow");
    }

    // --- Read (big-endian / network byte order) ---

    uint8_t readUint8() {
        ensure(1);
        return data_[pos_++];
    }

    uint16_t readUint16() {
        ensure(2);
        uint16_t v = (static_cast<uint16_t>(data_[pos_]) << 8)
                   | static_cast<uint16_t>(data_[pos_ + 1]);
        pos_ += 2;
        return v;
    }

    uint32_t readUint32() {
        ensure(4);
        uint32_t v = (static_cast<uint32_t>(data_[pos_])     << 24)
                   | (static_cast<uint32_t>(data_[pos_ + 1]) << 16)
                   | (static_cast<uint32_t>(data_[pos_ + 2]) << 8)
                   | static_cast<uint32_t>(data_[pos_ + 3]);
        pos_ += 4;
        return v;
    }

    uint64_t readUint64() {
        ensure(8);
        uint64_t v = 0;
        for (int i = 0; i < 8; ++i)
            v = (v << 8) | data_[pos_ + i];
        pos_ += 8;
        return v;
    }

    int8_t readInt8() { return static_cast<int8_t>(readUint8()); }
    int16_t readInt16() { return static_cast<int16_t>(readUint16()); }
    int32_t readInt32() { return static_cast<int32_t>(readUint32()); }
    int64_t readInt64() { return static_cast<int64_t>(readUint64()); }

    std::string readShortString() {
        uint8_t len = readUint8();
        ensure(len);
        std::string s(data_.begin() + pos_, data_.begin() + pos_ + len);
        pos_ += len;
        return s;
    }

    std::string readLongString() {
        uint32_t len = readUint32();
        ensure(len);
        std::string s(data_.begin() + pos_, data_.begin() + pos_ + len);
        pos_ += len;
        return s;
    }

    std::vector<uint8_t> readBytes(size_t n) {
        ensure(n);
        std::vector<uint8_t> v(data_.begin() + pos_, data_.begin() + pos_ + n);
        pos_ += n;
        return v;
    }

    static constexpr size_t MAX_FIELD_TABLE_DEPTH = 32;

    FieldTable readFieldTable(size_t depth = 0) {
        if (depth > MAX_FIELD_TABLE_DEPTH)
            throw std::runtime_error("Field table recursion depth exceeded");
        uint32_t tableLen = readUint32();
        size_t end = pos_ + tableLen;
        FieldTable table;
        while (pos_ < end) {
            std::string name = readShortString();
            FieldValue val = readFieldValue(depth);
            table.emplace(std::move(name), std::move(val));
        }
        return table;
    }

    FieldValue readFieldValue(size_t depth = 0) {
        char tag = static_cast<char>(readUint8());
        switch (tag) {
            case 't': return FieldValue::boolean(readUint8() != 0);
            case 'b': return FieldValue::shortShortInt(readInt8());
            case 'B': return FieldValue::shortShortUint(readUint8());
            case 'U': return FieldValue::shortInt(readInt16());
            case 'u': return FieldValue::shortUint(readUint16());
            case 'I': return FieldValue::longInt(readInt32());
            case 'i': return FieldValue::longUint(readUint32());
            case 'L': return FieldValue::longLongInt(readInt64());
            case 'l': return FieldValue::longLongUint(static_cast<uint64_t>(readUint64()));
            case 'f': {
                uint32_t bits = readUint32();
                float v;
                std::memcpy(&v, &bits, 4);
                return FieldValue::floatVal(v);
            }
            case 'd': {
                uint64_t bits = readUint64();
                double v;
                std::memcpy(&v, &bits, 8);
                return FieldValue::doubleVal(v);
            }
            case 's': return FieldValue::shortString(readShortString());
            case 'S': return FieldValue::longString(readLongString());
            case 'T': return FieldValue::timestamp(readUint64());
            case 'F': return FieldValue::table(readFieldTable(depth + 1));
            case 'A': {
                if (depth > MAX_FIELD_TABLE_DEPTH)
                    throw std::runtime_error("Field table recursion depth exceeded");
                uint32_t arrLen = readUint32();
                size_t end = pos_ + arrLen;
                FieldArray arr;
                while (pos_ < end)
                    arr.push_back(readFieldValue(depth + 1));
                return FieldValue::array(std::move(arr));
            }
            case 'V': return FieldValue::voidVal();
            default:
                throw std::runtime_error(std::string("Unknown field type: ") + tag);
        }
    }

    // --- Write (big-endian / network byte order) ---

    void writeUint8(uint8_t v) {
        data_.push_back(v);
    }

    void writeUint16(uint16_t v) {
        data_.push_back(static_cast<uint8_t>(v >> 8));
        data_.push_back(static_cast<uint8_t>(v));
    }

    void writeUint32(uint32_t v) {
        data_.push_back(static_cast<uint8_t>(v >> 24));
        data_.push_back(static_cast<uint8_t>(v >> 16));
        data_.push_back(static_cast<uint8_t>(v >> 8));
        data_.push_back(static_cast<uint8_t>(v));
    }

    void writeUint64(uint64_t v) {
        for (int i = 56; i >= 0; i -= 8)
            data_.push_back(static_cast<uint8_t>(v >> i));
    }

    void writeInt8(int8_t v) { writeUint8(static_cast<uint8_t>(v)); }
    void writeInt16(int16_t v) { writeUint16(static_cast<uint16_t>(v)); }
    void writeInt32(int32_t v) { writeUint32(static_cast<uint32_t>(v)); }
    void writeInt64(int64_t v) { writeUint64(static_cast<uint64_t>(v)); }

    void writeShortString(const std::string& s) {
        writeUint8(static_cast<uint8_t>(std::min(s.size(), size_t(255))));
        writeBytes(reinterpret_cast<const uint8_t*>(s.data()), std::min(s.size(), size_t(255)));
    }

    void writeLongString(const std::string& s) {
        writeUint32(static_cast<uint32_t>(s.size()));
        writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }

    void writeBytes(const uint8_t* d, size_t len) {
        data_.insert(data_.end(), d, d + len);
    }

    void writeBytes(const std::vector<uint8_t>& v) {
        data_.insert(data_.end(), v.begin(), v.end());
    }

    void writeFieldTable(const FieldTable& table) {
        Buffer inner;
        for (auto& [name, val] : table) {
            inner.writeShortString(name);
            inner.writeFieldValue(val);
        }
        writeUint32(static_cast<uint32_t>(inner.size()));
        writeBytes(inner.data(), inner.size());
    }

    void writeFieldValue(const FieldValue& v) {
        writeUint8(static_cast<uint8_t>(v.type_tag));
        switch (v.type_tag) {
            case 't': writeUint8(v.bool_val ? 1 : 0); break;
            case 'b': writeInt8(static_cast<int8_t>(v.int_val)); break;
            case 'B': writeUint8(static_cast<uint8_t>(v.int_val)); break;
            case 'U': writeInt16(static_cast<int16_t>(v.int_val)); break;
            case 'u': writeUint16(static_cast<uint16_t>(v.int_val)); break;
            case 'I': writeInt32(static_cast<int32_t>(v.int_val)); break;
            case 'i': writeUint32(static_cast<uint32_t>(v.int_val)); break;
            case 'L': writeInt64(v.int_val); break;
            case 'l': writeUint64(static_cast<uint64_t>(v.int_val)); break;
            case 'f': {
                auto fv = static_cast<float>(v.double_val);
                uint32_t bits;
                std::memcpy(&bits, &fv, 4);
                writeUint32(bits);
                break;
            }
            case 'd': {
                uint64_t bits;
                std::memcpy(&bits, &v.double_val, 8);
                writeUint64(bits);
                break;
            }
            case 's': writeShortString(v.string_val); break;
            case 'S': writeLongString(v.string_val); break;
            case 'T': writeUint64(static_cast<uint64_t>(v.int_val)); break;
            case 'F':
                writeFieldTable(v.table_val ? *v.table_val : FieldTable{});
                break;
            case 'A': {
                Buffer inner;
                if (v.array_val) {
                    for (auto& elem : *v.array_val)
                        inner.writeFieldValue(elem);
                }
                writeUint32(static_cast<uint32_t>(inner.size()));
                writeBytes(inner.data(), inner.size());
                break;
            }
            case 'V': break;
            default: break;
        }
    }
};

} // namespace broko::amqp
