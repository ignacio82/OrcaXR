//! `mixed_filament_definitions` import, matching the browser's defensive
//! FullSpectrum reader (`fullSpectrumImport.ts`) row for row. Invalid rows are
//! reported and skipped; the raw project setting stays in configuration.
use super::Failure;
use super::js;
use super::metadata::utf16;
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeSet;

pub struct Physical<'a> {
    pub id: &'a [u16],
    pub color: &'a [u16],
}
pub struct Material<'a> {
    pub name: &'a [u16],
    pub color: &'a [u16],
}
#[derive(Clone, Debug, PartialEq)]
pub struct Issue {
    pub row_index: usize,
    pub error: bool,
    pub message: Vec<u16>,
}
pub struct Imported {
    /// Canonical `MixedFilament` JSON in row order.
    pub filaments: Vec<Value>,
    pub enabled: Vec<bool>,
    pub issues: Vec<Issue>,
}

struct Row {
    a: usize,
    b: usize,
    enabled: bool,
    custom: bool,
    origin_auto: bool,
    mix_b: f64,
    gradient_tools: Vec<usize>,
    /// `Err` is the browser's escaping RangeError for an unsafe weight.
    gradient_weights: Result<Vec<f64>, ()>,
    manual_pattern: Vec<u16>,
    distribution_mode: f64,
    local_z: f64,
    offset_a: f64,
    offset_b: f64,
    deleted: bool,
    stable_id: String,
    ui_mode: f64,
    gradient_enabled: bool,
    gradient_start: f64,
    gradient_end: f64,
}

fn eq(units: &[u16], s: &str) -> bool {
    units.iter().copied().eq(s.encode_utf16())
}
fn split(units: &[u16], sep: u8) -> Vec<&[u16]> {
    units.split(|u| *u == u16::from(sep)).collect()
}
fn lossy(units: &[u16]) -> Option<String> {
    String::from_utf16(units).ok()
}
/// `strictInteger`: `/^[+-]?[0-9]+$/` on the trimmed text, then safe integer.
fn strict_integer(units: &[u16]) -> Option<f64> {
    let text = lossy(js::trim_utf16(units))?;
    let digits = text.strip_prefix(['+', '-']).unwrap_or(&text);
    if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let n = js::number(&text);
    js::is_safe_integer(n).then_some(n)
}
fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    // Math.max(lo, Math.min(hi, v)); NaN propagates.
    if v.is_nan() { v } else { lo.max(hi.min(v)) }
}
fn num(n: f64) -> String {
    js::number_to_string(n)
}

