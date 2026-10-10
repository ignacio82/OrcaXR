//! The totals the engine itself wrote into a finished G-code artifact, read
//! as the browser reads them (`GcodeArtifactSummary.ts`), and worded as its
//! preview panel words them.
//!
//! The figures are read, never recomputed: a value the artifact does not
//! state stays absent (a missing weight is not zero grams) and a zero it did
//! state is kept. The browser decodes the file as UTF-8 (`TextDecoder`, one
//! leading byte-order mark dropped) and matches JavaScript multiline
//! patterns over the text; this reads the bytes directly — a whole-file match
//! line by line, the trailer as its last 64 Ki UTF-16 units — so a large file
//! is never held as UTF-16, with the same results: a line starts at the text's
//! start or after LF, CR, U+2028 or U+2029, all of which are their own bytes.

use crate::utf8::{Utf8Decoder, decode_utf8};

/// The totals are written after the toolpaths: only the trailer is scanned for them.
pub const TRAILER_SCAN_UNITS: usize = 64 * 1024;

/// One tool's usage, as the artifact states it.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolUsage {
    /// 0-based tool index, matching the artifact's own filament order.
    pub tool_index: u32,
    pub length_mm: Option<f64>,
    pub volume_cm3: Option<f64>,
    pub weight_g: Option<f64>,
    pub color_hex: Option<String>,
    pub material: Option<String>,
}

/// What the artifact states about itself.
#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactSummary {
    pub per_tool: Vec<ToolUsage>,
    pub total_weight_g: Option<f64>,
    /// The engine's own cost figure; its currency is a profile setting, not a fact of the file.
    pub total_cost: Option<f64>,
    pub tool_changes: Option<f64>,
    pub layer_count: Option<f64>,
    pub estimated_seconds: Option<f64>,
    pub first_layer_seconds: Option<f64>,
    /// True when the artifact stated no totals at all.
    pub empty: bool,
}

/// One tool line of the panel: its colour swatch, if stated, and its text.
#[derive(Debug, Clone, PartialEq)]
pub struct ToolLine {
    pub tool_index: u32,
    pub color_hex: Option<String>,
    pub text: String,
}

/// The summary as the preview panel words it: a totals line, then a line for
/// each tool that used filament.
#[derive(Debug, Clone, PartialEq)]
pub struct SummaryText {
    pub totals: String,
    pub tools: Vec<ToolLine>,
}

/// `summarizeGcodeArtifact` over the file's bytes.
pub fn summarize(bytes: &[u8]) -> ArtifactSummary {
    let trailer = trailer(bytes);
    let lengths = number_list(unit_line(&trailer, b"; filament used [mm] = "));
    let volumes = number_list(unit_line(&trailer, b"; filament used [cm3] = "));
    let weights = number_list(unit_line(&trailer, b"; filament used [g] = "));
    let colors = text_list(byte_line(bytes, b"; filament_colour = "));
    let materials = text_list(byte_line(bytes, b"; filament_type = "));
    let count = lengths.len().max(volumes.len()).max(weights.len());
    let at = |list: &[Option<f64>], index: usize| list.get(index).copied().flatten();
    let text = |list: &[Option<String>], index: usize| list.get(index).cloned().flatten();
    let per_tool = (0..count)
        .map(|index| ToolUsage {
            tool_index: index as u32,
            length_mm: at(&lengths, index),
            volume_cm3: at(&volumes, index),
            weight_g: at(&weights, index),
            color_hex: text(&colors, index),
            material: text(&materials, index),
        })
        .collect::<Vec<_>>();
    let mut summary = ArtifactSummary {
        total_weight_g: finite(unit_line(&trailer, b"; total filament used [g] = ")),
        total_cost: finite(unit_line(&trailer, b"; total filament cost = ")),
        tool_changes: integer(unit_line(&trailer, b"; total filament change = ")),
        layer_count: integer(unit_line(&trailer, b"; total layers count = ")),
        estimated_seconds: duration(unit_line(
            &trailer,
            b"; estimated printing time (normal mode) = ",
        )),
        first_layer_seconds: duration(unit_line(
            &trailer,
            b"; estimated first layer printing time (normal mode) = ",
        )),
        per_tool,
        empty: false,
    };
    summary.empty = summary.per_tool.is_empty()
        && summary.total_weight_g.is_none()
        && summary.total_cost.is_none()
        && summary.tool_changes.is_none()
        && summary.layer_count.is_none()
        && summary.estimated_seconds.is_none()
        && summary.first_layer_seconds.is_none();
    summary
}

