//! Incremental UTF-8 JSON ingestion. This is a bulk-document boundary, separate
//! from the small generated command and stateless canonicalization envelopes.
use orcaxr_contracts::canonical::Value;
use std::{collections::BTreeMap, fmt};

pub use crate::host_layout::MAX_CHUNK_BYTES;
/// Recursive canonical values must remain safe to encode and drop on all hosts.
/// This implementation bound is not a schema rule for persisted project data.
pub use crate::host_layout::MAX_SUPPORTED_DEPTH;

/// Explicit operation budgets supplied by the owning host. Counts include
/// overwritten properties, so duplicate keys cannot evade resource accounting.
#[derive(Debug, Clone, Copy)]
pub struct JsonLimits {
    pub max_bytes: usize,
    pub max_nodes: usize,
    pub max_text_units: usize,
    pub max_number_bytes: usize,
    pub max_depth: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JsonInputError {
    InvalidLimits,
    Limit,
    InvalidChunk,
    InvalidOffset,
    InvalidJson,
    NonFiniteNumber,
    Incomplete,
    Failed,
}
impl fmt::Display for JsonInputError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Document JSON input failed ({self:?})")
    }
}
impl std::error::Error for JsonInputError {}

/// Own in an import task, not in the live authority. Append never retains source
/// chunks; decoded values are staged until finish. Syntax/resource failures drop
/// all staged data and make this input terminal. A refused offset/chunk leaves
/// progress unchanged. Dropping the input cancels it without publishing state.
pub struct JsonInput {
    expected: usize,
    received: usize,
    parser: Option<Parser>,
}
impl JsonInput {
    pub fn new(expected: usize, limits: JsonLimits) -> Result<Self, JsonInputError> {
        if limits.max_depth > MAX_SUPPORTED_DEPTH || limits.max_number_bytes == 0 {
            return Err(JsonInputError::InvalidLimits);
        }
        if expected > limits.max_bytes {
            return Err(JsonInputError::Limit);
        }
        Ok(Self {
            expected,
            received: 0,
            parser: Some(Parser {
                limits,
                nodes: 0,
                text_units: 0,
                stack: vec![],
                token: Token::None,
                root: None,
            }),
        })
    }
    pub fn received_bytes(&self) -> usize {
        self.received
    }
    pub fn append(&mut self, offset: usize, bytes: &[u8]) -> Result<(), JsonInputError> {
        let parser = self.parser.as_mut().ok_or(JsonInputError::Failed)?;
        if offset != self.received {
            return Err(JsonInputError::InvalidOffset);
        }
        if bytes.is_empty()
            || bytes.len() > MAX_CHUNK_BYTES
            || bytes.len() > self.expected - self.received
        {
            return Err(JsonInputError::InvalidChunk);
        }
        for &byte in bytes {
            if let Err(error) = parser.byte(byte) {
                self.parser = None;
                return Err(error);
            }
        }
        self.received += bytes.len();
        Ok(())
    }
    pub fn finish(self) -> Result<Value, JsonInputError> {
        let mut parser = self.parser.ok_or(JsonInputError::Failed)?;
        if self.received != self.expected {
            return Err(JsonInputError::Incomplete);
        }
        match std::mem::take(&mut parser.token) {
            Token::None => {}
            Token::Number(bytes, state) => parser.number(bytes, state)?,
            _ => return Err(JsonInputError::InvalidJson),
        }
        if !parser.stack.is_empty() {
            return Err(JsonInputError::InvalidJson);
        }
        parser.root.ok_or(JsonInputError::InvalidJson)
    }
}
impl fmt::Debug for JsonInput {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("JsonInput")
            .field("expected_bytes", &self.expected)
            .field("received_bytes", &self.received)
            .field("failed", &self.parser.is_none())
            .finish()
    }
}

