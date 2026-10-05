//! Lossless owned decoding and streaming encoding for the project data model.
//! This is a typed candidate boundary, not semantic project validation.
use crate::ids::EntityId;
use orcaxr_contracts::canonical::Value;
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt;
use std::io::{self, Write};
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShapeErrorCode {
    MissingField,
    ExpectedObject,
    ExpectedArray,
    ExpectedText,
    ExpectedNumber,
    ExpectedBoolean,
    InvalidId,
    InvalidLiteral,
    InvalidTupleLength,
    NonFiniteNumber,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathPart {
    Field(&'static str),
    Index(usize),
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShapeError {
    pub code: ShapeErrorCode,
    pub path: Vec<PathPart>,
}
impl ShapeError {
    pub fn new(code: ShapeErrorCode) -> Self {
        Self { code, path: vec![] }
    }
    pub fn at(mut self, part: PathPart) -> Self {
        self.path.insert(0, part);
        self
    }
}
impl fmt::Display for ShapeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Invalid project data ({:?}) at $", self.code)?;
        for part in &self.path {
            match part {
                PathPart::Field(name) => write!(f, ".{name}")?,
                PathPart::Index(index) => write!(f, "[{index}]")?,
            }
        }
        Ok(())
    }
}
impl std::error::Error for ShapeError {}

pub trait Encode {
    fn write_json(&self, output: &mut dyn Write) -> io::Result<()>;
    fn present(&self) -> bool {
        true
    }
    fn to_value(&self) -> io::Result<Value>;
}
pub trait Decode: Sized {
    fn from_value(value: Value) -> Result<Self, ShapeError>;
    fn missing() -> Result<Self, ShapeError> {
        Err(ShapeError::new(ShapeErrorCode::MissingField))
    }
}

/// Complete UTF-16 text. Diagnostics expose length, never private source text.
#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct Text(Arc<[u16]>);
impl Text {
    pub fn new(units: impl Into<Arc<[u16]>>) -> Self {
        Self(units.into())
    }
    pub fn from_utf8(text: &str) -> Self {
        Self(text.encode_utf16().collect::<Vec<_>>().into())
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
}
impl fmt::Debug for Text {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Text")
            .field("utf16_length", &self.0.len())
            .finish()
    }
}
impl Decode for Text {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        match value {
            Value::String(units) => Ok(Self::new(units)),
            _ => Err(ShapeError::new(ShapeErrorCode::ExpectedText)),
        }
    }
}
impl Encode for Text {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        write_text(&self.0, out)
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::String(self.0.to_vec()))
    }
}

