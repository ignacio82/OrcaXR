//! ECMAScript conversions shared by every browser-parity port.
//!
//! The browser reads foreign metadata and configuration through `Number`,
//! `parseInt`, `parseFloat`, `String`, `toFixed` and `trim`. Rust's own
//! parsers accept different spellings (`inf`, `nan`, `_`), its whitespace
//! classes differ and `{:.N}` rounds ties to even, so ports use these helpers
//! instead of `str::parse`, `str::trim` or `format!`.
use orcaxr_contracts::canonical::Value;
use std::str::FromStr;

/// ECMAScript WhiteSpace and LineTerminator code points (`\s`, `trim`).
pub fn is_space(c: char) -> bool {
    matches!(
        c as u32,
        0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f
            | 0x3000 | 0xfeff
    )
}
pub fn trim(s: &str) -> &str {
    s.trim_matches(is_space)
}
pub fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_space)
}
/// `\w` without the Unicode flag.
pub fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `Number(string)` (StringToNumber). Returns NaN for every invalid spelling.
pub fn number(s: &str) -> f64 {
    let s = trim(s);
    if s.is_empty() {
        return 0.0;
    }
    for (prefix, radix) in [
        ("0x", 16),
        ("0X", 16),
        ("0o", 8),
        ("0O", 8),
        ("0b", 2),
        ("0B", 2),
    ] {
        if let Some(digits) = s.strip_prefix(prefix) {
            return radix_integer(digits, radix).unwrap_or(f64::NAN);
        }
    }
    let (sign, unsigned) = match s.as_bytes()[0] {
        b'+' => (1.0, &s[1..]),
        b'-' => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    if unsigned == "Infinity" {
        return sign * f64::INFINITY;
    }
    if decimal_prefix(unsigned) == unsigned.len() && !unsigned.is_empty() {
        // Rust's parser is correctly rounded for this validated grammar.
        return sign * f64::from_str(unsigned).unwrap_or(f64::NAN);
    }
    f64::NAN
}

/// Length of the longest StrUnsignedDecimalLiteral prefix (without Infinity).
/// Zero means no decimal digits were present.
fn decimal_prefix(s: &str) -> usize {
    let b = s.as_bytes();
    let mut i = 0;
    let int_digits = b.iter().take_while(|c| c.is_ascii_digit()).count();
    i += int_digits;
    let mut frac_digits = 0;
    if b.get(i) == Some(&b'.') {
        frac_digits = b[i + 1..].iter().take_while(|c| c.is_ascii_digit()).count();
        if int_digits == 0 && frac_digits == 0 {
            return 0;
        }
        i += 1 + frac_digits;
    }
    if int_digits == 0 && frac_digits == 0 {
        return 0;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        let mut j = i + 1;
        if matches!(b.get(j), Some(b'+' | b'-')) {
            j += 1;
        }
        let exp = b[j.min(b.len())..]
            .iter()
            .take_while(|c| c.is_ascii_digit())
            .count();
        if exp > 0 {
            i = j + exp;
        }
    }
    i
}

/// Exact round-half-even conversion of an unsigned radix-2^k integer.
fn radix_integer(digits: &str, radix: u32) -> Option<f64> {
    if digits.is_empty() {
        return None;
    }
    let bits_per = match radix {
        16 => 4,
        8 => 3,
        _ => 1,
    };
    let mut bits = Vec::new();
    for c in digits.chars() {
        let d = c.to_digit(radix)?;
        for k in (0..bits_per).rev() {
            bits.push((d >> k) & 1 == 1);
        }
    }
    Some(bits_to_f64(&bits))
}
fn bits_to_f64(bits: &[bool]) -> f64 {
    let first = match bits.iter().position(|b| *b) {
        Some(i) => i,
        None => return 0.0,
    };
    let bits = &bits[first..];
    if bits.len() <= 53 {
        return bits
            .iter()
            .fold(0.0, |v, b| v * 2.0 + f64::from(u8::from(*b)));
    }
    let mut mantissa = bits[..53]
        .iter()
        .fold(0u64, |v, b| (v << 1) | u64::from(*b));
    let guard = bits[53];
    let sticky = bits[54..].iter().any(|b| *b);
    if guard && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
    }
    let exponent = (bits.len() - 53) as i32;
    (mantissa as f64) * 2f64.powi(exponent)
}

