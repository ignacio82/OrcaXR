use crate::{Text, f, model::Location, number};

#[derive(Debug)]
pub(crate) struct Command {
    pub letter: u8,
    pub code: f64,
    pub exact_arc: bool,
    pub parameters: [Option<f64>; 26],
    pub invalid: [bool; 26],
    pub command_line: i32,
}
impl Command {
    pub fn get(&self, letter: u8) -> Option<f64> {
        self.parameters[(letter - b'A') as usize]
    }
    pub fn invalid(&self, letter: u8) -> bool {
        self.invalid[(letter - b'A') as usize]
    }
}

pub(crate) fn text(units: &[u16]) -> Text {
    Text(units.to_vec())
}

// ECMAScript TrimString, deliberately excluding Rust's extra NEL whitespace.
fn whitespace(c: u16) -> bool {
    matches!(c, 0x09..=0x0d | 0x20 | 0xa0 | 0x1680 | 0x2000..=0x200a | 0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
}
pub(crate) fn trim_end(mut s: &[u16]) -> &[u16] {
    while s.last().copied().is_some_and(whitespace) {
        s = &s[..s.len() - 1];
    }
    s
}
pub(crate) fn trim(mut s: &[u16]) -> &[u16] {
    s = trim_end(s);
    while s.first().copied().is_some_and(whitespace) {
        s = &s[1..];
    }
    s
}
pub(crate) fn prefix<'a>(s: &'a [u16], p: &str) -> Option<&'a [u16]> {
    if s.len() >= p.len() && s.iter().take(p.len()).copied().eq(p.bytes().map(u16::from)) {
        Some(&s[p.len()..])
    } else {
        None
    }
}
pub(crate) fn eq(s: &[u16], p: &str) -> bool {
    prefix(s, p).is_some_and(|rest| rest.is_empty())
}

pub(crate) fn skip_space(s: &[u16], mut position: usize, end: usize) -> usize {
    while position < end && matches!(s[position], 32 | 9) {
        position += 1;
    }
    position
}
fn upper(c: u16) -> u16 {
    if (97..=122).contains(&c) { c - 32 } else { c }
}
fn digit(c: u16) -> bool {
    (48..=57).contains(&c)
}

struct NumberScan {
    valid: bool,
    out_of_range: bool,
    value: f64,
    end: usize,
}
fn scan(s: &[u16], start: usize, end: usize) -> NumberScan {
    let mut cursor = start;
    if cursor < end && matches!(s[cursor], 43 | 45) {
        cursor += 1;
    }
    let mut digits = 0;
    while cursor < end && digit(s[cursor]) {
        cursor += 1;
        digits += 1;
    }
    if cursor < end && s[cursor] == 46 {
        cursor += 1;
        while cursor < end && digit(s[cursor]) {
            cursor += 1;
            digits += 1;
        }
    }
    if digits > 0 && cursor + 1 < end && matches!(s[cursor], 69 | 101) {
        let mut next = cursor + 1;
        if matches!(s[next], 43 | 45) {
            next += 1;
        }
        let first = next;
        while next < end && digit(s[next]) {
            next += 1;
        }
        if next > first {
            cursor = next;
        }
    }
    if digits == 0 {
        return NumberScan {
            valid: false,
            out_of_range: false,
            value: f64::NAN,
            end: start,
        };
    }
    let value = String::from_utf16(&s[start..cursor])
        .unwrap()
        .parse::<f64>()
        .unwrap_or(f64::NAN);
    NumberScan {
        valid: value.is_finite(),
        out_of_range: !value.is_finite(),
        value,
        end: cursor,
    }
}
pub(crate) fn strict_number(s: &[u16]) -> Option<f64> {
    let s = trim(s);
    let value = scan(s, 0, s.len());
    (value.valid && value.end == s.len()).then_some(value.value)
}

