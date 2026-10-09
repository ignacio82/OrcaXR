//! Reading what a printer replied, as the browser's printer modules read
//! Moonraker's `result` after `JSON.parse`: a field of a record, an array or
//! nothing, text that is not blank, a finite number — and how an exchange
//! that ended without a reply to read ended.
use orcaxr_contracts::{canonical::JsonLimits, project_intent_types as wire};
use orcaxr_project::js_math::convert::trim_utf16;

pub(crate) use orcaxr_contracts::canonical::Value;

/// A reply is read whole whenever the transport admits it (2 Mi UTF-16
/// units, at most 6 MiB of UTF-8): a long listing is a long listing, not an
/// unreadable one.
pub const LIMITS: JsonLimits = JsonLimits {
    bytes: 8 * 1024 * 1024,
    nodes: 4_000_000,
    depth: 512,
};

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
pub(crate) fn joined(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
pub(crate) fn field<'a>(value: &'a Value, name: &str) -> Option<&'a Value> {
    match value {
        Value::Object(fields) => fields.get(&units(name)),
        _ => None,
    }
}
/// `isRecord`: an object, not an array.
pub(crate) fn record(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| matches!(v, Value::Object(_)))
}
/// `asArray`: its items, or none.
pub(crate) fn array(value: Option<&Value>) -> &[Value] {
    match value {
        Some(Value::Array(items)) => items,
        _ => &[],
    }
}
/// `readString`: text that is not blank, trimmed.
pub(crate) fn read_string(value: Option<&Value>) -> Option<Vec<u16>> {
    match value {
        Some(Value::String(s)) => {
            let trimmed = trim_utf16(s);
            (!trimmed.is_empty()).then(|| trimmed.to_vec())
        }
        _ => None,
    }
}
/// `readNumber`: a finite number.
pub(crate) fn read_number(value: Option<&Value>) -> Option<f64> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Some(*n),
        _ => None,
    }
}
pub(crate) fn optional(value: Option<f64>) -> wire::OptionalFinite {
    match value {
        Some(v) => wire::OptionalFinite::Value(v),
        None => wire::OptionalFinite::Absent(wire::Empty {}),
    }
}
pub(crate) fn known(value: &wire::OptionalFinite) -> Option<f64> {
    match value {
        wire::OptionalFinite::Value(v) => Some(*v),
        wire::OptionalFinite::Absent(_) => None,
    }
}
/// Text an operator reads, or nothing.
pub fn optional_text(value: Option<String>) -> wire::OptionalText {
    match value {
        Some(text) => wire::OptionalText::Value(units(&text)),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
pub(crate) fn optional_reply_text(value: Option<Vec<u16>>) -> wire::OptionalPrinterReplyText {
    match value {
        Some(v) => wire::OptionalPrinterReplyText::Value(v),
        None => wire::OptionalPrinterReplyText::Absent(wire::Empty {}),
    }
}

/// How an exchange that left no reply to read ended.
pub(crate) enum Ending {
    Done,
    /// The caller's cancel, or the transport's.
    Cancelled,
    /// The transport's fault, as its code reads (`request failed` without one).
    Failed(&'static str),
}
pub(crate) fn ending(outcome: &wire::PrinterExchangeOutcome) -> Ending {
    use wire::PrinterExchangeOutcome as Outcome;
    match outcome {
        Outcome::Done(_) => Ending::Done,
        Outcome::Cancelled(_)
        | Outcome::Failed(wire::TransportFailure {
            code: wire::OptionalMoonrakerErrorCode::Value(wire::MoonrakerErrorCode::Cancelled),
            ..
        }) => Ending::Cancelled,
        Outcome::Failed(transport) => Ending::Failed(match &transport.code {
            wire::OptionalMoonrakerErrorCode::Value(code) => crate::control::moonraker_code(*code),
            wire::OptionalMoonrakerErrorCode::Absent(_) => "request failed",
        }),
    }
}
