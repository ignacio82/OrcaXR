//! ECMAScript text semantics the browser decoders rely on: `TextDecoder`,
//! `split(/\r?\n/)`, `split(/\s+/)`, `trim`, `toLowerCase`, UTF-16 slicing and
//! number formatting. Decoded file text is well-formed, so line work stays on
//! `str`; names and messages are UTF-16 because entities and slicing can leave
//! lone surrogates.
use super::Limits;
pub(crate) use crate::bbs::foreign::js::{
    is_space, number, number_to_string, parse_int10, trim, trim_utf16,
};

/// `new TextDecoder('utf-8', { fatal: false }).decode(bytes)`: one leading BOM
/// is consumed and every maximal invalid subsequence becomes U+FFFD.
pub(crate) fn decode_utf8(bytes: &[u8]) -> String {
    let bytes = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(bytes);
    String::from_utf8_lossy(bytes).into_owned()
}

pub(crate) fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// `text.split(/\r?\n/)`: a carriage return belongs to the separator only
/// when a line feed follows it.
pub(crate) fn lines(text: &str) -> impl Iterator<Item = &str> {
    let mut pieces = text.split('\n').peekable();
    std::iter::from_fn(move || {
        let piece = pieces.next()?;
        Some(if pieces.peek().is_some() {
            piece.strip_suffix('\r').unwrap_or(piece)
        } else {
            piece
        })
    })
}

/// `text.split(/\s+/).filter(Boolean)`.
pub(crate) fn words(text: &str) -> impl Iterator<Item = &str> {
    text.split(is_space).filter(|w| !w.is_empty())
}

pub(crate) fn is_space_unit(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_space)
}

/// ECMAScript `toLowerCase` (pinned Unicode casing, Final_Sigma).
pub(crate) fn lower(units: &[u16]) -> Vec<u16> {
    orcaxr_project::js_math::case::lower(units)
}

/// `text.toLowerCase().startsWith(keyword)` for ASCII keywords without `i` or
/// `k`: only ASCII letters lowercase onto such a prefix.
pub(crate) fn ascii_lower_starts(text: &str, keyword: &str) -> bool {
    text.as_bytes()
        .get(..keyword.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(keyword.as_bytes()))
}

/// Control characters never reach canonical names (`stripControlCharacters`).
pub(crate) fn strip_controls(units: &[u16]) -> Vec<u16> {
    units
        .iter()
        .map(|&u| if u < 0x20 || u == 0x7f { 0x20 } else { u })
        .collect()
}

/// `boundedName`: the fallback is returned untouched.
pub(crate) fn bounded_name(value: Option<&[u16]>, fallback: Vec<u16>, limits: &Limits) -> Vec<u16> {
    let stripped = strip_controls(value.unwrap_or(&[]));
    let trimmed = trim_utf16(&stripped);
    if trimmed.is_empty() {
        return fallback;
    }
    trimmed[..trimmed.len().min(limits.max_name_length)].to_vec()
}

/// `filename.split(/[\\/]/).pop()`.
pub(crate) fn last_segment(filename: &[u16]) -> &[u16] {
    filename
        .rsplit(|&u| u == u16::from(b'/') || u == u16::from(b'\\'))
        .next()
        .unwrap_or(filename)
}

/// `defaultObjectName`: the file stem, or "Imported model".
pub(crate) fn default_object_name(filename: &[u16]) -> Vec<u16> {
    let base = trim_utf16(last_segment(filename));
    let stem = match base.iter().rposition(|&u| u == u16::from(b'.')) {
        Some(dot) if dot > 0 => &base[..dot],
        _ => base,
    };
    if stem.is_empty() {
        units("Imported model")
    } else {
        stem.to_vec()
    }
}

/// `fileExtension`: lower-case extension without the dot, or empty.
pub(crate) fn file_extension(filename: &[u16]) -> Vec<u16> {
    let base = last_segment(filename);
    match base.iter().rposition(|&u| u == u16::from(b'.')) {
        Some(dot) if dot > 0 && dot + 1 < base.len() => lower(&base[dot + 1..]),
        _ => Vec::new(),
    }
}

/// A UTF-16 message under construction.
#[derive(Default)]
pub(crate) struct Message(pub Vec<u16>);
impl Message {
    pub fn new(text: &str) -> Self {
        Self(units(text))
    }
    pub fn s(mut self, text: &str) -> Self {
        self.0.extend(text.encode_utf16());
        self
    }
    pub fn u(mut self, text: &[u16]) -> Self {
        self.0.extend_from_slice(text);
        self
    }
    pub fn n(self, value: f64) -> Self {
        self.s(&number_to_string(value))
    }
    pub fn done(self) -> Vec<u16> {
        self.0
    }
}

/// `Math.round` then clamp to a byte, as two lower-case hex digits.
pub(crate) fn hex_channel(value: f64) -> String {
    let scaled = if value <= 1.0 { value * 255.0 } else { value };
    let floor = scaled.floor();
    let rounded = if scaled - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    };
    format!("{:02x}", rounded.clamp(0.0, 255.0) as u8)
}