pub(crate) fn command(
    s: &[u16],
    source: Location,
    mut warn: impl FnMut(&'static str, Text),
) -> Option<Command> {
    let end = s
        .iter()
        .position(|c| matches!(*c, 59 | 40))
        .unwrap_or(s.len());
    let mut cursor = skip_space(s, 0, end);
    if cursor >= end {
        return None;
    }
    if source.line == 1 && s[cursor] == 0xfeff {
        cursor = skip_space(s, cursor + 1, end);
    }
    let mut command_line = -1;
    if s.get(cursor).copied().map(upper) == Some(78) {
        let value = scan(s, cursor + 1, end);
        if !value.valid
            || value.value.fract() != 0.0
            || value.value < 0.0
            || value.value > i32::MAX as f64
        {
            warn(
                "invalid-command-line-number",
                "Invalid N-word source line number".into(),
            );
            return None;
        }
        command_line = value.value as i32;
        cursor = skip_space(s, value.end, end);
    }
    let letter = s.get(cursor).copied().map(upper).unwrap_or(0);
    if !(65..=90).contains(&letter) {
        warn(
            "invalid-command",
            "Source line does not begin with a valid G-code command".into(),
        );
        return None;
    }
    let code = scan(s, cursor + 1, end);
    let letter = letter as u8;
    if !code.valid
        || code.value.fract() != 0.0
        || code.value < 0.0
        || code.value > 9_007_199_254_740_991.0
    {
        warn(
            "invalid-command",
            format!("Command {} has an invalid numeric code", letter as char).into(),
        );
        return None;
    }
    let exact_arc = letter == b'G'
        && code.end == cursor + 2
        && matches!(s[cursor + 1], 50 | 51)
        && (code.end >= end || matches!(s[code.end], 32 | 9));
    cursor = code.end;
    let mut output = Command {
        letter,
        code: code.value,
        exact_arc,
        parameters: [None; 26],
        invalid: [false; 26],
        command_line,
    };
    while cursor < end {
        cursor = skip_space(s, cursor, end);
        if cursor >= end || s[cursor] == 42 {
            break;
        }
        let parameter = upper(s[cursor]);
        if !(65..=90).contains(&parameter) {
            warn(
                "malformed-token",
                Text::surround(
                    "Unexpected token \"",
                    &text(&s[cursor..cursor + 1]),
                    &format!("\" in {}{}", letter as char, number(code.value)),
                ),
            );
            cursor += 1;
            continue;
        }
        let slot = (parameter - 65) as usize;
        let value = scan(s, cursor + 1, end);
        if !value.valid {
            if value.out_of_range {
                output.invalid[slot] = true;
                output.parameters[slot] = None;
                warn(
                    "invalid-parameter",
                    format!(
                        "Parameter {} in {}{} is outside the finite numeric domain",
                        parameter as u8 as char,
                        letter as char,
                        number(code.value)
                    )
                    .into(),
                );
                cursor = value.end;
                continue;
            }
            warn(
                "invalid-parameter",
                format!(
                    "Parameter {} in {}{} has no finite numeric value",
                    parameter as u8 as char,
                    letter as char,
                    number(code.value)
                )
                .into(),
            );
            cursor += 1;
            while cursor < end && !matches!(s[cursor], 32 | 9 | 42 | 59 | 40) {
                cursor += 1;
            }
            continue;
        }
        if output.parameters[slot].is_some() {
            warn(
                "duplicate-parameter",
                format!(
                    "Parameter {} is duplicated; the final value is used",
                    parameter as u8 as char
                )
                .into(),
            );
        }
        let converted = f(value.value);
        if !converted.is_finite() {
            output.invalid[slot] = true;
            output.parameters[slot] = None;
            warn(
                "invalid-parameter",
                format!(
                    "Parameter {} in {}{} is outside the finite Float32 domain",
                    parameter as u8 as char,
                    letter as char,
                    number(code.value)
                )
                .into(),
            );
        } else {
            output.invalid[slot] = false;
            output.parameters[slot] = Some(converted);
        }
        cursor = value.end;
    }
    Some(output)
}