/// A finite binary64 value, without imposing safe-integer or pointer-size limits.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Number(f64);
impl Number {
    pub fn new(value: f64) -> Result<Self, ShapeError> {
        if value.is_finite() {
            Ok(Self(value))
        } else {
            Err(ShapeError::new(ShapeErrorCode::NonFiniteNumber))
        }
    }
    pub fn get(self) -> f64 {
        self.0
    }
}
impl Decode for Number {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        match value {
            Value::Number(value) => Self::new(value),
            _ => Err(ShapeError::new(ShapeErrorCode::ExpectedNumber)),
        }
    }
}
impl Encode for Number {
    fn write_json(&self, mut out: &mut dyn Write) -> io::Result<()> {
        Value::Number(self.0).write_canonical(&mut out)
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::Number(self.0))
    }
}
impl Decode for bool {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        match value {
            Value::Bool(v) => Ok(v),
            _ => Err(ShapeError::new(ShapeErrorCode::ExpectedBoolean)),
        }
    }
}
impl Encode for bool {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        out.write_all(if *self { b"true" } else { b"false" })
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::Bool(*self))
    }
}
impl<K> Decode for EntityId<K> {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        let text = Text::from_value(value)?;
        Self::try_from_utf16(text.0).map_err(|_| ShapeError::new(ShapeErrorCode::InvalidId))
    }
}
impl<K> Encode for EntityId<K> {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        write_text(self.as_utf16(), out)
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::String(self.as_utf16().to_vec()))
    }
}
impl<T: Decode> Decode for Option<T> {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        T::from_value(value).map(Some)
    }
    fn missing() -> Result<Self, ShapeError> {
        Ok(None)
    }
}
impl<T: Encode> Encode for Option<T> {
    fn present(&self) -> bool {
        self.is_some()
    }
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        self.as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing optional field"))?
            .write_json(out)
    }
    fn to_value(&self) -> io::Result<Value> {
        self.as_ref()
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "missing optional field"))?
            .to_value()
    }
}
impl<T: Decode> Decode for Arc<T> {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        T::from_value(value).map(Arc::new)
    }
}
impl<T: Encode> Encode for Arc<T> {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        self.as_ref().write_json(out)
    }
    fn to_value(&self) -> io::Result<Value> {
        self.as_ref().to_value()
    }
}
impl<T: Decode> Decode for Arc<[T]> {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        let Value::Array(values) = value else {
            return Err(ShapeError::new(ShapeErrorCode::ExpectedArray));
        };
        values
            .into_iter()
            .enumerate()
            .map(|(i, v)| T::from_value(v).map_err(|e| e.at(PathPart::Index(i))))
            .collect::<Result<Vec<_>, _>>()
            .map(Into::into)
    }
}
impl<T: Encode> Encode for Arc<[T]> {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        out.write_all(b"[")?;
        for (i, v) in self.iter().enumerate() {
            if i > 0 {
                out.write_all(b",")?
            }
            v.write_json(out)?;
        }
        out.write_all(b"]")
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::Array(
            self.iter()
                .map(Encode::to_value)
                .collect::<Result<_, _>>()?,
        ))
    }
}
impl<T: Decode, const N: usize> Decode for [T; N] {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        let Value::Array(values) = value else {
            return Err(ShapeError::new(ShapeErrorCode::ExpectedArray));
        };
        if values.len() != N {
            return Err(ShapeError::new(ShapeErrorCode::InvalidTupleLength));
        }
        let values = values
            .into_iter()
            .enumerate()
            .map(|(i, v)| T::from_value(v).map_err(|e| e.at(PathPart::Index(i))))
            .collect::<Result<Vec<_>, _>>()?;
        Ok(values.try_into().unwrap_or_else(|_| unreachable!()))
    }
}
impl<T: Encode, const N: usize> Encode for [T; N] {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        out.write_all(b"[")?;
        for (i, v) in self.iter().enumerate() {
            if i > 0 {
                out.write_all(b",")?
            }
            v.write_json(out)?;
        }
        out.write_all(b"]")
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::Array(
            self.iter()
                .map(Encode::to_value)
                .collect::<Result<_, _>>()?,
        ))
    }
}

/// Immutable generic JSON. A typed graph clone shares configurations, extension
/// data and sparse annotations; only an explicit public copy expands them.
#[derive(Clone, PartialEq)]
pub struct Json(Arc<Value>);
impl Json {
    pub fn new(value: Value) -> Result<Self, ShapeError> {
        check_finite(&value)?;
        Ok(Self(Arc::new(value)))
    }
    pub fn value(&self) -> &Value {
        &self.0
    }
    pub fn same_allocation(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl fmt::Debug for Json {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Json { .. }")
    }
}
impl Decode for Json {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        Self::new(value)
    }
}
impl Encode for Json {
    fn write_json(&self, mut out: &mut dyn Write) -> io::Result<()> {
        self.0.write_canonical(&mut out)
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(self.0.as_ref().clone())
    }
}
#[derive(Debug, Clone, PartialEq)]
pub struct JsonObject(Json);
impl JsonObject {
    pub fn new(value: Value) -> Result<Self, ShapeError> {
        if !matches!(value, Value::Object(_)) {
            return Err(ShapeError::new(ShapeErrorCode::ExpectedObject));
        }
        Ok(Self(Json::new(value)?))
    }
    pub fn value(&self) -> &Value {
        self.0.value()
    }
    pub fn same_allocation(&self, other: &Self) -> bool {
        self.0.same_allocation(&other.0)
    }
}
impl Decode for JsonObject {
    fn from_value(value: Value) -> Result<Self, ShapeError> {
        Self::new(value)
    }
}
impl Encode for JsonObject {
    fn write_json(&self, out: &mut dyn Write) -> io::Result<()> {
        self.0.write_json(out)
    }
    fn to_value(&self) -> io::Result<Value> {
        self.0.to_value()
    }
}

