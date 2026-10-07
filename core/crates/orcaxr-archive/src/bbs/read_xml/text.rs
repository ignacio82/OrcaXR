use super::Failure;
#[derive(Default)]
pub(super) struct Utf8 {
    bytes: [u8; 4],
    used: usize,
    wanted: usize,
}
impl Utf8 {
    pub fn byte(&mut self, b: u8) -> Result<Option<char>, Failure> {
        if self.used == 0 {
            if b < 128 {
                return Ok(Some(b as char));
            }
            self.wanted = match b {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => return Err(Failure::Utf8),
            };
        }
        self.bytes[self.used] = b;
        self.used += 1;
        if self.used == self.wanted {
            let c = std::str::from_utf8(&self.bytes[..self.used])
                .map_err(|_| Failure::Utf8)?
                .chars()
                .next()
                .unwrap();
            self.used = 0;
            Ok(Some(c))
        } else {
            Ok(None)
        }
    }
    pub fn finish(&self) -> Result<(), Failure> {
        if self.used == 0 {
            Ok(())
        } else {
            Err(Failure::Utf8)
        }
    }
}
/// Match the browser's prohibited declaration scan even inside ignored constructs.
#[derive(Default)]
pub(super) struct Dtd {
    tail: [u8; 9],
    pending: bool,
}
impl Dtd {
    pub fn byte(&mut self, b: u8) -> Result<(), Failure> {
        if self.pending && !b.is_ascii_alphanumeric() && b != b'_' {
            return Err(Failure::Syntax);
        }
        self.tail.copy_within(1.., 0);
        self.tail[8] = b.to_ascii_lowercase();
        self.pending = self.tail == *b"<!doctype" || self.tail[1..] == *b"<!entity";
        Ok(())
    }
    pub fn finish(&self) -> Result<(), Failure> {
        if self.pending {
            Err(Failure::Syntax)
        } else {
            Ok(())
        }
    }
}
pub(super) fn xml_character(c: u32) -> bool {
    matches!(c,9|10|13|0x20..=0xd7ff|0xe000..=0xfffd|0x10000..=0x10ffff)
}
pub(super) fn whitespace(c: char) -> bool {
    matches!(c as u32,0x09..=0x0d|0x20|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
pub(super) fn entity(raw: &str) -> Result<char, Failure> {
    let body = raw
        .strip_prefix('&')
        .and_then(|s| s.strip_suffix(';'))
        .ok_or(Failure::Syntax)?;
    if let Some(digits) = body.strip_prefix('#') {
        let (radix, digits) = if digits.starts_with(['x', 'X']) {
            (16, &digits[1..])
        } else {
            (10, digits)
        };
        if digits.is_empty() {
            return Err(Failure::Syntax);
        }
        let mut value = 0u32;
        for b in digits.bytes() {
            let digit = (b as char).to_digit(radix).ok_or(Failure::Syntax)?;
            value = value
                .checked_mul(radix)
                .and_then(|v| v.checked_add(digit))
                .filter(|v| *v <= 0x10ffff)
                .ok_or(Failure::XmlCharacter)?;
        }
        if !xml_character(value) {
            return Err(Failure::XmlCharacter);
        }
        return char::from_u32(value).ok_or(Failure::XmlCharacter);
    }
    for (name, c) in [
        ("amp", '&'),
        ("lt", '<'),
        ("gt", '>'),
        ("quot", '"'),
        ("apos", '\''),
    ] {
        if body.eq_ignore_ascii_case(name) {
            return Ok(c);
        }
    }
    Err(Failure::Syntax)
}
pub(super) fn decode(raw: &str, limit: usize) -> Result<Option<String>, Failure> {
    if !raw.contains('&') {
        return Ok(None);
    }
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest.find(';').ok_or(Failure::Syntax)? + 1;
        if end > limit {
            return Err(Failure::ResourceLimit);
        }
        out.push(entity(&rest[..end])?);
        rest = &rest[end..];
    }
    out.push_str(rest);
    Ok(Some(out))
}
