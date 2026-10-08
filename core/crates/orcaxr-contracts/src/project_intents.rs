//! Bounded JSON for prepared commands. This is not a session or an executor.
use crate::project_intent_types::{MAX_BYTES, MAX_DEPTH, MAX_NODES};
use serde::de::{DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde_json::{Map, Number, Value};
use std::{fmt, io::Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct InvalidIntent;
impl fmt::Display for InvalidIntent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Invalid project command intent")
    }
}
impl std::error::Error for InvalidIntent {}

pub(crate) fn parse(text: &str) -> Result<Value, InvalidIntent> {
    if text.len() > MAX_BYTES || !text.is_ascii() {
        return Err(InvalidIntent);
    }
    let mut remaining = MAX_NODES;
    let mut decoder = serde_json::Deserializer::from_str(text);
    let result = Node {
        remaining: &mut remaining,
        depth: 0,
    }
    .deserialize(&mut decoder)
    .map_err(|_| InvalidIntent)?;
    decoder.end().map_err(|_| InvalidIntent)?;
    Ok(result)
}

struct Node<'a> {
    remaining: &'a mut usize,
    depth: usize,
}
impl<'de> DeserializeSeed<'de> for Node<'_> {
    type Value = Value;
    fn deserialize<D: serde::Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if *self.remaining == 0 || self.depth > MAX_DEPTH {
            return Err(serde::de::Error::custom("invalid intent"));
        }
        *self.remaining -= 1;
        deserializer.deserialize_any(self)
    }
}
impl<'de> Visitor<'de> for Node<'_> {
    type Value = Value;
    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("bounded JSON")
    }
    fn visit_bool<E: serde::de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }
    fn visit_unit<E: serde::de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }
    fn visit_i64<E: serde::de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_u64<E: serde::de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(value.into())
    }
    fn visit_f64<E: serde::de::Error>(self, value: f64) -> Result<Value, E> {
        Number::from_f64(value)
            .map(Value::Number)
            .ok_or_else(|| E::custom("invalid intent"))
    }
    fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.into()))
    }
    fn visit_string<E: serde::de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }
    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut values = Vec::new();
        while let Some(value) = seq.next_element_seed(Node {
            remaining: self.remaining,
            depth: self.depth + 1,
        })? {
            values.push(value);
        }
        Ok(Value::Array(values))
    }
    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut values = Map::new();
        while let Some(key) = map.next_key::<String>()? {
            if values.contains_key(&key) {
                return Err(serde::de::Error::custom("invalid intent"));
            }
            let value = map.next_value_seed(Node {
                remaining: self.remaining,
                depth: self.depth + 1,
            })?;
            values.insert(key, value);
        }
        Ok(Value::Object(values))
    }
}

pub(crate) fn fields<'a>(
    value: &'a Value,
    names: &[&str],
    union: bool,
) -> Result<&'a Map<String, Value>, InvalidIntent> {
    let object = value.as_object().ok_or(InvalidIntent)?;
    if object.len() != if union { 1 } else { names.len() }
        || object.keys().any(|key| !names.contains(&key.as_str()))
    {
        return Err(InvalidIntent);
    }
    Ok(object)
}
pub(crate) fn number(value: &Value, min: f64, max: f64) -> Result<f64, InvalidIntent> {
    let number = value.as_f64().ok_or(InvalidIntent)?;
    if !number.is_finite() || number < min || number > max {
        return Err(InvalidIntent);
    }
    Ok(if number == 0.0 { 0.0 } else { number })
}
pub(crate) fn whole_number(value: &Value, min: f64, max: f64) -> Result<f64, InvalidIntent> {
    // Project plate order follows Number.isInteger, not the narrower safe-integer
    // rule used for counters. Persisted large finite integer values remain valid.
    let number = number(value, min, max)?;
    if number.fract() != 0.0 {
        return Err(InvalidIntent);
    }
    Ok(if number == 0.0 { 0.0 } else { number })
}
pub(crate) fn integer(value: &Value, min: u64, max: u64) -> Result<u64, InvalidIntent> {
    // Numeric value semantics include decimal/exponent spellings and -0.
    Ok(whole_number(value, min as f64, max as f64)? as u64)
}
pub(crate) fn list(value: &Value, min: usize, max: usize) -> Result<&[Value], InvalidIntent> {
    let list = value.as_array().ok_or(InvalidIntent)?;
    if !(min..=max).contains(&list.len()) {
        return Err(InvalidIntent);
    }
    Ok(list)
}

struct Output(Vec<u8>);
impl Write for Output {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() > MAX_BYTES - self.0.len() {
            return Err(std::io::Error::other("invalid intent"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
/// Numbers as JavaScript writes them (`JSON.stringify`), so every binding's
/// wire text is byte-identical to the browser's: `1` not `1.0`, `0` for `-0`.
struct JsNumbers;
impl serde_json::ser::Formatter for JsNumbers {
    fn write_f64<W: ?Sized + Write>(&mut self, writer: &mut W, value: f64) -> std::io::Result<()> {
        // Only finite values reach the formatter; the serializer writes the
        // rest as `null`, which every decoder then refuses.
        if value == 0.0 {
            writer.write_all(b"0")
        } else {
            writer.write_all(ryu_js::Buffer::new().format_finite(value).as_bytes())
        }
    }
}
pub(crate) fn encode(value: &impl serde::Serialize) -> Result<String, InvalidIntent> {
    let mut output = Output(Vec::new());
    let mut serializer = serde_json::Serializer::with_formatter(&mut output, JsNumbers);
    value
        .serialize(&mut serializer)
        .map_err(|_| InvalidIntent)?;
    String::from_utf8(output.0).map_err(|_| InvalidIntent)
}
