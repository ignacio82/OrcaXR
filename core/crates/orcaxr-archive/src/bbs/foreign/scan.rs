//! Exact equivalents of the production browser's BBS metadata expressions.
//!
//! Foreign metadata members (`model_settings.config`, layer files, project
//! settings in XML form) are small, fully buffered documents that the browser
//! reads with a handful of case-insensitive regular expressions rather than an
//! XML parser. Each function here reproduces one expression's match positions,
//! captures and global iteration, including its backtracking consequences, so
//! that native import agrees with the browser on every input rather than only
//! on well-formed files. Literal patterns are ASCII and the expressions do not
//! use the Unicode flag, so `\w`, `\b` and case folding are ASCII-only while
//! `\s` keeps its full ECMAScript meaning.
use super::js::{is_space, is_word};

/// One failure family for metadata syntax that the browser rejects by throwing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScanError {
    DuplicateAttribute,
    CodePoint,
}

fn starts_with_ci(text: &[u8], at: usize, literal: &[u8]) -> bool {
    text.len() >= at + literal.len()
        && text[at..at + literal.len()]
            .iter()
            .zip(literal)
            .all(|(a, b)| a.eq_ignore_ascii_case(b))
}
fn find_ci(text: &[u8], from: usize, literal: &[u8]) -> Option<usize> {
    (from..=text.len().checked_sub(literal.len())?).find(|&i| starts_with_ci(text, i, literal))
}
/// `<tag\b` at `at`; returns the index after the tag name.
fn tag_start(text: &str, at: usize, tag: &str) -> Option<usize> {
    let b = text.as_bytes();
    if b.get(at) != Some(&b'<') || !starts_with_ci(b, at + 1, tag.as_bytes()) {
        return None;
    }
    let after = at + 1 + tag.len();
    // `\b` between the final (word) tag character and the next character.
    match text[after..].chars().next() {
        Some(c) if is_word(c) => None,
        _ => Some(after),
    }
}
fn next_tag(text: &str, from: usize, tag: &str) -> Option<(usize, usize)> {
    let b = text.as_bytes();
    let mut i = from;
    while i < b.len() {
        let lt = i + b[i..].iter().position(|c| *c == b'<')?;
        if let Some(after) = tag_start(text, lt, tag) {
            return Some((lt, after));
        }
        i = lt + 1;
    }
    None
}
fn gt_from(text: &str, from: usize) -> Option<usize> {
    text.as_bytes()[from..]
        .iter()
        .position(|c| *c == b'>')
        .map(|n| from + n)
}