/// `Number.parseFloat`.
pub fn parse_float(s: &str) -> f64 {
    let s = trim_start(s);
    let (sign, unsigned) = match s.as_bytes().first() {
        Some(b'+') => (1.0, &s[1..]),
        Some(b'-') => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    if unsigned.starts_with("Infinity") {
        return sign * f64::INFINITY;
    }
    let n = decimal_prefix(unsigned);
    if n == 0 {
        return f64::NAN;
    }
    sign * f64::from_str(&unsigned[..n]).unwrap_or(f64::NAN)
}

/// `Number.parseInt(s, 10)`.
pub fn parse_int10(s: &str) -> f64 {
    let s = trim_start(s);
    let (sign, unsigned) = match s.as_bytes().first() {
        Some(b'+') => (1.0, &s[1..]),
        Some(b'-') => (-1.0, &s[1..]),
        _ => (1.0, s),
    };
    let n = unsigned.bytes().take_while(u8::is_ascii_digit).count();
    if n == 0 {
        return f64::NAN;
    }
    sign * f64::from_str(&unsigned[..n]).unwrap_or(f64::NAN)
}

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;
pub fn is_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0
}
pub fn is_safe_integer(n: f64) -> bool {
    is_integer(n) && n.abs() <= MAX_SAFE_INTEGER
}

/// `Number::toString()` for finite and non-finite values.
pub fn number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".into();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let mut bytes = Vec::new();
    Value::Number(n)
        .write_canonical(&mut bytes)
        .expect("in-memory number");
    String::from_utf8(bytes).expect("ASCII number")
}

/// The exact integer nearest `|value| * 10^digits`, choosing the larger one at
/// a tie, as `Number.prototype.toFixed` requires. `value` must be finite with
/// magnitude below 10^21 and `digits` at most 15, so the scaled numerator,
/// shift and rounding carry all fit in u128. Multiplying in binary64 first
/// would round before the required decimal step.
pub fn fixed_scaled(value: f64, digits: u32) -> u128 {
    assert!(digits <= 15 && value.is_finite() && value.abs() < 1e21);
    let bits = value.abs().to_bits();
    let exponent = ((bits >> 52) & 0x7ff) as i32;
    let mantissa = (bits & ((1u64 << 52) - 1)) | if exponent == 0 { 0 } else { 1 << 52 };
    let numerator = u128::from(mantissa) * 10u128.pow(digits);
    let shift = if exponent == 0 {
        -1074
    } else {
        exponent - 1075
    };
    if shift >= 0 {
        numerator << shift
    } else {
        let right = (-shift) as u32;
        if right >= 128 {
            0
        } else {
            (numerator + (1u128 << (right - 1))) >> right
        }
    }
}

/// `Number.prototype.toFixed(digits)` for `digits <= 15`: ties away from
/// zero, a sign on a negative value rounded to zero (but not on -0), and the
/// ordinary `String(number)` spelling for NaN, infinities and magnitudes of at
/// least 10^21.
pub fn to_fixed(value: f64, digits: u32) -> String {
    if !value.is_finite() || value.abs() >= 1e21 {
        return number_to_string(value);
    }
    let scaled = fixed_scaled(value, digits);
    let scale = 10u128.pow(digits);
    let sign = if value < 0.0 { "-" } else { "" };
    if digits == 0 {
        return format!("{sign}{scaled}");
    }
    format!(
        "{sign}{}.{:0width$}",
        scaled / scale,
        scaled % scale,
        width = digits as usize
    )
}