/// Parse one row; `None` after reporting an error issue.
fn parse_row(
    source: &[u16],
    physical: usize,
    issue: &mut impl FnMut(bool, Vec<u16>),
) -> Option<Row> {
    let tokens: Vec<&[u16]> = split(source, b',')
        .into_iter()
        .map(js::trim_utf16)
        .collect();
    if tokens.len() < 4 {
        issue(
            true,
            utf16("Mixed-filament row has fewer than four required fields"),
        );
        return None;
    }
    let current = tokens.len() != 4;
    let a = strict_integer(tokens[0]);
    let b = strict_integer(tokens[1]);
    let enabled = strict_integer(tokens[2]);
    let custom = if current {
        strict_integer(tokens[3])
    } else {
        Some(1.0)
    };
    let mix = strict_integer(tokens[if current { 4 } else { 3 }]);
    let (Some(a), Some(b), Some(enabled), Some(custom), Some(mix)) = (a, b, enabled, custom, mix)
    else {
        issue(
            true,
            utf16("Mixed-filament row has a malformed required integer field"),
        );
        return None;
    };
    let count = physical as f64;
    if a < 1.0 || b < 1.0 || a > count || b > count || a == b {
        issue(
            true,
            utf16(&format!(
                "Mixed-filament pair {}/{} is outside the {physical}-tool library",
                num(a),
                num(b)
            )),
        );
        return None;
    }
    let mut origin_auto = custom == 0.0;
    let mut gradient_ids: &[u16] = &[];
    let mut gradient_weights: &[u16] = &[];
    let mut manual: Option<&[u16]> = None;
    let mut distribution = 2.0;
    let mut local_z = 0.0;
    let (mut offset_a, mut offset_b) = (0.0, 0.0);
    let mut deleted = false;
    let mut stable_id = String::from("0");
    let mut ui_mode = -1.0;
    let mut gradient_enabled = false;
    let (mut gradient_start, mut gradient_end) = (0.8, 0.2);
    let mut index = if current { 5 } else { tokens.len() };
    if current && tokens.len() >= 6 {
        let legacy = tokens[5];
        if eq(legacy, "0") || eq(legacy, "1") {
            index = 6;
            if eq(legacy, "1") {
                issue(
                    false,
                    utf16("Compiled-out pointillisme flag was normalized to false"),
                );
            }
        } else if legacy.is_empty()
            || legacy
                .first()
                .is_some_and(|u| b"gGmMrR".iter().any(|c| u16::from(*c) == *u))
        {
            index = 5;
        } else {
            manual = Some(legacy);
            index = 6;
        }
    }
    let mut pattern: Vec<&[u16]> = manual.into_iter().collect();
    for &token in &tokens[index.min(tokens.len())..] {
        if token.is_empty() {
            continue;
        }
        let first = u8::try_from(token[0]).ok().map(|c| c.to_ascii_lowercase());
        let rest = &token[1..];
        let second = token.get(1).and_then(|u| u8::try_from(*u).ok());
        match first {
            Some(b'g') => gradient_ids = rest,
            Some(b'w') => gradient_weights = rest,
            Some(b'm') => {
                distribution = clamp(strict_integer(rest).unwrap_or(distribution), 0.0, 2.0)
            }
            Some(b'z') => local_z = 0f64.max(strict_integer(rest).unwrap_or(local_z)),
            Some(b'x')
                if token.len() >= 3
                    && second.is_some_and(|c| matches!(c, b'a' | b'b' | b'A' | b'B')) =>
            {
                let offset = js::utf16_number(&token[2..]);
                if offset.is_finite() {
                    if second.is_some_and(|c| c.eq_ignore_ascii_case(&b'a')) {
                        offset_a = clamp(offset, -2.0, 2.0);
                    } else {
                        offset_b = clamp(offset, -2.0, 2.0);
                    }
                }
            }
            Some(b'd') => {
                deleted = strict_integer(rest).unwrap_or(f64::from(u8::from(deleted))) != 0.0
            }
            Some(b'o') => {
                origin_auto =
                    strict_integer(rest).unwrap_or(f64::from(u8::from(origin_auto))) != 0.0
            }
            Some(b'u') if stable_digits(rest) => {
                if let Some(id) = lossy(rest).and_then(|s| s.parse::<u64>().ok()) {
                    stable_id = id.to_string();
                }
            }
            _ if token.len() >= 2
                && first == Some(b'c')
                && second.is_some_and(|c| c.eq_ignore_ascii_case(&b'm')) =>
            {
                if let Some(mode) = strict_integer(&token[2..]) {
                    ui_mode = clamp(mode, -1.0, 3.0);
                }
            }
            Some(b'r') => {
                let parts = split(rest, b'/');
                if parts.len() == 3 && parts.iter().all(|p| !p.is_empty()) {
                    let flag = strict_integer(parts[0]);
                    let start = js::utf16_number(parts[1]);
                    let end = js::utf16_number(parts[2]);
                    if let Some(flag) = flag
                        && start.is_finite()
                        && end.is_finite()
                        && start > 0.0
                        && start < 1.0
                        && end > 0.0
                        && end < 1.0
                    {
                        gradient_enabled = flag != 0.0;
                        gradient_start = clamp(start, 0.01, 0.99);
                        gradient_end = clamp(end, 0.01, 0.99);
                        if (gradient_start - gradient_end).abs() < 0.05 {
                            gradient_enabled = false;
                        }
                    }
                }
            }
            _ => pattern.push(token),
        }
    }
    let mut manual_pattern = Vec::new();
    for (i, token) in pattern.iter().enumerate() {
        if i > 0 {
            manual_pattern.push(u16::from(b','));
        }
        manual_pattern.extend_from_slice(token);
    }
    let gradient_tools = match gradient_tool_ids(gradient_ids, physical) {
        Some(ids) => ids,
        None => {
            issue(
                true,
                utf16("Gradient component IDs reference a missing or malformed physical tool"),
            );
            return None;
        }
    };
    let weights = normalize_gradient(gradient_weights, gradient_tools.len());
    let distribution_mode = if distribution == 1.0 {
        if gradient_tools.len() >= 3 { 0.0 } else { 2.0 }
    } else if distribution == 0.0 {
        0.0
    } else {
        2.0
    };
    Some(Row {
        a: a as usize,
        b: b as usize,
        enabled: enabled != 0.0,
        custom: if current { custom != 0.0 } else { true },
        origin_auto,
        mix_b: clamp(mix, 0.0, 100.0),
        gradient_tools,
        gradient_weights: weights,
        manual_pattern,
        distribution_mode,
        local_z,
        offset_a,
        offset_b,
        deleted,
        stable_id,
        ui_mode,
        gradient_enabled,
        gradient_start,
        gradient_end,
    })
}
/// `/^(0|[1-9][0-9]*)$/`.
fn stable_digits(units: &[u16]) -> bool {
    !units.is_empty()
        && units.iter().all(|u| (0x30..=0x39).contains(u))
        && (units.len() == 1 || units[0] != 0x30)
}
/// `decodeGradientIds`: slash-separated, or one token per code point.
fn gradient_tool_ids(value: &[u16], physical: usize) -> Option<Vec<usize>> {
    if value.is_empty() {
        return Some(Vec::new());
    }
    let raw: Vec<Vec<u16>> = if value.contains(&u16::from(b'/')) {
        split(value, b'/')
            .into_iter()
            .filter(|p| !p.is_empty())
            .map(<[u16]>::to_vec)
            .collect()
    } else {
        // Spread iterates code points; a lone surrogate is its own element.
        let mut out = Vec::new();
        let mut i = 0;
        while i < value.len() {
            let pair = (0xd800..0xdc00).contains(&value[i])
                && value
                    .get(i + 1)
                    .is_some_and(|u| (0xdc00..0xe000).contains(u));
            let n = if pair { 2 } else { 1 };
            out.push(value[i..i + n].to_vec());
            i += n;
        }
        out
    };
    let mut result = Vec::new();
    for token in raw {
        if token.is_empty() || !token.iter().all(|u| (0x30..=0x39).contains(u)) {
            return None;
        }
        let id = js::utf16_number(&token);
        if !js::is_safe_integer(id) || id < 1.0 || id > (physical.min(64)) as f64 {
            return None;
        }
        let id = id as usize;
        if !result.contains(&id) {
            result.push(id);
        }
    }
    Some(result)
}
/// `normalizeGradientWeights`.
fn normalize_gradient(value: &[u16], expected: usize) -> Result<Vec<f64>, ()> {
    if expected == 0 {
        return Ok(Vec::new());
    }
    let mut parsed = Vec::new();
    let mut i = 0;
    while i < value.len() {
        if (0x30..=0x39).contains(&value[i]) {
            let start = i;
            while i < value.len() && (0x30..=0x39).contains(&value[i]) {
                i += 1;
            }
            parsed.push(js::utf16_number(&value[start..i]));
        } else {
            i += 1;
        }
    }
    if parsed.len() != expected || parsed.iter().all(|w| *w == 0.0) {
        return Ok(Vec::new());
    }
    color_match_weights(&parsed, expected)
}
/// `normalizeColorMatchWeights` with an equal-length input.
pub fn color_match_weights(weights: &[f64], count: usize) -> Result<Vec<f64>, ()> {
    if weights.iter().any(|w| !js::is_safe_integer(*w)) {
        return Err(());
    }
    if count == 0 {
        return Ok(Vec::new());
    }
    let mut out: Vec<f64> = if weights.len() == count {
        weights.to_vec()
    } else {
        vec![(100.0 / count as f64).trunc(); count]
    };
    let mut sum = 0.0;
    for w in &mut out {
        *w = 0f64.max(*w);
        sum += *w;
    }
    if sum <= 0.0 {
        out.iter_mut().for_each(|w| *w = 0.0);
        out[0] = 100.0;
        return Ok(out);
    }
    let mut remainders = vec![0.0; count];
    let mut assigned = 0.0;
    for i in 0..count {
        let exact = (100.0 * out[i]) / sum;
        out[i] = exact.floor();
        remainders[i] = exact - out[i];
        assigned += out[i];
    }
    let mut missing = 0f64.max(100.0 - assigned);
    while missing > 0.0 {
        let mut best = 0;
        let mut best_remainder = -1.0;
        for (i, r) in remainders.iter().enumerate() {
            if *r > best_remainder {
                best_remainder = *r;
                best = i;
            }
        }
        out[best] += 1.0;
        remainders[best] = 0.0;
        missing -= 1.0;
    }
    Ok(out)
}

