//! ECMAScript conversions used by the production browser BBS importer.
//!
//! The browser reads foreign metadata through `Number`, `parseInt`,
//! `parseFloat`, `String` and `trim`. Rust's own parsers accept different
//! spellings (`inf`, `nan`, `_`) and its whitespace classes differ, so every
//! metadata reader uses these helpers instead of `str::parse`/`str::trim`.
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
    }
}
