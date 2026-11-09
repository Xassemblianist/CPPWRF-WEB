// SPDX-License-Identifier: GPL-3.0-or-later
// A small JSON value for the forecast server: parse (with depth and size limits), access, dump.
#pragma once
#include <cctype>
#include <cmath>
#include <cstdlib>
#include <cstdio>
#include <map>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>

namespace json {

struct Value {
  enum Kind { Null, Bool, Number, String, Array, Object } kind = Null;
  bool b = false;
  double n = 0;
  std::string s;
  std::vector<Value> a;
  std::map<std::string, Value> o;

  Value() = default;
  Value(std::nullptr_t) {}
  Value(bool v) : kind(Bool), b(v) {}
  Value(int v) : kind(Number), n(v) {}
  Value(long v) : kind(Number), n(double(v)) {}
  Value(long long v) : kind(Number), n(double(v)) {}
  Value(double v) : kind(Number), n(v) {}
  Value(const char* v) : kind(String), s(v) {}
  Value(std::string v) : kind(String), s(std::move(v)) {}
  static Value array() { Value v; v.kind = Array; return v; }
  static Value object() { Value v; v.kind = Object; return v; }

  bool is_null() const { return kind == Null; }
  bool is_object() const { return kind == Object; }
  bool has(const std::string& k) const { return kind == Object && o.count(k); }
  const Value& operator[](const std::string& k) const {
    static const Value null;
    if (kind != Object) return null;
    auto it = o.find(k);
    return it == o.end() ? null : it->second;
  }
  Value& operator[](const std::string& k) {
    if (kind == Null) kind = Object;
    return o[k];
  }
  void push(Value v) { if (kind == Null) kind = Array; a.push_back(std::move(v)); }
  double num(double d = 0) const { return kind == Number ? n : d; }
  std::string str(const std::string& d = "") const { return kind == String ? s : d; }
  bool boolean(bool d = false) const { return kind == Bool ? b : d; }
};

inline void dump_string(std::string& out, const std::string& s) {
  out += '"';
  for (unsigned char c : s) {
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default:
        if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; }
        else out += char(c);
    }
  }
  out += '"';
}

inline void dump(std::string& out, const Value& v) {
  switch (v.kind) {
    case Value::Null: out += "null"; break;
    case Value::Bool: out += v.b ? "true" : "false"; break;
    case Value::Number: {
      if (!std::isfinite(v.n)) { out += "null"; break; }
      char b[32];
      if (v.n == std::floor(v.n) && std::fabs(v.n) < 1e15) std::snprintf(b, sizeof b, "%.0f", v.n);
      else std::snprintf(b, sizeof b, "%.10g", v.n);
      out += b;
      break;
    }
    case Value::String: dump_string(out, v.s); break;
    case Value::Array: {
      out += '[';
      for (size_t i = 0; i < v.a.size(); ++i) { if (i) out += ','; dump(out, v.a[i]); }
      out += ']';
      break;
    }
    case Value::Object: {
      out += '{';
      bool first = true;
      for (const auto& [k, x] : v.o) { if (!first) out += ','; first = false; dump_string(out, k); out += ':'; dump(out, x); }
      out += '}';
      break;
    }
  }
}
inline std::string dump(const Value& v) { std::string s; dump(s, v); return s; }

class Parser {
 public:
  explicit Parser(const std::string& t) : t_(t) {}
  Value parse() {
    Value v = value(0);
    ws();
    if (i_ != t_.size()) fail("trailing characters");
    return v;
  }

 private:
  const std::string& t_;
  size_t i_ = 0;
  [[noreturn]] void fail(const char* m) { throw std::runtime_error(std::string("JSON: ") + m); }
  void ws() { while (i_ < t_.size() && (t_[i_] == ' ' || t_[i_] == '\t' || t_[i_] == '\n' || t_[i_] == '\r')) ++i_; }
  bool lit(const char* w) {
    size_t n = std::char_traits<char>::length(w);
    if (t_.compare(i_, n, w) == 0) { i_ += n; return true; }
    return false;
  }
  Value value(int depth) {
    if (depth > 32) fail("too deep");
    ws();
    if (i_ >= t_.size()) fail("unexpected end");
    char c = t_[i_];
    if (c == '{') {
      ++i_;
      Value v = Value::object();
      ws();
      if (i_ < t_.size() && t_[i_] == '}') { ++i_; return v; }
      while (true) {
        ws();
        if (i_ >= t_.size() || t_[i_] != '"') fail("key expected");
        std::string k = string();
        ws();
        if (i_ >= t_.size() || t_[i_] != ':') fail("':' expected");
        ++i_;
        v.o[k] = value(depth + 1);
        ws();
        if (i_ < t_.size() && t_[i_] == ',') { ++i_; continue; }
        if (i_ < t_.size() && t_[i_] == '}') { ++i_; return v; }
        fail("',' or '}' expected");
      }
    }
    if (c == '[') {
      ++i_;
      Value v = Value::array();
      ws();
      if (i_ < t_.size() && t_[i_] == ']') { ++i_; return v; }
      while (true) {
        v.a.push_back(value(depth + 1));
        ws();
        if (i_ < t_.size() && t_[i_] == ',') { ++i_; continue; }
        if (i_ < t_.size() && t_[i_] == ']') { ++i_; return v; }
        fail("',' or ']' expected");
      }
    }
    if (c == '"') return Value(string());
    if (lit("true")) return Value(true);
    if (lit("false")) return Value(false);
    if (lit("null")) return Value();
    size_t j = i_;
    if (j < t_.size() && (t_[j] == '-' || t_[j] == '+')) ++j;
    while (j < t_.size() && (std::isdigit(static_cast<unsigned char>(t_[j])) || t_[j] == '.' || t_[j] == 'e' || t_[j] == 'E' ||
                             t_[j] == '-' || t_[j] == '+'))
      ++j;
    if (j == i_) fail("value expected");
    const std::string num = t_.substr(i_, j - i_);
    char* end = nullptr;
    const double d = std::strtod(num.c_str(), &end);
    if (end != num.c_str() + num.size() || !std::isfinite(d)) fail("bad number");
    i_ = j;
    return Value(d);
  }
  std::string string() {
    ++i_;
    std::string r;
    while (i_ < t_.size() && t_[i_] != '"') {
      char c = t_[i_++];
      if (c == '\\') {
        if (i_ >= t_.size()) fail("bad escape");
        char e = t_[i_++];
        switch (e) {
          case 'n': r += '\n'; break;
          case 't': r += '\t'; break;
          case 'r': r += '\r'; break;
          case 'b': r += '\b'; break;
          case 'f': r += '\f'; break;
          case 'u': {
            if (i_ + 4 > t_.size()) fail("bad escape");
            unsigned cp = std::stoul(t_.substr(i_, 4), nullptr, 16);
            i_ += 4;
            if (cp < 0x80) r += char(cp);
            else if (cp < 0x800) { r += char(0xC0 | (cp >> 6)); r += char(0x80 | (cp & 0x3F)); }
            else { r += char(0xE0 | (cp >> 12)); r += char(0x80 | ((cp >> 6) & 0x3F)); r += char(0x80 | (cp & 0x3F)); }
            break;
          }
          default: r += e;
        }
      } else if (static_cast<unsigned char>(c) < 0x20) {
        fail("control character in string");
      } else {
        r += c;
      }
    }
    if (i_ >= t_.size()) fail("unterminated string");
    ++i_;
    return r;
  }
};

inline Value parse(const std::string& t) { return Parser(t).parse(); }

}  // namespace json