// ---- manual cycle grammar (`manualCyclePattern.ts`) ----

struct Pattern {
    ok: bool,
    groups: Vec<Vec<usize>>,
    messages: Vec<String>,
}
fn json_string(units: &[u16]) -> String {
    // JSON.stringify of a one-code-point string, including lone surrogates.
    let mut out = String::from("\"");
    match String::from_utf16(units) {
        Ok(s) => {
            for c in s.chars() {
                match c {
                    '"' => out.push_str("\\\""),
                    '\\' => out.push_str("\\\\"),
                    '\u{8}' => out.push_str("\\b"),
                    '\u{c}' => out.push_str("\\f"),
                    '\n' => out.push_str("\\n"),
                    '\r' => out.push_str("\\r"),
                    '\t' => out.push_str("\\t"),
                    c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
                    c => out.push(c),
                }
            }
        }
        Err(_) => {
            for u in units {
                out.push_str(&format!("\\u{u:04x}"));
            }
        }
    }
    out.push('"');
    out
}
/// The browser's issue messages are UTF-16 strings; this grammar is ASCII
/// except for the echoed unexpected character, carried as UTF-16 below.
fn manual_pattern(input: &[u16], available: usize) -> Pattern {
    let mut messages: Vec<Vec<u16>> = Vec::new();
    let mut groups = Vec::new();
    let mut syntax_ok = true;
    let mut unknown = false;
    let msg = |s: &str| utf16(s);
    if input.is_empty() {
        return Pattern {
            ok: false,
            groups,
            messages: vec!["Enter at least one physical filament ID.".into()],
        };
    }
    let mut group_start = 0;
    for offset in 0..=input.len() {
        if offset < input.len() && input[offset] != u16::from(b',') {
            continue;
        }
        let raw = &input[group_start..offset];
        let mut tokens = Vec::new();
        if raw.is_empty() {
            syntax_ok = false;
            messages.push(msg(
                "Each comma-separated perimeter group must contain at least one filament token.",
            ));
        } else if raw.contains(&u16::from(b'/')) {
            for segment in split(raw, b'/') {
                if segment.is_empty() {
                    syntax_ok = false;
                    messages.push(msg("Each slash must separate two decimal filament IDs."));
                } else {
                    explicit_token(
                        segment,
                        available,
                        &mut tokens,
                        &mut messages,
                        &mut syntax_ok,
                        &mut unknown,
                    );
                }
            }
        } else {
            let mut i = 0;
            while i < raw.len() {
                let u = raw[i];
                if (0x31..=0x39).contains(&u) {
                    add_token(
                        usize::from(u - 0x30),
                        available,
                        &mut tokens,
                        &mut messages,
                        &mut unknown,
                    );
                    i += 1;
                } else if u == 0x30 {
                    syntax_ok = false;
                    messages.push(msg(
                        "Filament IDs are one-based; replace 0 with an ID from 1 to 99.",
                    ));
                    i += 1;
                } else if u == u16::from(b'[') {
                    match raw[i + 1..].iter().position(|c| *c == u16::from(b']')) {
                        None => {
                            syntax_ok = false;
                            messages.push(msg("Close this multi-digit filament token with ]."));
                            break;
                        }
                        Some(n) => {
                            let close = i + 1 + n;
                            explicit_token(
                                &raw[i..=close],
                                available,
                                &mut tokens,
                                &mut messages,
                                &mut syntax_ok,
                                &mut unknown,
                            );
                            i = close + 1;
                        }
                    }
                } else {
                    let pair = (0xd800..0xdc00).contains(&u)
                        && raw.get(i + 1).is_some_and(|n| (0xdc00..0xe000).contains(n));
                    let width = if pair { 2 } else { 1 };
                    syntax_ok = false;
                    let mut m = utf16("Unexpected ");
                    m.extend(json_string(&raw[i..i + width]).encode_utf16());
                    m.extend("; use digits, [N], slash separators, or commas.".encode_utf16());
                    messages.push(m);
                    i += width;
                }
            }
        }
        groups.push(tokens);
        group_start = offset + 1;
    }
    Pattern {
        ok: syntax_ok && !unknown,
        groups,
        messages: messages
            .into_iter()
            .map(|m| String::from_utf16_lossy(&m))
            .collect(),
    }
}
fn add_token(
    id: usize,
    available: usize,
    tokens: &mut Vec<usize>,
    messages: &mut Vec<Vec<u16>>,
    unknown: &mut bool,
) {
    tokens.push(id);
    if id > available {
        *unknown = true;
        messages.push(utf16(&format!(
            "Filament {id} is not available in this project."
        )));
    }
}
fn explicit_token(
    raw: &[u16],
    available: usize,
    tokens: &mut Vec<usize>,
    messages: &mut Vec<Vec<u16>>,
    syntax_ok: &mut bool,
    unknown: &mut bool,
) {
    let bracketed = raw.first() == Some(&u16::from(b'[')) && raw.last() == Some(&u16::from(b']'));
    let digits = if bracketed {
        &raw[1..raw.len() - 1]
    } else {
        raw
    };
    let mut fail = |m: String| {
        *syntax_ok = false;
        messages.push(utf16(&m));
    };
    if bracketed && digits.is_empty() {
        return fail("Put a filament ID between [ and ].".into());
    }
    if digits.is_empty() || !digits.iter().all(|u| (0x30..=0x39).contains(u)) {
        return fail("Filament tokens must contain only ASCII decimal digits.".into());
    }
    let text: String = digits.iter().map(|u| char::from(*u as u8)).collect();
    if digits.len() > 1 && digits[0] == 0x30 {
        return fail("Filament IDs cannot contain leading zeroes.".into());
    }
    let id = js::number(&text);
    if id == 0.0 {
        return fail("Filament IDs are one-based; replace 0 with an ID from 1 to 99.".into());
    }
    if digits.len() > 2 || id > 99.0 {
        return fail(format!(
            "Filament {text} cannot be encoded; the pinned engine supports IDs 1 to 99."
        ));
    }
    add_token(id as usize, available, tokens, messages, unknown);
}