/// `[...text.matchAll(/<tag\b/gi)].length`.
pub fn count_tags(text: &str, tag: &str) -> usize {
    let mut count = 0;
    let mut pos = 0;
    while let Some((lt, _)) = next_tag(text, pos, tag) {
        count += 1;
        pos = lt + 1;
    }
    count
}
/// `/<tag\b([^>]*)>([\s\S]*?)<\/tag>/gi` — every (attributes, body) pair.
pub fn elements<'a>(text: &'a str, tag: &'a str) -> impl Iterator<Item = (&'a str, &'a str)> + 'a {
    let close = format!("</{tag}>");
    let mut pos = 0;
    std::iter::from_fn(move || {
        let (lt, after) = next_tag(text, pos, tag)?;
        let gt = gt_from(text, after)?;
        // The lazy body ends at the first closing tag. Without one, no later
        // start can match either, because its own `>` is no earlier.
        let end = find_ci(text.as_bytes(), gt + 1, close.as_bytes())?;
        let _ = lt;
        pos = end + close.len();
        Some((&text[after..gt], &text[gt + 1..end]))
    })
}
/// `/<tag\b([^>]*)\/?\s*>/gi` — captured attribute text of every opening tag.
/// The greedy class stops at the first `>`, so the capture keeps a trailing `/`.
pub fn open_tags<'a>(text: &'a str, tag: &'a str) -> impl Iterator<Item = &'a str> + 'a {
    let mut pos = 0;
    std::iter::from_fn(move || {
        let (_, after) = next_tag(text, pos, tag)?;
        let gt = gt_from(text, after)?;
        pos = gt + 1;
        Some(&text[after..gt])
    })
}
/// `/<model_instance\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/model_instance>)/gi`.
/// Returns (attributes, optional nested body) in match order.
pub fn lazy_elements<'a>(
    text: &'a str,
    tag: &'a str,
) -> impl Iterator<Item = (&'a str, Option<&'a str>)> + 'a {
    let close = format!("</{tag}>");
    let mut pos = 0;
    std::iter::from_fn(move || {
        loop {
            let (lt, after) = next_tag(text, pos, tag)?;
            let b = text.as_bytes();
            let mut q = after;
            while q < b.len() {
                if b[q] == b'/' {
                    let rest = &text[q + 1..];
                    let spaces = rest.len() - rest.trim_start_matches(is_space).len();
                    if b.get(q + 1 + spaces) == Some(&b'>') {
                        pos = q + 2 + spaces;
                        return Some((&text[after..q], None));
                    }
                }
                if b[q] == b'>' {
                    match find_ci(b, q + 1, close.as_bytes()) {
                        Some(end) => {
                            pos = end + close.len();
                            return Some((&text[after..q], Some(&text[q + 1..end])));
                        }
                        None => break,
                    }
                }
                // `[^>]*?` extends by one code point.
                q += text[q..].chars().next().map_or(1, char::len_utf8);
            }
            pos = lt + 1;
        }
    })
}

/// `parseAttributes`: `/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g`,
/// values decoded once by `decodeXml`. Duplicate names throw.
pub fn attributes(source: &str) -> Result<Vec<(String, Vec<u16>)>, ScanError> {
    let mut out: Vec<(String, Vec<u16>)> = Vec::new();
    let b = source.as_bytes();
    let mut i = 0;
    while i < b.len() {
        match attribute_at(source, i) {
            Some((name, raw, end)) => {
                if out.iter().any(|(n, _)| n == name) {
                    return Err(ScanError::DuplicateAttribute);
                }
                out.push((
                    name.to_owned(),
                    decode_xml(&raw.encode_utf16().collect::<Vec<_>>())?,
                ));
                i = end;
            }
            None => i += source[i..].chars().next().map_or(1, char::len_utf8),
        }
    }
    Ok(out)
}
fn attribute_at(source: &str, start: usize) -> Option<(&str, &str, usize)> {
    let b = source.as_bytes();
    let first = *b.get(start)?;
    if !(first.is_ascii_alphabetic() || first == b'_') {
        return None;
    }
    let mut i = start + 1;
    while b
        .get(i)
        .is_some_and(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b':' | b'.' | b'-'))
    {
        i += 1;
    }
    let name = &source[start..i];
    let skip =
        |at: usize| at + source[at..].len() - source[at..].trim_start_matches(is_space).len();
    i = skip(i);
    if b.get(i) != Some(&b'=') {
        return None;
    }
    i = skip(i + 1);
    let quote = *b.get(i)?;
    if quote != b'"' && quote != b'\'' {
        return None;
    }
    let close = i + 1 + b[i + 1..].iter().position(|c| *c == quote)?;
    Some((name, &source[i + 1..close], close + 1))
}
pub fn get<'a>(attributes: &'a [(String, Vec<u16>)], name: &str) -> Option<&'a [u16]> {
    attributes
        .iter()
        .find(|(n, _)| n == name)
        .map(|(_, v)| v.as_slice())
}

