//! The browser's minimal bounded XML scanner for mesh containers, over UTF-16
//! exactly as `scanXml` sees its string: no DTD or entity expansion, a depth
//! cap, and fail-closed malformed constructs. Element and attribute names are
//! ASCII by construction; text and attribute values keep lone surrogates.
use super::{Format, Malformed, Result, malformed, text::is_space_unit};
use std::collections::HashMap;

pub(crate) struct Element {
    pub local: String,
    pub attributes: HashMap<String, Vec<u16>>,
    pub self_closing: bool,
}
pub(crate) trait Handler {
    fn open(&mut self, element: &Element) -> Result<()>;
    fn close(&mut self, local: &str) -> Result<()>;
    fn text(&mut self, text: &[u16], parent: &str) -> Result<()>;
}

fn find(text: &[u16], needle: &str, from: usize) -> Option<usize> {
    let needle: Vec<u16> = needle.encode_utf16().collect();
    (from..=text.len().checked_sub(needle.len())?).find(|&i| text[i..].starts_with(&needle))
}
fn starts(text: &[u16], at: usize, prefix: &str) -> bool {
    let mut units = text[at..].iter();
    prefix.encode_utf16().all(|p| units.next() == Some(&p))
}
fn blank(text: &[u16]) -> bool {
    text.iter().all(|&u| is_space_unit(u))
}
fn valid_name(name: &[u16]) -> bool {
    let ok = |u: u16, first: bool| {
        u < 0x80 && {
            let c = u as u8;
            c.is_ascii_alphabetic()
                || c == b'_'
                || (!first && (c.is_ascii_digit() || matches!(c, b'.' | b':' | b'-')))
        }
    };
    !name.is_empty() && ok(name[0], true) && name[1..].iter().all(|&u| ok(u, false))
}
fn ascii(name: &[u16]) -> String {
    name.iter().map(|&u| u as u8 as char).collect()
}
fn local_name(name: &str) -> String {
    name.split_once(':')
        .map_or(name, |(_, local)| local)
        .to_ascii_lowercase()
}

pub(crate) fn scan(
    text: &[u16],
    max_depth: usize,
    format: Format,
    handler: &mut impl Handler,
) -> Result<()> {
    let syntax = || malformed(Malformed::InvalidSyntax, format);
    let mut stack: Vec<String> = Vec::new();
    let mut cursor = 0;
    let mut roots = 0;
    while cursor < text.len() {
        let Some(open) = text[cursor..]
            .iter()
            .position(|&u| u == u16::from(b'<'))
            .map(|i| cursor + i)
        else {
            if !blank(&text[cursor..]) && !stack.is_empty() {
                return Err(syntax());
            }
            break;
        };
        if open > cursor {
            let raw = &text[cursor..open];
            if stack.is_empty() {
                if !blank(raw) {
                    return Err(syntax());
                }
            } else if !blank(raw) {
                handler.text(
                    &decode_text(raw, format)?,
                    stack.last().expect("open element"),
                )?;
            }
        }
        if starts(text, open, "<?") {
            cursor = find(text, "?>", open + 2).ok_or_else(syntax)? + 2;
            continue;
        }
        if starts(text, open, "<!--") {
            cursor = find(text, "-->", open + 4).ok_or_else(syntax)? + 3;
            continue;
        }
        if starts(text, open, "<![CDATA[") {
            let end = find(text, "]]>", open + 9).ok_or_else(syntax)?;
            let raw = &text[open + 9..end];
            if let Some(parent) = stack.last()
                && !blank(raw)
            {
                handler.text(raw, parent)?;
            }
            cursor = end + 3;
            continue;
        }
        if starts(text, open, "<!") {
            return Err(syntax());
        }
        let end = tag_end(text, open + 1).ok_or_else(syntax)?;
        let source = &text[open + 1..end];
        if source.first() == Some(&u16::from(b'/')) {
            let name = crate::models::text::trim_utf16(&source[1..]);
            let current = stack.pop().ok_or_else(syntax)?;
            // Closing names are not validated; `toLowerCase` can map a
            // non-ASCII spelling (U+212A KELVIN SIGN) onto an open ASCII name.
            let local = name
                .iter()
                .position(|&u| u == u16::from(b':'))
                .map_or(name, |colon| &name[colon + 1..]);
            if !current.encode_utf16().eq(crate::models::text::lower(local)) {
                return Err(syntax());
            }
            handler.close(&current)?;
            cursor = end + 1;
            continue;
        }
        let element = opening_tag(source, format)?;
        if stack.is_empty() {
            roots += 1;
            if roots > 1 {
                return Err(syntax());
            }
        }
        if !element.self_closing {
            if stack.len() + 1 > max_depth {
                return Err(malformed(Malformed::LimitExceeded, format));
            }
            stack.push(element.local.clone());
        }
        handler.open(&element)?;
        if element.self_closing {
            handler.close(&element.local)?;
        }
        cursor = end + 1;
    }
    if !stack.is_empty() || roots != 1 {
        return Err(syntax());
    }
    Ok(())
}

fn tag_end(text: &[u16], start: usize) -> Option<usize> {
    let mut quote = None;
    for (i, &u) in text.iter().enumerate().skip(start) {
        match quote {
            Some(q) if u == q => quote = None,
            Some(_) => {}
            None if u == u16::from(b'"') || u == u16::from(b'\'') => quote = Some(u),
            None if u == u16::from(b'>') => return Some(i),
            None => {}
        }
    }
    None
}