/// Unknown properties are retained at every record boundary. This type has no
/// mutation API; decode transfers ownership and record updates keep the extras.
#[derive(Clone, PartialEq, Default)]
pub struct ExtraFields(Arc<BTreeMap<Vec<u16>, Json>>);
impl fmt::Debug for ExtraFields {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ExtraFields")
            .field("count", &self.0.len())
            .finish()
    }
}
impl ExtraFields {
    pub fn fields(&self) -> &BTreeMap<Vec<u16>, Json> {
        &self.0
    }
    pub(super) fn decode(fields: BTreeMap<Vec<u16>, Value>) -> Result<Self, ShapeError> {
        Ok(Self(Arc::new(
            fields
                .into_iter()
                .map(|(k, v)| Json::new(v).map(|v| (k, v)))
                .collect::<Result<_, _>>()?,
        )))
    }
}

pub(super) fn take<T: Decode>(
    fields: &mut BTreeMap<Vec<u16>, Value>,
    name: &'static str,
) -> Result<T, ShapeError> {
    match fields.remove(&name.encode_utf16().collect::<Vec<_>>()) {
        Some(value) => T::from_value(value),
        None => T::missing(),
    }
    .map_err(|e| e.at(PathPart::Field(name)))
}
pub(super) fn record_fields<'a>(
    known: impl IntoIterator<Item = (&'static str, &'a dyn Encode)>,
    extra: &'a ExtraFields,
) -> io::Result<BTreeMap<Cow<'a, [u16]>, &'a dyn Encode>> {
    let mut values: BTreeMap<Cow<'a, [u16]>, &dyn Encode> = extra
        .0
        .iter()
        .map(|(k, v)| (Cow::Borrowed(k.as_slice()), v as &dyn Encode))
        .collect();
    for (name, value) in known {
        let key: Vec<u16> = name.encode_utf16().collect();
        if values.contains_key(key.as_slice()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "extra field shadows a known model field",
            ));
        }
        if value.present() {
            values.insert(Cow::Owned(key), value);
        }
    }

    Ok(values)
}
pub(super) fn write_record(
    fields: BTreeMap<Cow<'_, [u16]>, &dyn Encode>,
    out: &mut dyn Write,
) -> io::Result<()> {
    out.write_all(b"{")?;
    for (i, (name, value)) in fields.into_iter().enumerate() {
        if i > 0 {
            out.write_all(b",")?
        }
        write_text(&name, out)?;
        out.write_all(b":")?;
        value.write_json(out)?;
    }
    out.write_all(b"}")
}
pub(super) fn record_value(fields: BTreeMap<Cow<'_, [u16]>, &dyn Encode>) -> io::Result<Value> {
    Ok(Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| v.to_value().map(|v| (k.into_owned(), v)))
            .collect::<Result<_, _>>()?,
    ))
}
fn check_finite(value: &Value) -> Result<(), ShapeError> {
    enum Children<'a> {
        Array(std::slice::Iter<'a, Value>),
        Object(std::collections::btree_map::Values<'a, Vec<u16>, Value>),
    }
    impl<'a> Iterator for Children<'a> {
        type Item = &'a Value;
        fn next(&mut self) -> Option<Self::Item> {
            match self {
                Self::Array(it) => it.next(),
                Self::Object(it) => it.next(),
            }
        }
    }
    let mut stack = vec![];
    let mut next = Some(value);
    loop {
        if let Some(value) = next {
            match value {
                Value::Number(v) if !v.is_finite() => {
                    return Err(ShapeError::new(ShapeErrorCode::NonFiniteNumber));
                }
                Value::Array(v) => stack.push(Children::Array(v.iter())),
                Value::Object(v) => stack.push(Children::Object(v.values())),
                _ => {}
            }
        }
        next = None;
        while let Some(children) = stack.last_mut() {
            if let Some(child) = children.next() {
                next = Some(child);
                break;
            }
            stack.pop();
        }
        if next.is_none() {
            return Ok(());
        }
    }
}
fn write_text(text: &[u16], mut out: &mut dyn Write) -> io::Result<()> {
    orcaxr_contracts::canonical::write_string(text, &mut out)
}
