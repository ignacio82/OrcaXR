use super::{Archive, Budget, Error, check};
use std::{
    collections::BTreeMap,
    io::{self, Read, Seek, Write},
};
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Tag {
    Relationship,
    Default,
    Override,
}
#[derive(Clone, Copy)]
pub(super) enum Kind {
    Relationships,
    ContentTypes,
}
impl Kind {
    fn names(self) -> &'static [(&'static [u8], Tag)] {
        match self {
            Self::Relationships => &[(b"<Relationship", Tag::Relationship)],
            Self::ContentTypes => &[(b"<Default", Tag::Default), (b"<Override", Tag::Override)],
        }
    }
}
pub(super) type Attributes = BTreeMap<String, Vec<u16>>;
#[derive(Default)]
struct Utf8 {
    bytes: [u8; 4],
    used: usize,
    wanted: usize,
}
impl Utf8 {
    fn byte(&mut self, b: u8) -> Result<(), Error> {
        if self.used == 0 {
            if b < 128 {
                return Ok(());
            }
            self.wanted = match b {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => return Err(Error::Utf8),
            };
        }
        self.bytes[self.used] = b;
        self.used += 1;
        if self.used == self.wanted {
            std::str::from_utf8(&self.bytes[..self.used]).map_err(|_| Error::Utf8)?;
            self.used = 0;
        }
        Ok(())
    }
}
struct Scanner<'a, F> {
    kind: Kind,
    name: Vec<u8>,
    active: Option<Tag>,
    body: Vec<u8>,
    markup_bytes: usize,
    utf8: Utf8,
    budget: &'a mut Budget,
    visit: F,
    failure: Option<Error>,
}
impl<F: FnMut(Tag, Attributes, &mut Budget) -> Result<(), Error>> Scanner<'_, F> {
    fn byte(&mut self, b: u8) -> Result<(), Error> {
        self.utf8.byte(b)?;
        if let Some(tag) = self.active {
            self.markup_bytes += 1;
            if self.markup_bytes > self.budget.limits.tag_bytes {
                return Err(Error::ResourceLimit);
            }
            if b == b'>' {
                self.budget.record()?;
                let body = std::mem::take(&mut self.body);
                let attrs = attributes(
                    std::str::from_utf8(&body).map_err(|_| Error::Utf8)?,
                    self.budget,
                )?;
                (self.visit)(tag, attrs, self.budget)?;
                self.active = None;
                self.name.clear();
            } else {
                self.body.push(b);
            }
            return Ok(());
        }
        if let Some((_, tag)) = self
            .kind
            .names()
            .iter()
            .find(|(name, _)| name.eq_ignore_ascii_case(&self.name))
            && !b.is_ascii_alphanumeric()
            && b != b'_'
        {
            self.active = Some(*tag);
            self.markup_bytes = self.name.len();
            // This byte belongs to the attributes or closes an empty tag.
            self.markup_bytes += 1;
            if self.markup_bytes > self.budget.limits.tag_bytes {
                return Err(Error::ResourceLimit);
            }
            if b == b'>' {
                self.budget.record()?;
                (self.visit)(*tag, BTreeMap::new(), self.budget)?;
                self.active = None;
                self.name.clear();
            } else {
                self.body.push(b);
            }
            return Ok(());
        }
        if b == b'<' {
            self.name.clear();
            self.name.push(b);
        } else if !self.name.is_empty() {
            self.name.push(b);
            if !self.kind.names().iter().any(|(name, _)| {
                name.len() >= self.name.len()
                    && name[..self.name.len()].eq_ignore_ascii_case(&self.name)
            }) {
                self.name.clear();
            }
        }
        Ok(())
    }
}
impl<F: FnMut(Tag, Attributes, &mut Budget) -> Result<(), Error>> Write for Scanner<'_, F> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        if self.failure.is_some() {
            return Err(io::ErrorKind::InvalidData.into());
        }
        for &byte in b {
            if let Err(e) = self.byte(byte) {
                self.failure = Some(e);
                return Err(io::ErrorKind::InvalidData.into());
            }
        }
        Ok(b.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(super) fn read<R: Read + Seek>(
    archive: &mut Archive<R>,
    index: usize,
    kind: Kind,
    budget: &mut Budget,
    cancelled: &mut impl FnMut() -> bool,
    visit: impl FnMut(Tag, Attributes, &mut Budget) -> Result<(), Error>,
) -> Result<(), Error> {
    check(cancelled)?;
    if archive.entries()[index].bytes() > budget.limits.part_bytes {
        return Err(Error::ResourceLimit);
    }
    let mut scanner = Scanner {
        kind,
        name: Vec::new(),
        active: None,
        body: Vec::new(),
        markup_bytes: 0,
        utf8: Utf8::default(),
        budget,
        visit,
        failure: None,
    };
    let result = archive.read_entry(index, &mut scanner, cancelled);
    if let Some(e) = scanner.failure {
        return Err(e);
    }
    result.map_err(Error::Archive)?;
    if scanner.utf8.used != 0 {
        return Err(Error::Utf8);
    }
    Ok(())
}
fn space(c: char) -> bool {
    matches!(c as u32,9..=13|32|0xa0|0x1680|0x2000..=0x200a|0x2028|0x2029|0x202f|0x205f|0x3000|0xfeff)
}
fn skip_space(s: &str, mut i: usize) -> usize {
    while let Some(c) = s[i..].chars().next() {
        if !space(c) {
            break;
        }
        i += c.len_utf8();
    }
    i
}
fn attributes(s: &str, budget: &mut Budget) -> Result<Attributes, Error> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut result = BTreeMap::new();
    while i < b.len() {
        if !b[i].is_ascii_alphabetic() && b[i] != b'_' {
            i += s[i..].chars().next().unwrap().len_utf8();
            continue;
        }
        let start = i;
        i += 1;
        while i < b.len() && (b[i].is_ascii_alphanumeric() || b"_:.-".contains(&b[i])) {
            i += 1;
        }
        let end = i;
        let mut at = skip_space(s, i);
        if b.get(at) != Some(&b'=') {
            continue;
        }
        at = skip_space(s, at + 1);
        let Some(&quote) = b.get(at).filter(|&&c| c == b'\'' || c == b'"') else {
            continue;
        };
        let from = at + 1;
        let Some(n) = b[from..].iter().position(|&c| c == quote) else {
            continue;
        };
        let to = from + n;
        let name = &s[start..end];
        if result.contains_key(name) {
            return Err(Error::DuplicateAttribute);
        }
        budget.text(name.len())?;
        let value = entities(&s[from..to], budget)?;
        result.insert(name.to_owned(), value);
        i = to + 1;
    }
    Ok(result)
}
fn entities(s: &str, budget: &mut Budget) -> Result<Vec<u16>, Error> {
    let b = s.as_bytes();
    let mut i = 0;
    let mut result = Vec::new();
    while i < b.len() {
        let mut decoded = None;
        if b[i] == b'&' {
            for (name, c) in [
                (b"amp;".as_slice(), '&'),
                (b"lt;", '<'),
                (b"gt;", '>'),
                (b"quot;", '"'),
                (b"apos;", '\''),
            ] {
                if b.get(i + 1..i + 1 + name.len())
                    .is_some_and(|v| v.eq_ignore_ascii_case(name))
                {
                    decoded = Some((c, name.len() + 1));
                    break;
                }
            }
            if b.get(i + 1) == Some(&b'#') {
                let hex = b.get(i + 2).is_some_and(|&v| v == b'x' || v == b'X');
                let from = i + if hex { 3 } else { 2 };
                let radix = if hex { 16 } else { 10 };
                let mut end = from;
                let mut value = Some(0u32);
                while end < b.len() {
                    let digit = (b[end] as char).to_digit(radix);
                    let Some(d) = digit else {
                        break;
                    };
                    value = value.and_then(|v| v.checked_mul(radix)?.checked_add(d));
                    end += 1;
                }
                if end > from && b.get(end) == Some(&b';') {
                    let c = value
                        .and_then(char::from_u32)
                        .ok_or(Error::CharacterReference)?;
                    decoded = Some((c, end - i + 1));
                }
            }
        }
        let (c, n) = decoded.unwrap_or_else(|| {
            let c = s[i..].chars().next().unwrap();
            (c, c.len_utf8())
        });
        budget.text(c.len_utf16())?;
        result.extend_from_slice(c.encode_utf16(&mut [0; 2]));
        i += n;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn limits() -> super::super::Limits {
        super::super::Limits {
            part_bytes: 1 << 20,
            tag_bytes: 1 << 20,
            records: 4096,
            text_units: 1 << 20,
            output_bytes: 1 << 20,
        }
    }
    fn decode(bytes: &[u8], step: usize) -> Result<Vec<(Tag, Attributes)>, Error> {
        let mut budget = Budget::new(limits())?;
        let mut rows = Vec::new();
        let mut scanner = Scanner {
            kind: Kind::Relationships,
            name: Vec::new(),
            active: None,
            body: Vec::new(),
            markup_bytes: 0,
            utf8: Utf8::default(),
            budget: &mut budget,
            visit: |tag, attrs, _: &mut Budget| {
                rows.push((tag, attrs));
                Ok(())
            },
            failure: None,
        };
        for chunk in bytes.chunks(step) {
            if scanner.write_all(chunk).is_err() {
                return Err(scanner.failure.unwrap());
            }
        }
        if scanner.utf8.used != 0 {
            return Err(Error::Utf8);
        }
        Ok(rows)
    }
    #[test]
    fn byte_splits_and_hostile_partial_tokens_stay_bounded() {
        let input =
            "\u{feff}ignored<Relationship\u{a0}Id=\"🐳&AMP;&#x00041;\" Type='t' Target='/a'/>";
        let expected = decode(input.as_bytes(), input.len()).unwrap();
        assert_eq!(expected.len(), 1);
        assert_eq!(
            expected[0].1["Id"],
            "🐳&A".encode_utf16().collect::<Vec<_>>()
        );
        for step in 1..=input.len() {
            assert_eq!(decode(input.as_bytes(), step).unwrap(), expected);
        }
        for end in 0..input.len() {
            let result = decode(&input.as_bytes()[..end], 1);
            if std::str::from_utf8(&input.as_bytes()[..end]).is_err() {
                assert_eq!(result.err(), Some(Error::Utf8));
            } else {
                assert!(result.unwrap().is_empty());
            }
        }
        let mut huge = String::from("<Relationship ");
        huge.push_str(&"a".repeat(100_000));
        huge.push_str(" Id='x' Type='t' Target='/a'/>");
        assert_eq!(decode(huge.as_bytes(), 257).unwrap().len(), 1);
        // Every single-byte mutation is private, bounded and panic-free. This is
        // hostility coverage, not a claim that every malformed tag is XML-rejected.
        for i in 0..input.len() {
            for byte in [0, 0x7f, 0x80, 0xc0, 0xf5, b'<', b'>', b'&', b'"'] {
                let mut b = input.as_bytes().to_vec();
                b[i] = byte;
                let _ = decode(&b, 3);
            }
        }
    }
}
