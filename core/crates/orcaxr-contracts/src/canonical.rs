//! JavaScript-compatible canonical JSON. Strings remain UTF-16 code units so
//! lone surrogates and key ordering survive a native/browser round trip.
use std::collections::BTreeMap;
use std::io::{self, Write};

use crate::CoreError;

const MAX_DEPTH: usize = 64;
const MAX_NODES: usize = 100_000;

#[derive(Debug, PartialEq)]
pub enum Value {
    Null,
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Value>),
    Object(BTreeMap<Vec<u16>, Value>),
}

pub fn parse(source: &str) -> Result<Value, CoreError> {
    if source.len() > crate::generated::MAX_INPUT_BYTES {
        return Err(CoreError::input_limit());
    }
    let mut parser = Parser {
        source,
        offset: 0,
        nodes: 0,
    };
    let value = parser.value(0)?;
    parser.space();
    if parser.offset != source.len() {
        return Err(CoreError::invalid_json());
    }
    Ok(value)
}

impl Value {
    /// Writes incrementally, including to a digest sink without materializing JSON.
    pub fn write_canonical(&self, out: &mut impl Write) -> io::Result<()> {
        match self {
            Self::Null => out.write_all(b"null"),
            Self::Bool(true) => out.write_all(b"true"),
            Self::Bool(false) => out.write_all(b"false"),
            Self::Number(value) => {
                if !value.is_finite() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        "non-finite number",
                    ));
                }
                if *value == 0.0 {
                    out.write_all(b"0")
                } else {
                    out.write_all(ryu_js::Buffer::new().format(*value).as_bytes())
                }
            }
            Self::String(value) => write_string(value, out),
            Self::Array(values) => {
                out.write_all(b"[")?;
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        out.write_all(b",")?;
                    }
                    value.write_canonical(out)?;
                }
                out.write_all(b"]")
            }
            Self::Object(values) => {
                out.write_all(b"{")?;
                for (index, (key, value)) in values.iter().enumerate() {
                    if index > 0 {
                        out.write_all(b",")?;
                    }
                    write_string(key, out)?;
                    out.write_all(b":")?;
                    value.write_canonical(out)?;
                }
                out.write_all(b"}")
            }
        }
    }
}

fn write_string(value: &[u16], out: &mut impl Write) -> io::Result<()> {
    out.write_all(b"\"")?;
    for decoded in char::decode_utf16(value.iter().copied()) {
        match decoded {
            Err(error) => write!(out, "\\u{:04x}", error.unpaired_surrogate())?,
            Ok('"') => out.write_all(b"\\\"")?,
            Ok('\\') => out.write_all(b"\\\\")?,
            Ok('\u{08}') => out.write_all(b"\\b")?,
            Ok('\u{0c}') => out.write_all(b"\\f")?,
            Ok('\n') => out.write_all(b"\\n")?,
            Ok('\r') => out.write_all(b"\\r")?,
            Ok('\t') => out.write_all(b"\\t")?,
            Ok(character) if character < '\u{20}' => write!(out, "\\u{:04x}", character as u32)?,
            Ok(character) => {
                out.write_all(character.encode_utf8(&mut [0; 4]).as_bytes())?;
            }
        }
    }
    out.write_all(b"\"")
}