/// `formatArtifactDuration`: `1h 04m`, `12m 30s`, `45s`, `2d 3h`, or an em
/// dash when nothing usable was stated.
pub fn format_duration(seconds: Option<f64>) -> String {
    let Some(seconds) = seconds.filter(|s| s.is_finite() && *s >= 0.0) else {
        return "—".into();
    };
    let total = js_round(seconds);
    let days = (total / 86_400.0).floor();
    let hours = ((total % 86_400.0) / 3600.0).floor();
    let minutes = ((total % 3600.0) / 60.0).floor();
    let rest = total % 60.0;
    if days > 0.0 {
        return format!("{}d {}h", number(days), number(hours));
    }
    if hours > 0.0 {
        return format!("{}h {}m", number(hours), padded(minutes));
    }
    if minutes > 0.0 {
        return format!("{}m {}s", number(minutes), padded(rest));
    }
    format!("{}s", number(rest))
}

/// The preview panel's wording (`describeArtifactSummary`).
pub fn describe(summary: &ArtifactSummary) -> SummaryText {
    let totals = [
        summary
            .estimated_seconds
            .map(|s| format!("≈{}", format_duration(Some(s)))),
        summary.total_weight_g.map(|g| format!("{} g", fixed(g))),
        summary.layer_count.map(|n| format!("{} layers", number(n))),
        summary
            .tool_changes
            .map(|n| format!("{} tool changes", number(n))),
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    let tools = summary
        .per_tool
        .iter()
        // `(lengthMm ?? weightG ?? 0) > 0`: a stated length decides alone.
        .filter(|tool| tool.length_mm.or(tool.weight_g).unwrap_or(0.0) > 0.0)
        .map(|tool| ToolLine {
            tool_index: tool.tool_index,
            color_hex: tool.color_hex.clone().filter(|value| swatch(value)),
            text: [
                Some(format!("T{}", tool.tool_index)),
                tool.material.clone(),
                tool.length_mm.map(|mm| format!("{} m", fixed(mm / 1000.0))),
                tool.weight_g.map(|g| format!("{} g", fixed(g))),
            ]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" · "),
        })
        .collect();
    SummaryText { totals, tools }
}

/// A swatch takes only a CSS hex colour (`#rgb`, `#rgba`, `#rrggbb`,
/// `#rrggbbaa`): the text is the artifact's own and becomes style text.
fn swatch(value: &str) -> bool {
    value.strip_prefix('#').is_some_and(|hex| {
        matches!(hex.len(), 3 | 4 | 6 | 8) && hex.bytes().all(|b| b.is_ascii_hexdigit())
    })
}

/// JavaScript `String(number)`.
fn number(value: f64) -> String {
    ryu_js::Buffer::new().format(value).into()
}
/// JavaScript `number.toFixed(2)`.
fn fixed(value: f64) -> String {
    ryu_js::Buffer::new().format_to_fixed(value, 2).into()
}
/// `String(value).padStart(2, '0')` for a whole number below 60.
fn padded(value: f64) -> String {
    let text = number(value);
    if text.chars().count() < 2 {
        format!("0{text}")
    } else {
        text
    }
}
/// `Math.round`: halves toward positive infinity, exact for every double.
fn js_round(value: f64) -> f64 {
    let floor = value.floor();
    if value - floor >= 0.5 {
        floor + 1.0
    } else {
        floor
    }
}

/// The last [`TRAILER_SCAN_UNITS`] UTF-16 units of the decoded text. A UTF-16
/// unit comes from at most three bytes, so the trailer lies within the last
/// `3 × TRAILER_SCAN_UNITS` bytes; decoding starts at a byte no sequence can
/// continue, where the whole file's decoder starts afresh too.
fn trailer(bytes: &[u8]) -> Vec<u16> {
    let window = TRAILER_SCAN_UNITS * 3 + 4;
    let units = if bytes.len() <= window {
        decode_utf8(bytes)
    } else {
        let mut start = bytes.len() - window;
        while start < bytes.len() && (0x80..=0xBF).contains(&bytes[start]) {
            start += 1;
        }
        let mut units = Vec::with_capacity(bytes.len() - start);
        Utf8Decoder::fragment().decode(&bytes[start..], true, &mut units);
        units
    };
    if units.len() > TRAILER_SCAN_UNITS {
        units[units.len() - TRAILER_SCAN_UNITS..].to_vec()
    } else {
        units
    }
}

