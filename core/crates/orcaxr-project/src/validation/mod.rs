//! Semantic validation of canonical typed candidates. Timestamp interpretation
//! belongs to an explicit host policy; no native store or session is published.
mod annotations;
mod graph;
mod mixed;
mod report;
pub use graph::validate_project;
pub use report::*;
pub mod timestamp;

use crate::model::Number;
use orcaxr_contracts::canonical::Value;

/// The exact `topZMm.toFixed(4)` collision key used by project validation, even
/// for finite heights outside the authoring range. Multiplying a binary64 by
/// 10_000 first or Rust's fixed formatting would introduce different rounding.
pub fn layer_event_height_key(height: Number) -> String {
    let value = height.get();
    let magnitude = value.abs();
    if magnitude >= 1e21 {
        let mut bytes = Vec::new();
        Value::Number(value).write_canonical(&mut bytes).unwrap();
        return String::from_utf8(bytes).unwrap();
    }
    let bits = magnitude.to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1 << 52 };
    // Exact rational value of |x| * 10^4. Under 10^21 the numerator, shifted
    // result and one rounding carry fit comfortably in u128.
    let numerator = u128::from(mantissa) * 10_000;
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    let rounded = if shift >= 0 {
        numerator << shift
    } else {
        let right = (-shift) as u32;
        if right >= 128 {
            0
        } else {
            // ECMAScript chooses the larger integer at an exact positive tie.
            (numerator + (1u128 << (right - 1))) >> right
        }
    };
    // -0 itself has no sign in toFixed; a negative nonzero rounded to 0 does.
    format!(
        "{}{}.{:04}",
        if value < 0.0 { "-" } else { "" },
        rounded / 10_000,
        rounded % 10_000
    )
}