struct Parser<'a> {
    source: &'a str,
    offset: usize,
    nodes: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.source.as_bytes().get(self.offset).copied()
    }
    fn space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\r' | b'\n')) {
            self.offset += 1;
        }
    }
    fn take(&mut self, byte: u8) -> bool {
        if self.peek() == Some(byte) {
            self.offset += 1;
            true
        } else {
            false
        }
    }
    fn expect(&mut self, byte: u8) -> Result<(), CoreError> {
        if self.take(byte) {
            Ok(())
        } else {
            Err(CoreError::invalid_json())
        }
    }
    fn literal(&mut self, suffix: &str, value: Value) -> Result<Value, CoreError> {
        if !self.source[self.offset..].starts_with(suffix) {
            return Err(CoreError::invalid_json());
        }
        self.offset += suffix.len();
        Ok(value)
    }
    fn value(&mut self, depth: usize) -> Result<Value, CoreError> {
        self.space();
        self.nodes += 1;
        if depth > MAX_DEPTH || self.nodes > MAX_NODES {
            return Err(CoreError::input_limit());
        }
        match self.peek() {
            Some(b'n') => self.literal("null", Value::Null),
            Some(b't') => self.literal("true", Value::Bool(true)),
            Some(b'f') => self.literal("false", Value::Bool(false)),
            Some(b'"') => Ok(Value::String(self.string()?)),
            Some(b'[') => {
                self.offset += 1;
                let mut values = Vec::new();
                self.space();
                if !self.take(b']') {
                    loop {
                        values.push(self.value(depth + 1)?);
                        self.space();
                        if self.take(b']') {
                            break;
                        }
                        self.expect(b',')?;
                    }
                }
                Ok(Value::Array(values))
            }
            Some(b'{') => {
                self.offset += 1;
                let mut values = BTreeMap::new();
                self.space();
                if !self.take(b'}') {
                    loop {
                        self.space();
                        let key = self.string()?;
                        self.space();
                        self.expect(b':')?;
                        // JSON.parse resolves duplicate properties to the last value.
                        values.insert(key, self.value(depth + 1)?);
                        self.space();
                        if self.take(b'}') {
                            break;
                        }
                        self.expect(b',')?;
                    }
                }
                Ok(Value::Object(values))
            }
            Some(b'-' | b'0'..=b'9') => self.number(),
            _ => Err(CoreError::invalid_json()),
        }
    }
    fn string(&mut self) -> Result<Vec<u16>, CoreError> {
        self.expect(b'"')?;
        let mut units = Vec::new();
        loop {
            match self.peek() {
                Some(b'"') => {
                    self.offset += 1;
                    return Ok(units);
                }
                Some(b'\\') => {
                    self.offset += 1;
                    let escape = self.peek().ok_or_else(CoreError::invalid_json)?;
                    self.offset += 1;
                    units.push(match escape {
                        b'"' | b'\\' | b'/' => escape as u16,
                        b'b' => 8,
                        b'f' => 12,
                        b'n' => 10,
                        b'r' => 13,
                        b't' => 9,
                        b'u' => {
                            let mut unit = 0u16;
                            for _ in 0..4 {
                                let digit = self
                                    .peek()
                                    .and_then(|byte| (byte as char).to_digit(16))
                                    .ok_or_else(CoreError::invalid_json)?;
                                unit = unit * 16 + digit as u16;
                                self.offset += 1;
                            }
                            unit
                        }
                        _ => return Err(CoreError::invalid_json()),
                    });
                }
                Some(0..=31) | None => return Err(CoreError::invalid_json()),
                Some(_) => {
                    let character = self.source[self.offset..]
                        .chars()
                        .next()
                        .ok_or_else(CoreError::invalid_json)?;
                    units.extend_from_slice(character.encode_utf16(&mut [0; 2]));
                    self.offset += character.len_utf8();
                }
            }
        }
    }
    fn digits(&mut self) -> Result<(), CoreError> {
        let start = self.offset;
        while matches!(self.peek(), Some(b'0'..=b'9')) {
            self.offset += 1;
        }
        if self.offset == start {
            Err(CoreError::invalid_json())
        } else {
            Ok(())
        }
    }
    fn number(&mut self) -> Result<Value, CoreError> {
        let start = self.offset;
        self.take(b'-');
        if !self.take(b'0') {
            self.digits()?;
        }
        if self.take(b'.') {
            self.digits()?;
        }
        if self.take(b'e') || self.take(b'E') {
            if !self.take(b'+') {
                self.take(b'-');
            }
            self.digits()?;
        }
        let number: f64 = self.source[start..self.offset]
            .parse()
            .map_err(|_| CoreError::invalid_json())?;
        if !number.is_finite() {
            return Err(CoreError::non_finite());
        }
        Ok(Value::Number(number))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn encode(source: &str) -> String {
        let mut bytes = Vec::new();
        parse(source).unwrap().write_canonical(&mut bytes).unwrap();
        String::from_utf8(bytes).unwrap()
    }
    #[test]
    fn preserves_surrogates_and_orders_utf16_keys() {
        assert_eq!(
            encode(r#"{"\ue000":1,"\ud800\udc00":2,"\ud800":3}"#),
            "{\"\\ud800\":3,\"𐀀\":2,\"\u{e000}\":1}"
        );
        assert_eq!(
            encode(r#""\udc00\ud800x\ud83d\udc33""#),
            "\"\\udc00\\ud800x🐳\""
        );
    }
    #[test]
    fn follows_javascript_number_and_property_semantics() {
        assert_eq!(
            encode(r#"[1e-7,1e-6,1e20,1e21,-0,9007199254740993]"#),
            "[1e-7,0.000001,100000000000000000000,1e+21,0,9007199254740992]"
        );
        assert_eq!(
            encode(r#"{"z":1,"z":2,"2":3,"10":4,"__proto__":5}"#),
            r#"{"10":4,"2":3,"__proto__":5,"z":2}"#
        );
    }
    #[test]
    fn rejects_malformed_and_unbounded_input() {
        for source in [
            "",
            "01",
            "1.",
            "-.1",
            "[1,]",
            "{\"a\":1,}",
            "[",
            "true false",
            "\"\\uZZZZ\"",
            "\"\n\"",
        ] {
            assert!(parse(source).is_err(), "accepted {source:?}");
        }
        assert_eq!(parse("1e400").unwrap_err().code, "non_finite_number");
        assert_eq!(
            parse(&format!("{}0{}", "[".repeat(66), "]".repeat(66)))
                .unwrap_err()
                .code,
            "input_limit"
        );
        for value in [f64::NAN, f64::INFINITY, f64::NEG_INFINITY] {
            assert!(
                Value::Number(value)
                    .write_canonical(&mut Vec::new())
                    .is_err()
            );
        }
    }
}