struct Parser {
    limits: JsonLimits,
    nodes: usize,
    text_units: usize,
    stack: Vec<Frame>,
    token: Token,
    root: Option<Value>,
}
#[derive(Default)]
enum Token {
    #[default]
    None,
    Literal(&'static [u8], usize),
    Number(Vec<u8>, NumberState),
    String(Vec<u16>, StringState, bool),
}
enum StringState {
    Plain,
    Escape,
    Hex(u16, u8),
    Utf8([u8; 4], usize, usize),
}
#[derive(Clone, Copy)]
enum NumberState {
    Minus,
    Zero,
    Integer,
    Dot,
    Fraction,
    Exponent,
    Sign,
    ExponentDigits,
}
impl NumberState {
    fn complete(self) -> bool {
        matches!(
            self,
            Self::Zero | Self::Integer | Self::Fraction | Self::ExponentDigits
        )
    }
}
enum Frame {
    Array(Vec<Value>, ArrayState),
    Object(BTreeMap<Vec<u16>, Value>, ObjectState),
}
enum ArrayState {
    First,
    Value,
    Separator,
}
enum ObjectState {
    First,
    Key,
    Colon(Vec<u16>),
    Value(Vec<u16>),
    Separator,
}
impl Parser {
    fn begin_value(&mut self) -> Result<(), JsonInputError> {
        let allowed = match self.stack.last() {
            None => self.root.is_none(),
            Some(Frame::Array(_, ArrayState::First | ArrayState::Value)) => true,
            Some(Frame::Object(_, ObjectState::Value(_))) => true,
            _ => false,
        };
        if !allowed {
            return Err(JsonInputError::InvalidJson);
        }
        if self.nodes == self.limits.max_nodes || self.stack.len() > self.limits.max_depth {
            return Err(JsonInputError::Limit);
        }
        self.nodes += 1;
        Ok(())
    }
    fn value(&mut self, value: Value) -> Result<(), JsonInputError> {
        match self.stack.last_mut() {
            None if self.root.is_none() => self.root = Some(value),
            Some(Frame::Array(values, state @ (ArrayState::First | ArrayState::Value))) => {
                values.push(value);
                *state = ArrayState::Separator;
            }
            Some(Frame::Object(values, state @ ObjectState::Value(_))) => {
                let ObjectState::Value(key) = std::mem::replace(state, ObjectState::Separator)
                else {
                    unreachable!()
                };
                // Persisted JSON follows JSON.parse: the last property wins.
                values.insert(key, value);
            }
            _ => return Err(JsonInputError::InvalidJson),
        }
        Ok(())
    }
    fn units(&mut self, target: &mut Vec<u16>, units: &[u16]) -> Result<(), JsonInputError> {
        if units.len() > self.limits.max_text_units - self.text_units {
            return Err(JsonInputError::Limit);
        }
        self.text_units += units.len();
        target.extend_from_slice(units);
        Ok(())
    }
    fn number(&mut self, bytes: Vec<u8>, state: NumberState) -> Result<(), JsonInputError> {
        if !state.complete() {
            return Err(JsonInputError::InvalidJson);
        }
        let number = std::str::from_utf8(&bytes)
            .ok()
            .and_then(|s| s.parse::<f64>().ok())
            .ok_or(JsonInputError::InvalidJson)?;
        if !number.is_finite() {
            return Err(JsonInputError::NonFiniteNumber);
        }
        self.value(Value::Number(number))
    }
    fn byte(&mut self, byte: u8) -> Result<(), JsonInputError> {
        match std::mem::take(&mut self.token) {
            Token::None => self.idle(byte),
            Token::Literal(word, index) => {
                if word[index] != byte {
                    return Err(JsonInputError::InvalidJson);
                }
                if index + 1 == word.len() {
                    self.value(match word {
                        b"null" => Value::Null,
                        b"true" => Value::Bool(true),
                        _ => Value::Bool(false),
                    })
                } else {
                    self.token = Token::Literal(word, index + 1);
                    Ok(())
                }
            }
            Token::Number(mut bytes, state) => {
                use NumberState as N;
                let next = match (state, byte) {
                    (N::Minus, b'0') => Some(N::Zero),
                    (N::Minus, b'1'..=b'9') => Some(N::Integer),
                    (N::Integer, b'0'..=b'9') => Some(N::Integer),
                    (N::Zero | N::Integer, b'.') => Some(N::Dot),
                    (N::Dot | N::Fraction, b'0'..=b'9') => Some(N::Fraction),
                    (N::Zero | N::Integer | N::Fraction, b'e' | b'E') => Some(N::Exponent),
                    (N::Exponent, b'+' | b'-') => Some(N::Sign),
                    (N::Exponent | N::Sign | N::ExponentDigits, b'0'..=b'9') => {
                        Some(N::ExponentDigits)
                    }
                    _ => None,
                };
                if let Some(next) = next {
                    if bytes.len() == self.limits.max_number_bytes {
                        return Err(JsonInputError::Limit);
                    }
                    bytes.push(byte);
                    self.token = Token::Number(bytes, next);
                    Ok(())
                } else {
                    self.number(bytes, state)?;
                    self.idle(byte)
                }
            }
            Token::String(mut units, state, key) => {
                use StringState as S;
                let state = match (state, byte) {
                    (S::Plain, b'"') => {
                        if key {
                            let Some(Frame::Object(
                                _,
                                state @ (ObjectState::First | ObjectState::Key),
                            )) = self.stack.last_mut()
                            else {
                                return Err(JsonInputError::InvalidJson);
                            };
                            *state = ObjectState::Colon(units);
                        } else {
                            self.value(Value::String(units))?;
                        }
                        return Ok(());
                    }
                    (S::Plain, b'\\') => S::Escape,
                    (S::Plain, 0..=31) => return Err(JsonInputError::InvalidJson),
                    (S::Plain, 32..=127) => {
                        self.units(&mut units, &[u16::from(byte)])?;
                        S::Plain
                    }
                    (S::Plain, 0xc2..=0xf4) => S::Utf8(
                        [byte, 0, 0, 0],
                        1,
                        if byte <= 0xdf {
                            2
                        } else if byte <= 0xef {
                            3
                        } else {
                            4
                        },
                    ),
                    (S::Escape, b'u') => S::Hex(0, 0),
                    (S::Escape, b'"' | b'\\' | b'/') => {
                        self.units(&mut units, &[u16::from(byte)])?;
                        S::Plain
                    }
                    (S::Escape, b'b' | b'f' | b'n' | b'r' | b't') => {
                        self.units(
                            &mut units,
                            &[match byte {
                                b'b' => 8,
                                b'f' => 12,
                                b'n' => 10,
                                b'r' => 13,
                                _ => 9,
                            }],
                        )?;
                        S::Plain
                    }
                    (S::Hex(value, count), _) => {
                        let digit = (byte as char)
                            .to_digit(16)
                            .ok_or(JsonInputError::InvalidJson)?
                            as u16;
                        let value = value * 16 + digit;
                        if count == 3 {
                            self.units(&mut units, &[value])?;
                            S::Plain
                        } else {
                            S::Hex(value, count + 1)
                        }
                    }
                    (S::Utf8(mut bytes, len, target), 0x80..=0xbf) => {
                        bytes[len] = byte;
                        if len + 1 == target {
                            let text = std::str::from_utf8(&bytes[..target])
                                .map_err(|_| JsonInputError::InvalidJson)?;
                            let character =
                                text.chars().next().ok_or(JsonInputError::InvalidJson)?;
                            self.units(&mut units, character.encode_utf16(&mut [0; 2]))?;
                            S::Plain
                        } else {
                            S::Utf8(bytes, len + 1, target)
                        }
                    }
                    _ => return Err(JsonInputError::InvalidJson),
                };
                self.token = Token::String(units, state, key);
                Ok(())
            }
        }
    }
    fn idle(&mut self, byte: u8) -> Result<(), JsonInputError> {
        match byte {
            b' ' | b'\t' | b'\r' | b'\n' => return Ok(()),
            b',' => match self.stack.last_mut() {
                Some(Frame::Array(_, state @ ArrayState::Separator)) => *state = ArrayState::Value,
                Some(Frame::Object(_, state @ ObjectState::Separator)) => *state = ObjectState::Key,
                _ => return Err(JsonInputError::InvalidJson),
            },
            b':' => match self.stack.last_mut() {
                Some(Frame::Object(_, state @ ObjectState::Colon(_))) => {
                    let ObjectState::Colon(key) = std::mem::replace(state, ObjectState::Separator)
                    else {
                        unreachable!()
                    };
                    *state = ObjectState::Value(key);
                }
                _ => return Err(JsonInputError::InvalidJson),
            },
            b']' | b'}' => {
                let valid = matches!(
                    (byte, self.stack.last()),
                    (
                        b']',
                        Some(Frame::Array(_, ArrayState::First | ArrayState::Separator))
                    ) | (
                        b'}',
                        Some(Frame::Object(
                            _,
                            ObjectState::First | ObjectState::Separator
                        ))
                    )
                );
                if !valid {
                    return Err(JsonInputError::InvalidJson);
                }
                let value = match self.stack.pop().expect("checked frame") {
                    Frame::Array(v, _) => Value::Array(v),
                    Frame::Object(v, _) => Value::Object(v),
                };
                self.value(value)?;
            }
            b'"' if matches!(
                self.stack.last(),
                Some(Frame::Object(_, ObjectState::First | ObjectState::Key))
            ) =>
            {
                self.token = Token::String(vec![], StringState::Plain, true);
            }
            _ => {
                self.begin_value()?;
                match byte {
                    b'[' => self.stack.push(Frame::Array(vec![], ArrayState::First)),
                    b'{' => self
                        .stack
                        .push(Frame::Object(BTreeMap::new(), ObjectState::First)),
                    b'"' => self.token = Token::String(vec![], StringState::Plain, false),
                    b'n' => self.token = Token::Literal(b"null", 1),
                    b't' => self.token = Token::Literal(b"true", 1),
                    b'f' => self.token = Token::Literal(b"false", 1),
                    b'-' => self.token = Token::Number(vec![byte], NumberState::Minus),
                    b'0' => self.token = Token::Number(vec![byte], NumberState::Zero),
                    b'1'..=b'9' => self.token = Token::Number(vec![byte], NumberState::Integer),
                    _ => return Err(JsonInputError::InvalidJson),
                }
            }
        }
        Ok(())
    }
}