/// `decodeXml`: `/&(?:#(\d+)|#x([0-9a-f]+)|amp|lt|gt|quot|apos);/gi` over
/// UTF-16. `String.fromCodePoint` throws above U+10FFFF and admits surrogates.
pub fn decode_xml(units: &[u16]) -> Result<Vec<u16>, ScanError> {
    let mut out = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        if units[i] == u16::from(b'&')
            && let Some((decoded, len)) = entity_at(&units[i..])?
        {
            out.extend(decoded);
            i += len;
            continue;
        }
        out.push(units[i]);
        i += 1;
    }
    Ok(out)
}
fn entity_at(u: &[u16]) -> Result<Option<(Vec<u16>, usize)>, ScanError> {
    let ascii = |i: usize| u.get(i).and_then(|c| u8::try_from(*c).ok());
    if ascii(1) == Some(b'#') {
        let hex = ascii(2).is_some_and(|c| c.eq_ignore_ascii_case(&b'x'));
        // `#(\d+)` is tried before `#x(...)`; a digit after `#` excludes hex.
        let (start, radix) = if hex { (3, 16) } else { (2, 10) };
        let mut end = start;
        while ascii(end).is_some_and(|c| {
            if radix == 16 {
                c.is_ascii_hexdigit()
            } else {
                c.is_ascii_digit()
            }
        }) {
            end += 1;
        }
        if end == start || ascii(end) != Some(b';') {
            return Ok(None);
        }
        let digits: String = u[start..end].iter().map(|c| char::from(*c as u8)).collect();
        // Number(decimal) / parseInt(hex, 16) then fromCodePoint.
        let value = if radix == 10 {
            super::js::number(&digits)
        } else {
            super::js::number(&format!("0x{digits}"))
        };
        if !(0.0..=1_114_111.0).contains(&value) {
            return Err(ScanError::CodePoint);
        }
        let code = value as u32;
        let decoded = match char::from_u32(code) {
            Some(c) => {
                let mut buf = [0u16; 2];
                c.encode_utf16(&mut buf).to_vec()
            }
            None => vec![code as u16], // a lone surrogate code unit
        };
        return Ok(Some((decoded, end + 1)));
    }
    for (name, value) in [
        ("amp;", b'&'),
        ("lt;", b'<'),
        ("gt;", b'>'),
        ("quot;", b'"'),
        ("apos;", b'\''),
    ] {
        let n = name.len();
        if u.len() > n
            && u[1..=n]
                .iter()
                .zip(name.bytes())
                .all(|(a, b)| u8::try_from(*a).is_ok_and(|a| a.eq_ignore_ascii_case(&b)))
        {
            return Ok(Some((vec![u16::from(value)], n + 1)));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn s(u: &[u16]) -> String {
        String::from_utf16_lossy(u)
    }
    #[test]
    fn elements_follow_regex_semantics() {
        let text = "<objectX/><object id=\"1\">a<object id=\"2\">b</OBJECT><object>c";
        let found: Vec<_> = elements(text, "object").collect();
        assert_eq!(found, vec![(" id=\"1\"", "a<object id=\"2\">b")]);
        assert_eq!(
            open_tags("<v a='1'/><v>", "v").collect::<Vec<_>>(),
            vec![" a='1'/", ""]
        );
        let lazy: Vec<_> = lazy_elements("<m a='1'/><m b='2'><x/></m><m c='/>'>", "m").collect();
        assert_eq!(lazy[0], (" a='1'", None));
        assert_eq!(lazy[1], (" b='2'", Some("<x/>")));
        assert_eq!(lazy[2], (" c='", None));
    }
    #[test]
    fn attributes_match_global_scan() {
        let a = attributes(" 1x=\"a&amp;lt;\" y = 'b' z=\"unterminated").unwrap();
        assert_eq!(a[0].0, "x");
        assert_eq!(s(&a[0].1), "a&lt;");
        assert_eq!(a[1].0, "y");
        assert_eq!(a.len(), 2);
        assert_eq!(
            attributes("a='1' a='2'"),
            Err(ScanError::DuplicateAttribute)
        );
        assert_eq!(
            s(&decode_xml(
                &"&#X41;&#65;&AMP;&#xD800;"
                    .encode_utf16()
                    .collect::<Vec<_>>()
            )
            .unwrap()[..4]),
            "AA&\u{fffd}"
        );
        assert_eq!(
            decode_xml(&"&#99999999;".encode_utf16().collect::<Vec<_>>()),
            Err(ScanError::CodePoint)
        );
    }
}