/// `String(value)` for JSON values. Strings are returned as UTF-16 units.
pub fn value_to_string(value: &Value) -> Vec<u16> {
    match value {
        Value::Null => "null".encode_utf16().collect(),
        Value::Bool(b) => (if *b { "true" } else { "false" }).encode_utf16().collect(),
        Value::Number(n) => number_to_string(*n).encode_utf16().collect(),
        Value::String(s) => s.clone(),
        Value::Array(items) => {
            // Array.prototype.join: null/undefined elements become empty.
            let mut out = Vec::new();
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(u16::from(b','));
                }
                if !matches!(item, Value::Null) {
                    out.extend(value_to_string(item));
                }
            }
            out
        }
        Value::Object(_) => "[object Object]".encode_utf16().collect(),
    }
}

/// `JSON.stringify(value)` for JSON values. Object members follow JavaScript
/// property order for an object parsed from canonical JSON: array-index keys in
/// numeric order, then the other keys in canonical (UTF-16) order. Lone
/// surrogates are escaped, as ES2019's well-formed `JSON.stringify` does.
pub fn json_stringify(value: &Value) -> Vec<u16> {
    let mut out = Vec::new();
    stringify(value, &mut out);
    out
}
fn stringify(value: &Value, out: &mut Vec<u16>) {
    match value {
        Value::Null => out.extend("null".encode_utf16()),
        Value::Bool(b) => out.extend((if *b { "true" } else { "false" }).encode_utf16()),
        Value::Number(n) if n.is_finite() => out.extend(number_to_string(*n).encode_utf16()),
        Value::Number(_) => out.extend("null".encode_utf16()),
        Value::String(units) => quote(units, out),
        Value::Array(items) => {
            out.push(u16::from(b'['));
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(u16::from(b','));
                }
                stringify(item, out);
            }
            out.push(u16::from(b']'));
        }
        Value::Object(fields) => {
            let mut keys: Vec<&Vec<u16>> = fields.keys().collect();
            // Array indices come first, numerically; the sort is stable.
            keys.sort_by_key(|key| array_index(key).map_or((1, 0), |i| (0, i)));
            out.push(u16::from(b'{'));
            for (index, key) in keys.into_iter().enumerate() {
                if index > 0 {
                    out.push(u16::from(b','));
                }
                quote(key, out);
                out.push(u16::from(b':'));
                stringify(&fields[key], out);
            }
            out.push(u16::from(b'}'));
        }
    }
}
/// A canonical array index: `0` or a decimal without a leading zero, below
/// 2^32 - 1.
fn array_index(key: &[u16]) -> Option<u64> {
    if key.is_empty() || key.len() > 10 || (key.len() > 1 && key[0] == u16::from(b'0')) {
        return None;
    }
    let mut value = 0u64;
    for unit in key {
        let digit = char::from_u32(u32::from(*unit))?.to_digit(10)?;
        value = value * 10 + u64::from(digit);
    }
    (value < 4_294_967_295).then_some(value)
}
/// `QuoteJSONString`.
fn quote(units: &[u16], out: &mut Vec<u16>) {
    out.push(u16::from(b'"'));
    for decoded in char::decode_utf16(units.iter().copied()) {
        match decoded {
            Ok(c) => {
                let escape = match c {
                    '\u{8}' => Some("\\b"),
                    '\t' => Some("\\t"),
                    '\n' => Some("\\n"),
                    '\u{c}' => Some("\\f"),
                    '\r' => Some("\\r"),
                    '"' => Some("\\\""),
                    '\\' => Some("\\\\"),
                    _ => None,
                };
                if let Some(escape) = escape {
                    out.extend(escape.encode_utf16());
                } else if (c as u32) < 0x20 {
                    out.extend(format!("\\u{:04x}", c as u32).encode_utf16());
                } else {
                    let mut buffer = [0u16; 2];
                    out.extend_from_slice(c.encode_utf16(&mut buffer));
                }
            }
            Err(lone) => out.extend(format!("\\u{:04x}", lone.unpaired_surrogate()).encode_utf16()),
        }
    }
    out.push(u16::from(b'"'));
}