// ---- row assembly ----

fn obj(entries: Vec<(&str, Value)>) -> Value {
    Value::Object(entries.into_iter().map(|(k, v)| (utf16(k), v)).collect())
}
fn ids(list: &[&[u16]]) -> Value {
    Value::Array(list.iter().map(|id| Value::String(id.to_vec())).collect())
}
/// fullSpectrumImport `normalizeColor`.
fn normalize_color(value: &[u16]) -> Vec<u16> {
    let trimmed = js::trim_utf16(value);
    let text = lossy(trimmed).unwrap_or_default();
    let hex = text.strip_prefix('#').unwrap_or(&text);
    if (hex.len() == 6 || hex.len() == 8) && hex.bytes().all(|b| b.is_ascii_hexdigit()) {
        utf16(&format!("#{}", hex.to_ascii_uppercase()))
    } else {
        utf16("#808080")
    }
}
fn gcd(a: f64, b: f64) -> f64 {
    let (mut l, mut r) = (a.abs(), b.abs());
    while r != 0.0 {
        (l, r) = (r, l % r);
    }
    l
}
fn round_half_up(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 { f + 1.0 } else { f }
}

/// `importFullSpectrumDefinitions`. `Err` is an exception that aborts import.
pub fn import(
    serialized: &[u16],
    physical: &[Physical<'_>],
    materials: &[Material<'_>],
    mut create_id: impl FnMut(usize, &str) -> Vec<u16>,
) -> Result<Imported, Failure> {
    let mut out = Imported {
        filaments: Vec::new(),
        enabled: Vec::new(),
        issues: Vec::new(),
    };
    let mut used = BTreeSet::<String>::new();
    let mut next: u128 = 1;
    let mut material_index = 0usize;
    for (row_index, source) in split(serialized, b';').into_iter().enumerate() {
        if js::trim_utf16(source).is_empty() {
            continue;
        }
        let mut issues = Vec::new();
        let mut issue = |error: bool, message: Vec<u16>| issues.push((error, message));
        let parsed = parse_row(source, physical.len(), &mut issue);
        let Some(row) = parsed else {
            out.issues
                .extend(issues.into_iter().map(|(error, message)| Issue {
                    row_index,
                    error,
                    message,
                }));
            continue;
        };
        let weights = row.gradient_weights.clone();
        let Ok(gradient_weights) = weights else {
            return Err(Failure::MixedDefinitions);
        };
        let mut stable = row.stable_id.clone();
        if stable == "0" || used.contains(&stable) {
            while used.contains(&next.to_string()) {
                next += 1;
            }
            let replacement = next.to_string();
            issue(
                false,
                utf16(&if stable == "0" {
                    format!("Legacy stable ID 0 was assigned deterministic ID {replacement}")
                } else {
                    format!(
                        "Duplicate stable ID {stable} was assigned deterministic ID {replacement}"
                    )
                }),
            );
            stable = replacement;
            next += 1;
        }
        used.insert(stable.clone());
        let enabled = row.enabled && !row.deleted;
        let material = if enabled {
            let m = materials.get(material_index);
            material_index += 1;
            m
        } else {
            None
        };
        let a_id = physical[row.a - 1].id;
        let b_id = physical[row.b - 1].id;
        let gradient_ids: Vec<&[u16]> = row
            .gradient_tools
            .iter()
            .map(|t| physical[t - 1].id)
            .collect();
        // stablePatternGroups
        let mut pattern: Vec<Vec<&[u16]>> = Vec::new();
        if !row.manual_pattern.is_empty() {
            if physical.len() > 99 {
                // availableToolSet throws for an unencodable tool ID.
                return Err(Failure::MixedDefinitions);
            }
            let parsed = manual_pattern(&row.manual_pattern, physical.len());
            if !parsed.ok {
                issue(
                    true,
                    utf16(&format!(
                        "Manual Cycle pattern is invalid: {}",
                        parsed.messages.join(" ")
                    )),
                );
                out.issues
                    .extend(issues.into_iter().map(|(error, message)| Issue {
                        row_index,
                        error,
                        message,
                    }));
                continue;
            }
            pattern = parsed
                .groups
                .iter()
                .map(|g| {
                    g.iter()
                        .map(|&t| {
                            let tool = if t == 1 {
                                row.a
                            } else if t == 2 {
                                row.b
                            } else {
                                t
                            };
                            physical[tool - 1].id
                        })
                        .collect()
                })
                .collect();
        }
        let mix_b = if pattern.is_empty() {
            clamp(row.mix_b, 0.0, 100.0)
        } else {
            let average = pattern.iter().fold(0.0, |sum, g| {
                sum + g.iter().filter(|id| **id == b_id).count() as f64 / g.len() as f64
            });
            round_half_up((100.0 * average) / pattern.len() as f64)
        };
        let plain = row.ui_mode != 0.0 || row.gradient_tools.len() >= 3;
        let (ratio_a, ratio_b) = if plain {
            (1.0, 1.0)
        } else {
            let d = gcd(100.0 - row.mix_b, row.mix_b);
            let ra = if row.mix_b >= 100.0 {
                0.0
            } else if row.mix_b <= 0.0 {
                1.0
            } else {
                (100.0 - row.mix_b) / d
            };
            let rb = if row.mix_b <= 0.0 {
                0.0
            } else if row.mix_b >= 100.0 {
                1.0
            } else {
                row.mix_b / d
            };
            (ra, rb)
        };
        // importedComponents
        let mut ordered: Vec<&[u16]> = Vec::new();
        for id in [a_id, b_id]
            .into_iter()
            .chain(gradient_ids.iter().copied())
            .chain(pattern.iter().flatten().copied())
        {
            if !ordered.contains(&id) {
                ordered.push(id);
            }
        }
        let weight_of = |id: &[u16]| -> f64 {
            if !gradient_ids.is_empty() && gradient_weights.len() == gradient_ids.len() {
                let mut w = None;
                for (g, weight) in gradient_ids.iter().zip(&gradient_weights) {
                    if *g == id {
                        w = Some(*weight);
                    }
                }
                w.unwrap_or(0.0)
            } else if !pattern.is_empty() {
                pattern.iter().flatten().filter(|p| **p == id).count() as f64
            } else if id == a_id {
                100.0 - mix_b
            } else if id == b_id {
                mix_b
            } else {
                0.0
            }
        };
        let components: Vec<(&[u16], f64)> =
            ordered.iter().map(|id| (*id, weight_of(id))).collect();
        let display_color =
            normalize_color(material.map_or(physical[row.a - 1].color, |m| m.color));
        let distribution = if !pattern.is_empty() || row.ui_mode == 1.0 {
            obj(vec![("mode", Value::String(utf16("cycle")))])
        } else if row.ui_mode == 2.0 {
            obj(vec![
                ("mode", Value::String(utf16("match"))),
                ("targetColor", Value::String(display_color.clone())),
            ])
        } else if row.gradient_enabled || row.ui_mode == 3.0 {
            let weights = |at: f64| {
                Value::Array(
                    components
                        .iter()
                        .map(|(id, _)| {
                            Value::Number(if *id == a_id {
                                at
                            } else if *id == b_id {
                                1.0 - at
                            } else {
                                0.0
                            })
                        })
                        .collect(),
                )
            };
            obj(vec![
                ("mode", Value::String(utf16("gradient"))),
                ("startWeights", weights(row.gradient_start)),
                ("endWeights", weights(row.gradient_end)),
            ])
        } else {
            obj(vec![("mode", Value::String(utf16("ratio")))])
        };
        if row.ui_mode == 2.0 {
            issue(
                false,
                utf16(
                    "The upstream compact row does not persist the Match target; the imported display color is retained as its target",
                ),
            );
        }
        let full_spectrum = obj(vec![
            ("schemaVersion", Value::Number(1.0)),
            ("upstreamStableId", Value::String(utf16(&stable))),
            ("uiMode", Value::Number(row.ui_mode)),
            ("componentAId", Value::String(a_id.to_vec())),
            ("componentBId", Value::String(b_id.to_vec())),
            ("ratioA", Value::Number(ratio_a)),
            ("ratioB", Value::Number(ratio_b)),
            ("mixBPercent", Value::Number(mix_b)),
            (
                "manualPatternGroups",
                Value::Array(pattern.iter().map(|g| ids(g)).collect()),
            ),
            ("gradientComponentIds", ids(&gradient_ids)),
            (
                "gradientComponentWeights",
                Value::Array(gradient_weights.iter().map(|w| Value::Number(*w)).collect()),
            ),
            ("pointillismAllFilaments", Value::Bool(false)),
            ("distributionMode", Value::Number(row.distribution_mode)),
            ("localZMaxSublayers", Value::Number(row.local_z)),
            ("gradientEnabled", Value::Bool(row.gradient_enabled)),
            ("gradientStart", Value::Number(row.gradient_start)),
            ("gradientEnd", Value::Number(row.gradient_end)),
            ("componentASurfaceOffsetMm", Value::Number(row.offset_a)),
            ("componentBSurfaceOffsetMm", Value::Number(row.offset_b)),
            ("deleted", Value::Bool(row.deleted)),
            ("custom", Value::Bool(row.custom)),
            ("originAuto", Value::Bool(row.origin_auto)),
        ]);
        let name = material
            .map(|m| js::trim_utf16(m.name).to_vec())
            .filter(|n| !n.is_empty())
            .unwrap_or_else(|| utf16(&format!("Virtual filament {}", row_index + 1)));
        out.filaments.push(obj(vec![
            ("id", Value::String(create_id(row_index, &stable))),
            ("name", Value::String(name)),
            ("displayColor", Value::String(display_color)),
            (
                "components",
                Value::Array(
                    components
                        .iter()
                        .map(|(id, w)| {
                            obj(vec![
                                ("filamentId", Value::String(id.to_vec())),
                                ("weight", Value::Number(*w)),
                            ])
                        })
                        .collect(),
                ),
            ),
            ("distribution", distribution),
            ("fullSpectrum", full_spectrum),
            ("config", Value::Object(Default::default())),
            ("enabled", Value::Bool(enabled)),
            (
                "extensionData",
                obj(vec![(
                    "orcaxrFullSpectrumImport",
                    obj(vec![
                        ("source", Value::String(utf16("mixed_filament_definitions"))),
                        ("rowIndex", Value::Number(row_index as f64)),
                        ("targetColorRecoverable", Value::Bool(row.ui_mode != 2.0)),
                    ]),
                )]),
            ),
        ]));
        out.enabled.push(enabled);
        out.issues
            .extend(issues.into_iter().map(|(error, message)| Issue {
                row_index,
                error,
                message,
            }));
    }
    Ok(out)
}