fn unit_terminator(unit: u16) -> bool {
    matches!(unit, 0x0A | 0x0D | 0x2028 | 0x2029)
}

/// `/^<prefix>(.+)$/m.exec(text)?.[1]` over UTF-16 units.
fn unit_line<'a>(text: &'a [u16], prefix: &[u8]) -> Option<&'a [u16]> {
    let mut start = 0;
    while start <= text.len() {
        let rest = &text[start..];
        let end = rest
            .iter()
            .position(|unit| unit_terminator(*unit))
            .map_or(text.len(), |offset| start + offset);
        let line = &text[start..end];
        if line.len() > prefix.len()
            && line
                .iter()
                .zip(prefix)
                .all(|(unit, byte)| *unit == u16::from(*byte))
        {
            return Some(&line[prefix.len()..]);
        }
        if end == text.len() {
            return None;
        }
        start = end + 1;
    }
    None
}

/// The length of the line terminator at `index` in the bytes, if one starts there.
fn byte_terminator(bytes: &[u8], index: usize) -> Option<usize> {
    match bytes.get(index)? {
        b'\n' | b'\r' => Some(1),
        0xE2 if bytes.get(index + 1) == Some(&0x80)
            && matches!(bytes.get(index + 2), Some(0xA8 | 0xA9)) =>
        {
            Some(3)
        }
        _ => None,
    }
}

/// `/^<prefix>(.+)$/m.exec(decoded)?.[1]` over the file's bytes, decoded.
fn byte_line(bytes: &[u8], prefix: &[u8]) -> Option<Vec<u16>> {
    // One leading byte-order mark is not text.
    let mut start = if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        3
    } else {
        0
    };
    loop {
        let mut end = start;
        while end < bytes.len() && byte_terminator(bytes, end).is_none() {
            end += 1;
        }
        let line = &bytes[start..end];
        if line.len() > prefix.len() && line.starts_with(prefix) {
            let mut units = Vec::with_capacity(line.len() - prefix.len());
            Utf8Decoder::fragment().decode(&line[prefix.len()..], true, &mut units);
            return Some(units);
        }
        let terminator = byte_terminator(bytes, end)?;
        start = end + terminator;
    }
}

/// ECMAScript `WhiteSpace` and `LineTerminator`, what `trim()` and `\s` take.
fn space(unit: u16) -> bool {
    matches!(
        unit,
        0x09..=0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}
fn trim(units: &[u16]) -> &[u16] {
    let start = units.iter().position(|u| !space(*u)).unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !space(*u))
        .map_or(start, |i| i + 1);
    &units[start..end]
}
fn digit(unit: u16) -> bool {
    (u16::from(b'0')..=u16::from(b'9')).contains(&unit)
}
/// `Number(text)` for text already known to be ASCII digits, a sign and a point.
fn parse(units: &[u16]) -> f64 {
    let text: String = units.iter().map(|u| char::from(*u as u8)).collect();
    text.parse().unwrap_or(f64::NAN)
}

/// `finite`: an optionally negative decimal (`/^-?\d+(?:\.\d+)?$/`) that stays finite.
fn finite(raw: Option<&[u16]>) -> Option<f64> {
    let text = trim(raw?);
    let digits = text.strip_prefix(&[u16::from(b'-')]).unwrap_or(text);
    let whole = digits.iter().take_while(|u| digit(**u)).count();
    if whole == 0 {
        return None;
    }
    let tail = &digits[whole..];
    if !tail.is_empty()
        && (tail[0] != u16::from(b'.') || tail.len() < 2 || !tail[1..].iter().all(|u| digit(*u)))
    {
        return None;
    }
    Some(parse(text)).filter(|value| value.is_finite())
}

/// `singleInteger`: a stated whole number that is not negative.
fn integer(raw: Option<&[u16]>) -> Option<f64> {
    finite(raw).filter(|value| value.fract() == 0.0 && *value >= 0.0)
}