/// `Number(value)` (ToNumber) for JSON values; `None` is `undefined`.
pub fn value_to_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => *n,
        Some(Value::String(units)) => utf16_number(units),
        Some(v @ Value::Array(_)) => utf16_number(&value_to_string(v)),
        Some(Value::Object(_)) => f64::NAN,
    }
}
/// StringToNumber over UTF-16. A lone surrogate is never numeric syntax.
pub fn utf16_number(units: &[u16]) -> f64 {
    match String::from_utf16(units) {
        Ok(s) => number(&s),
        Err(_) => f64::NAN,
    }
}
/// UTF-16 `trim()`.
pub fn trim_utf16(units: &[u16]) -> &[u16] {
    let space = |u: &u16| char::from_u32(u32::from(*u)).is_some_and(is_space);
    let start = units.iter().position(|u| !space(u)).unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !space(u))
        .map_or(start, |i| i + 1);
    &units[start..end]
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn string_to_number_matches_ecmascript() {
        for (s, n) in [
            ("", 0.0),
            ("  \u{a0}", 0.0),
            ("12", 12.0),
            (" -1.5e3 ", -1500.0),
            (".5", 0.5),
            ("5.", 5.0),
            ("+Infinity", f64::INFINITY),
            ("0x1F", 31.0),
            ("0b101", 5.0),
            ("0o17", 15.0),
        ] {
            assert_eq!(number(s), n, "{s:?}");
        }
        for s in [
            "inf", "infinity", "NaN", "1_0", "-0x1", "0x", ".", "e5", "1e", "1 2", "+-1",
        ] {
            assert!(number(s).is_nan(), "{s:?}");
        }
        assert_eq!(number("0x20000000000001"), 9007199254740992.0);
        assert_eq!(number("0x20000000000003"), 9007199254740996.0);
        assert_eq!(parse_float("12px"), 12.0);
        assert_eq!(parse_float(" -.5e1x"), -5.0);
        assert_eq!(parse_float("1e"), 1.0);
        assert!(parse_float("x").is_nan());
        assert_eq!(parse_int10(" 42abc"), 42.0);
        assert!(parse_int10("abc").is_nan());
        assert_eq!(number_to_string(1e21), "1e+21");
        assert_eq!(number_to_string(-0.0), "0");
        for (value, digits, text) in [
            (1.005, 2, "1.00"),
            (1.5, 0, "2"),
            (-1.5, 0, "-2"),
            (2.5, 0, "3"),
            (0.0005, 3, "0.001"),
            (-0.0001, 3, "-0.000"),
            (-0.0, 3, "0.000"),
            (1e21, 1, "1e+21"),
            (f64::INFINITY, 1, "Infinity"),
            (f64::NAN, 3, "NaN"),
            (123.456, 1, "123.5"),
            (5e-324, 15, "0.000000000000000"),
        ] {
            assert_eq!(to_fixed(value, digits), text, "{value}.toFixed({digits})");
        }
    }
    #[test]
    fn json_stringify_matches_ecmascript() {
        let key = |k: &str| k.encode_utf16().collect::<Vec<_>>();
        let value = Value::Object(
            [
                (
                    key("b"),
                    Value::Array(vec![Value::Number(-0.0), Value::Null]),
                ),
                (key("10"), Value::Bool(true)),
                (key("2"), Value::Number(1e21)),
                (
                    key("01"),
                    Value::String(vec![0xd800, 0x22, 0x5c, 0x0a, 0x01, 0x2028]),
                ),
                (key("4294967295"), Value::Object(Default::default())),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(
            String::from_utf16(&json_stringify(&value)).unwrap(),
            "{\"2\":1e+21,\"10\":true,\"01\":\"\\ud800\\\"\\\\\\n\\u0001\u{2028}\",\"4294967295\":{},\"b\":[0,null]}"
        );
    }
}
