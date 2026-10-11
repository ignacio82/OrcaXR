//! UTF-16 text as the browser's filament modules build and test it: literals,
//! concatenation, `String(number)`, `toFixed`, and the three colour spellings
//! they accept — strict `#RRGGBB`, the Match field's trimmed and upper-cased
//! hex, and the canonical adapter's `#RRGGBB[AA]` in either case.
use crate::js_math::convert::{number_to_string, to_fixed, trim_utf16};

/// UTF-16 units of `text`.
pub(crate) fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
/// The parts, one after another.
pub(crate) fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
/// `String(n)`.
pub(crate) fn num(n: f64) -> Vec<u16> {
    u(&number_to_string(n))
}
/// `n.toFixed(digits)`.
pub(crate) fn fixed(n: f64, digits: u32) -> Vec<u16> {
    u(&to_fixed(n, digits))
}

fn hex_digit(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x46 | 0x61..=0x66)
}
fn upper(unit: u16) -> u16 {
    if (0x61..=0x7a).contains(&unit) {
        unit - 0x20
    } else {
        unit
    }
}

/// `/^#[0-9a-fA-F]{6}$/`.
pub(crate) fn is_hex_color(value: &[u16]) -> bool {
    value.len() == 7
        && value[0] == u16::from(b'#')
        && value[1..].iter().all(|&unit| hex_digit(unit))
}

/// `/^#[0-9A-F]{6}$/` after `value.trim().toUpperCase()` and a `#` added to
/// what lacks one (`normalizeColorMatchHex`, `normalizeStrictColor`): the
/// normalized colour, or none. Upper-casing reaches that alphabet only from
/// ASCII `a`–`f` and U+FB00 (`ﬀ`, which becomes `FF`).
pub(crate) fn match_hex(value: &[u16]) -> Option<Vec<u16>> {
    let mut upper_units = Vec::with_capacity(8);
    for &unit in trim_utf16(value) {
        match unit {
            0x23 | 0x30..=0x39 | 0x41..=0x46 => upper_units.push(unit),
            0x61..=0x66 => upper_units.push(unit - 0x20),
            0xfb00 => upper_units.extend_from_slice(&[0x46, 0x46]),
            _ => return None,
        }
        if upper_units.len() > 7 {
            return None;
        }
    }
    if upper_units.first() != Some(&u16::from(b'#')) {
        upper_units.insert(0, u16::from(b'#'));
    }
    (upper_units.len() == 7 && upper_units[1..].iter().all(|&unit| unit != u16::from(b'#')))
        .then_some(upper_units)
}

/// `/^#?([0-9a-f]{6})(?:[0-9a-f]{2})?$/i` over `value.trim()`: `#` and the
/// six digits in upper case (the adapter's `normalizeSixDigitColor`, the
/// recipe's `normalizeDisplayColor`), or none.
pub(crate) fn six_digit(value: &[u16]) -> Option<Vec<u16>> {
    let trimmed = trim_utf16(value);
    let digits = trimmed.strip_prefix(&[u16::from(b'#')]).unwrap_or(trimmed);
    if (digits.len() != 6 && digits.len() != 8) || !digits.iter().all(|&unit| hex_digit(unit)) {
        return None;
    }
    let mut out = vec![u16::from(b'#')];
    out.extend(digits[..6].iter().map(|&unit| upper(unit)));
    Some(out)
}

/// `value.toUpperCase()` of a strict `#RRGGBB`.
pub(crate) fn upper_hex(value: &[u16]) -> Vec<u16> {
    value.iter().map(|&unit| upper(unit)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn colours_are_spelled_as_the_browser_spells_them() {
        assert_eq!(match_hex(&u(" ﬀ00aa ")), Some(u("#FF00AA")));
        assert_eq!(match_hex(&u("#abcdef")), Some(u("#ABCDEF")));
        assert_eq!(match_hex(&u("")), None);
        assert_eq!(match_hex(&u("#")), None);
        assert_eq!(match_hex(&u("##12345")), None);
        assert_eq!(match_hex(&u("1234567")), None);
        assert_eq!(six_digit(&u(" #c0c0c0aa ")), Some(u("#C0C0C0")));
        assert_eq!(six_digit(&u("c0c0c0")), Some(u("#C0C0C0")));
        assert_eq!(six_digit(&u("#c0c0c0a")), None);
        assert_eq!(six_digit(&u("ﬀ0000")), None);
        assert!(is_hex_color(&u("#aB0123")) && !is_hex_color(&u("#aB012")));
    }
}