/// `numberList`: the comma-separated entries, each a number or absent.
fn number_list(raw: Option<&[u16]>) -> Vec<Option<f64>> {
    raw.map_or_else(Vec::new, |raw| {
        raw.split(|unit| *unit == u16::from(b','))
            .map(|entry| finite(Some(entry)))
            .collect()
    })
}

/// `textList`: the semicolon-separated entries, each trimmed text or absent when blank.
fn text_list(raw: Option<Vec<u16>>) -> Vec<Option<String>> {
    raw.map_or_else(Vec::new, |raw| {
        raw.split(|unit| *unit == u16::from(b';'))
            .map(|entry| {
                let value = trim(entry);
                (!value.is_empty()).then(|| String::from_utf16_lossy(value))
            })
            .collect()
    })
}

/// `duration`: the engine's own wording (`2d 3h 4m 5s`, each token a number
/// and a unit, tokens apart by white space) in seconds; any other shape,
/// such as `unknown`, is not a duration.
fn duration(raw: Option<&[u16]>) -> Option<f64> {
    let text = trim(raw?);
    if text.is_empty() {
        return None;
    }
    let mut index = 0;
    let mut seconds = 0.0;
    loop {
        if index > 0 {
            let before = index;
            while index < text.len() && space(text[index]) {
                index += 1;
            }
            if index == before {
                return None;
            }
        }
        let start = index;
        while index < text.len() && digit(text[index]) {
            index += 1;
        }
        if index == start {
            return None;
        }
        if index + 1 < text.len() && text[index] == u16::from(b'.') && digit(text[index + 1]) {
            index += 1;
            while index < text.len() && digit(text[index]) {
                index += 1;
            }
        }
        let value = parse(&text[start..index]);
        while index < text.len() && space(text[index]) {
            index += 1;
        }
        let scale = match text.get(index).copied().map(|u| u as u32) {
            Some(0x64) => 86_400.0,
            Some(0x68) => 3600.0,
            Some(0x6D) => 60.0,
            Some(0x73) => 1.0,
            _ => return None,
        };
        index += 1;
        seconds += value * scale;
        if index == text.len() {
            break;
        }
    }
    Some(seconds).filter(|value| value.is_finite())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Seeded bytes heavy in what decoding can disagree on: continuation and
    /// lead bytes, byte-order marks, line separators and the prefixes searched.
    fn noise(seed: u32, length: usize) -> Vec<u8> {
        let mut state = seed.max(1);
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        let pieces: [&[u8]; 12] = [
            b"\n",
            b"\r",
            b"\r\n",
            &[0xE2, 0x80, 0xA8],
            &[0xE2, 0x80, 0xA9],
            &[0xEF, 0xBB, 0xBF],
            b"; total layers count = 5",
            b"; filament_colour = #FFF;#000",
            &[0xF0, 0x9F, 0x98, 0x80],
            &[0xE2, 0x82, 0xAC],
            &[0x80],
            &[0xE0, 0x80],
        ];
        let mut out = Vec::with_capacity(length + 32);
        while out.len() < length {
            let pick = next();
            if pick % 3 == 0 {
                out.extend_from_slice(pieces[(pick as usize / 3) % pieces.len()]);
            } else {
                out.push((pick >> 8) as u8);
            }
        }
        out
    }

    #[test]
    fn the_trailer_window_is_the_decoded_texts_last_units() {
        for seed in 1..=24u32 {
            let bytes = noise(seed * 7919, 120_000 + seed as usize * 9_000);
            let decoded = decode_utf8(&bytes);
            let expected = &decoded[decoded.len().saturating_sub(TRAILER_SCAN_UNITS)..];
            assert_eq!(trailer(&bytes), expected, "seed {seed}");
        }
    }

    #[test]
    fn a_whole_file_line_search_on_bytes_matches_the_decoded_text() {
        for seed in 1..=64u32 {
            let bytes = noise(seed * 104_729, 4_000 + seed as usize * 37);
            let decoded = decode_utf8(&bytes);
            for prefix in [&b"; filament_colour = "[..], b"; total layers count = "] {
                assert_eq!(
                    byte_line(&bytes, prefix),
                    unit_line(&decoded, prefix).map(<[u16]>::to_vec),
                    "seed {seed}"
                );
            }
        }
    }
}