fn opening_tag(source: &[u16], format: Format) -> Result<Element> {
    let syntax = || malformed(Malformed::InvalidSyntax, format);
    let mut cursor = 0;
    let skip = |cursor: &mut usize| {
        while *cursor < source.len() && is_space_unit(source[*cursor]) {
            *cursor += 1;
        }
    };
    skip(&mut cursor);
    let start = cursor;
    while cursor < source.len()
        && !is_space_unit(source[cursor])
        && source[cursor] != u16::from(b'/')
    {
        cursor += 1;
    }
    let name = &source[start..cursor];
    if !valid_name(name) {
        return Err(syntax());
    }
    let mut attributes = HashMap::new();
    let mut self_closing = false;
    while cursor < source.len() {
        skip(&mut cursor);
        if cursor >= source.len() {
            break;
        }
        if source[cursor] == u16::from(b'/') {
            cursor += 1;
            skip(&mut cursor);
            if cursor != source.len() {
                return Err(syntax());
            }
            self_closing = true;
            break;
        }
        let start = cursor;
        while cursor < source.len()
            && !is_space_unit(source[cursor])
            && source[cursor] != u16::from(b'=')
        {
            cursor += 1;
        }
        let attribute = &source[start..cursor];
        if !valid_name(attribute) {
            return Err(syntax());
        }
        let attribute = ascii(attribute);
        // The browser checks the raw name against stored local names.
        if attributes.contains_key(&attribute) {
            return Err(syntax());
        }
        skip(&mut cursor);
        if source.get(cursor) != Some(&u16::from(b'=')) {
            return Err(syntax());
        }
        cursor += 1;
        skip(&mut cursor);
        let quote = source
            .get(cursor)
            .copied()
            .filter(|&q| q == u16::from(b'"') || q == u16::from(b'\''));
        let quote = quote.ok_or_else(syntax)?;
        let value_end = source[cursor + 1..]
            .iter()
            .position(|&u| u == quote)
            .map(|i| cursor + 1 + i)
            .ok_or_else(syntax)?;
        attributes.insert(
            local_name(&attribute),
            decode_text(&source[cursor + 1..value_end], format)?,
        );
        cursor = value_end + 1;
    }
    Ok(Element {
        local: local_name(&ascii(name)),
        attributes,
        self_closing,
    })
}

/// `decodeXmlText`: replaces `&(#x?[0-9a-fA-F]+|[a-zA-Z]+);?` matches; any other
/// ampersand stays literal.
pub(crate) fn decode_text(value: &[u16], format: Format) -> Result<Vec<u16>> {
    let amp = u16::from(b'&');
    if !value.contains(&amp) {
        return Ok(value.to_vec());
    }
    let syntax = || malformed(Malformed::InvalidSyntax, format);
    let is = |u: u16, f: fn(&u8) -> bool| u < 0x80 && f(&(u as u8));
    let run =
        |from: usize, f: fn(&u8) -> bool| value[from..].iter().take_while(|&&u| is(u, f)).count();
    let mut out = Vec::with_capacity(value.len());
    let mut i = 0;
    while i < value.len() {
        if value[i] != amp {
            out.push(value[i]);
            i += 1;
            continue;
        }
        let body_start = i + 1;
        // `#x?hex+`: the optional x backtracks when no hex digit follows it.
        let body_end = if value.get(body_start) == Some(&u16::from(b'#')) {
            let after_x = body_start + 2;
            let x = value.get(body_start + 1) == Some(&u16::from(b'x'));
            let with_x = if x {
                run(after_x, u8::is_ascii_hexdigit)
            } else {
                0
            };
            if with_x > 0 {
                Some(after_x + with_x)
            } else {
                let plain = run(body_start + 1, u8::is_ascii_hexdigit);
                (plain > 0).then_some(body_start + 1 + plain)
            }
        } else {
            let letters = run(body_start, u8::is_ascii_alphabetic);
            (letters > 0).then_some(body_start + letters)
        };
        let Some(body_end) = body_end else {
            out.push(amp);
            i += 1;
            continue;
        };
        if value.get(body_end) != Some(&u16::from(b';')) {
            return Err(syntax());
        }
        let body: String = value[body_start..body_end]
            .iter()
            .map(|&u| u as u8 as char)
            .collect();
        if let Some(number) = body.strip_prefix('#') {
            let point = match number.strip_prefix('x') {
                Some(hex) => parse_prefix(hex, 16),
                None => parse_prefix(number, 10),
            };
            let point = point
                .filter(|&p| (1..=0x10ffff).contains(&p))
                .ok_or_else(syntax)?;
            if point > 0xffff {
                let n = point - 0x10000;
                out.extend_from_slice(&[
                    (0xd800 + (n >> 10)) as u16,
                    (0xdc00 + (n & 0x3ff)) as u16,
                ]);
            } else {
                out.push(point as u16);
            }
        } else {
            let replacement = match body.as_str() {
                "amp" => '&',
                "lt" => '<',
                "gt" => '>',
                "quot" => '"',
                "apos" => '\'',
                _ => return Err(syntax()),
            };
            out.push(replacement as u16);
        }
        i = body_end + 1;
    }
    Ok(out)
}

/// `Number.parseInt` over a leading run of radix digits, saturating far above
/// the code point range (any such value is refused).
fn parse_prefix(digits: &str, radix: u32) -> Option<u32> {
    let mut value: u64 = 0;
    let mut any = false;
    for c in digits.chars() {
        let Some(d) = c.to_digit(radix) else { break };
        any = true;
        value = (value * u64::from(radix) + u64::from(d)).min(u64::from(u32::MAX));
    }
    any.then_some(value.min(u64::from(u32::MAX)) as u32)
}
