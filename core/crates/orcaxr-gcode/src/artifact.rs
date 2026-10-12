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
use serde::Serialize;

/// The totals are written after the toolpaths: only the trailer is scanned for them.
pub const TRAILER_SCAN_UNITS: usize = 64 * 1024;

/// One tool's usage, as the artifact states it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolUsage {
    /// 0-based tool index, matching the artifact's own filament order.
    pub tool_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub length_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub volume_cm3: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight_g: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_hex: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub material: Option<String>,
}

/// What the artifact states about itself.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactSummary {
    pub per_tool: Vec<ToolUsage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_weight_g: Option<f64>,
    /// The engine's own cost figure; its currency is a profile setting, not a fact of the file.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_cost: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_changes: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layer_count: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub estimated_seconds: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_layer_seconds: Option<f64>,
    /// True when the artifact stated no totals at all.
    pub empty: bool,
}

/// One tool line of the panel: its colour swatch, if stated, and its text.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolLine {
    pub tool_index: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color_hex: Option<String>,
    pub text: String,
}

/// The summary as the preview panel words it: a totals line, then a line for
/// each tool that used filament.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryText {
    pub totals: String,
    pub tools: Vec<ToolLine>,
}

/// `summarizeGcodeArtifact` over the file's bytes.
pub fn summarize(bytes: &[u8]) -> ArtifactSummary {
    summary(
        &trailer(bytes),
        byte_line(bytes, COLOURS),
        byte_line(bytes, MATERIALS),
    )
}

/// `summarizeGcodeArtifact` over text already decoded (a preview session's
/// UTF-16 units, the byte-order mark already dropped), as the browser reads it.
pub fn summarize_text(units: &[u16]) -> ArtifactSummary {
    let line = |prefix| unit_line(units, prefix).map(<[u16]>::to_vec);
    summary(
        &units[units.len().saturating_sub(TRAILER_SCAN_UNITS)..],
        line(COLOURS),
        line(MATERIALS),
    )
}

const COLOURS: &[u8] = b"; filament_colour = ";
const MATERIALS: &[u8] = b"; filament_type = ";

fn summary(
    trailer: &[u16],
    colors: Option<Vec<u16>>,
    materials: Option<Vec<u16>>,
) -> ArtifactSummary {
    let lengths = number_list(unit_line(trailer, b"; filament used [mm] = "));
    let volumes = number_list(unit_line(trailer, b"; filament used [cm3] = "));
    let weights = number_list(unit_line(trailer, b"; filament used [g] = "));
    let colors = text_list(colors);
    let materials = text_list(materials);
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
        total_weight_g: finite(unit_line(trailer, b"; total filament used [g] = ")),
        total_cost: finite(unit_line(trailer, b"; total filament cost = ")),
        tool_changes: integer(unit_line(trailer, b"; total filament change = ")),
        layer_count: integer(unit_line(trailer, b"; total layers count = ")),
        estimated_seconds: duration(unit_line(
            trailer,
            b"; estimated printing time (normal mode) = ",
        )),
        first_layer_seconds: duration(unit_line(
            trailer,
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

/// The bytes that can hold the trailer: a UTF-16 unit comes from at most three
/// bytes, so the last [`TRAILER_SCAN_UNITS`] units lie within these.
const TRAILER_WINDOW_BYTES: usize = TRAILER_SCAN_UNITS * 3 + 4;

/// The last [`TRAILER_SCAN_UNITS`] UTF-16 units of the decoded text.
fn trailer(bytes: &[u8]) -> Vec<u16> {
    if bytes.len() <= TRAILER_WINDOW_BYTES {
        trailer_of(bytes, true)
    } else {
        trailer_of(&bytes[bytes.len() - TRAILER_WINDOW_BYTES..], false)
    }
}

/// The trailer from the file's last [`TRAILER_WINDOW_BYTES`] bytes, or the
/// [`whole`](trailer_of) file when it is no longer. A cut window's decoding
/// starts at a byte no sequence can continue, where the whole file's decoder
/// starts afresh too.
fn trailer_of(window: &[u8], whole: bool) -> Vec<u16> {
    let units = if whole {
        decode_utf8(window)
    } else {
        let mut start = 0;
        while start < window.len() && (0x80..=0xBF).contains(&window[start]) {
            start += 1;
        }
        let mut units = Vec::with_capacity(window.len() - start);
        Utf8Decoder::fragment().decode(&window[start..], true, &mut units);
        units
    };
    if units.len() > TRAILER_SCAN_UNITS {
        units[units.len() - TRAILER_SCAN_UNITS..].to_vec()
    } else {
        units
    }
}

/// The layer-change markers the browser counts when an artifact states no
/// total (`/; CHANGE_LAYER|;LAYER_CHANGE/g`). Each starts with the only `;`
/// it holds, so matches never overlap and a mismatch restarts at most at the
/// byte that broke it.
const LAYER_MARKERS: [&[u8]; 2] = [b"; CHANGE_LAYER", b";LAYER_CHANGE"];

/// What the browser's status line says of a finished slice
/// (`sliceStatusFigures` and `describeSliceStatus` in `SliceStatus.ts`), with
/// numbers spelled as JavaScript spells them.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SliceFigures {
    /// The artifact's length.
    pub bytes: u64,
    /// `(bytes / 1024).toFixed(0)`.
    pub kilobytes: String,
    /// `split('\n').length` of the decoded text.
    pub lines: u64,
    /// The engine's stated total, else [`layer_markers`](Self::layer_markers).
    pub layers: String,
    /// The total the trailer states (`summarizeGcodeArtifact(...).layerCount`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stated_layers: Option<String>,
    pub layer_markers: u64,
}

/// [`SliceFigures`] and the [`ArtifactSummary`] of an artifact streamed
/// through in chunks of any size, as a host writes or reads it: line breaks
/// and markers are counted as they pass, the first colour and material
/// statements are kept as their lines pass, and only the bytes that can hold
/// the trailer are kept.
#[derive(Debug, Default)]
pub struct SliceTally {
    bytes: u64,
    breaks: u64,
    markers: u64,
    matched: [usize; 2],
    tail: Vec<u8>,
    statements: Statements,
}

/// The whole-file statements a summary reads before its trailer
/// (`byte_line` over [`COLOURS`] and [`MATERIALS`]), found as lines pass: a
/// line ends at LF, CR, U+2028 or U+2029, one leading byte-order mark is not
/// text, and the first line that starts with a prefix and holds more is the
/// statement. A statement is kept up to [`MAX_STATEMENT_BYTES`].
#[derive(Debug, Clone, Default)]
struct Statements {
    /// The file's first bytes, until they are known to be, or not be, a byte-order mark.
    head: Vec<u8>,
    started: bool,
    /// The current line's length so far, its last two bytes, and whether it
    /// still starts with each prefix.
    length: usize,
    last: [u8; 2],
    open: [bool; 2],
    /// The current line's bytes after each prefix it starts with.
    kept: [Vec<u8>; 2],
    found: [Option<Vec<u16>>; 2],
    overflow: bool,
}

/// The longest statement kept, as long as a preview session's metadata may be.
pub const MAX_STATEMENT_BYTES: usize = crate::layout::MAX_METADATA_BYTES;
const STATEMENTS: [&[u8]; 2] = [COLOURS, MATERIALS];

impl Statements {
    fn push(&mut self, chunk: &[u8]) {
        if self.found.iter().all(Option::is_some) || self.overflow {
            return;
        }
        let mut chunk = chunk;
        if !self.started {
            let take = chunk.len().min(3 - self.head.len());
            self.head.extend_from_slice(&chunk[..take]);
            chunk = &chunk[take..];
            if self.head.len() < 3 {
                return;
            }
            self.start();
        }
        for &byte in chunk {
            self.byte(byte);
        }
    }

    /// The head decided: a byte-order mark is dropped, any other bytes are text.
    fn start(&mut self) {
        self.started = true;
        self.open = [true; 2];
        let head = std::mem::take(&mut self.head);
        if head != [0xEF, 0xBB, 0xBF] {
            for byte in head {
                self.byte(byte);
            }
        }
    }

    fn byte(&mut self, byte: u8) {
        if byte == b'\n' || byte == b'\r' {
            return self.end(self.length);
        }
        if matches!(byte, 0xA8 | 0xA9) && self.length >= 2 && self.last == [0xE2, 0x80] {
            // U+2028 or U+2029: the line ends before its first two bytes.
            for kept in &mut self.kept {
                kept.truncate(kept.len().saturating_sub(2));
            }
            return self.end(self.length - 2);
        }
        for (index, prefix) in STATEMENTS.iter().enumerate() {
            if !self.open[index] || self.found[index].is_some() {
                continue;
            }
            if self.length < prefix.len() {
                self.open[index] = prefix[self.length] == byte;
            } else if self.kept[index].len() < MAX_STATEMENT_BYTES + 2 {
                self.kept[index].push(byte);
            } else {
                self.overflow = true;
            }
        }
        self.length += 1;
        self.last = [self.last[1], byte];
    }

    /// The current line ends after `length` bytes.
    fn end(&mut self, length: usize) {
        for (index, prefix) in STATEMENTS.iter().enumerate() {
            if self.open[index] && self.found[index].is_none() && length > prefix.len() {
                if self.kept[index].len() > MAX_STATEMENT_BYTES {
                    self.overflow = true;
                }
                let mut units = Vec::with_capacity(self.kept[index].len());
                Utf8Decoder::fragment().decode(&self.kept[index], true, &mut units);
                self.found[index] = Some(units);
            }
            self.kept[index].clear();
        }
        self.length = 0;
        self.last = [0; 2];
        self.open = [true; 2];
    }

    /// The statements of everything pushed, its last line ended there; none
    /// when one was past [`MAX_STATEMENT_BYTES`].
    fn finish(&self) -> Option<[Option<Vec<u16>>; 2]> {
        let mut done = self.clone();
        if !done.started {
            done.start();
        }
        if done.found.iter().any(Option::is_none) {
            done.end(done.length);
        }
        (!done.overflow).then_some(done.found)
    }
}

impl SliceTally {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            if byte == b'\n' {
                self.breaks += 1;
            }
            for (marker, matched) in LAYER_MARKERS.iter().zip(self.matched.iter_mut()) {
                *matched = if marker[*matched] == byte {
                    *matched + 1
                } else {
                    usize::from(marker[0] == byte)
                };
                if *matched == marker.len() {
                    self.markers += 1;
                    *matched = 0;
                }
            }
        }
        self.bytes += chunk.len() as u64;
        self.statements.push(chunk);
        self.tail.extend_from_slice(chunk);
        if self.tail.len() > 2 * TRAILER_WINDOW_BYTES {
            self.tail.drain(..self.tail.len() - TRAILER_WINDOW_BYTES);
        }
    }

    /// The trailer of everything pushed.
    fn trailer(&self) -> Vec<u16> {
        let whole = self.bytes <= TRAILER_WINDOW_BYTES as u64;
        let window = &self.tail[self.tail.len().saturating_sub(TRAILER_WINDOW_BYTES)..];
        trailer_of(window, whole)
    }

    /// `summarizeGcodeArtifact` of everything pushed — what [`summarize`]
    /// reads from the whole file — or none when its colour or material
    /// statement is longer than [`MAX_STATEMENT_BYTES`].
    pub fn summary(&self) -> Option<ArtifactSummary> {
        let [colours, materials] = self.statements.finish()?;
        Some(summary(&self.trailer(), colours, materials))
    }

    pub fn finish(&self) -> SliceFigures {
        let stated = integer(unit_line(&self.trailer(), b"; total layers count = "));
        SliceFigures {
            bytes: self.bytes,
            kilobytes: ryu_js::Buffer::new()
                .format_to_fixed(self.bytes as f64 / 1024.0, 0)
                .into(),
            lines: self.breaks + 1,
            layers: stated.map_or_else(|| self.markers.to_string(), number),
            stated_layers: stated.map(number),
            layer_markers: self.markers,
        }
    }
}

impl ArtifactSummary {
    /// The summary as one JSON object in the browser's field names, for hosts.
    pub fn json(&self) -> String {
        serde_json::to_string(self).expect("an artifact summary serializes")
    }
}

impl SliceFigures {
    /// The figures as one ASCII JSON object, for hosts.
    pub fn json(&self) -> String {
        serde_json::to_string(self).expect("slice figures serialize")
    }
}

/// [`SliceFigures`] of a whole artifact.
pub fn slice_figures(bytes: &[u8]) -> SliceFigures {
    let mut tally = SliceTally::new();
    tally.push(bytes);
    tally.finish()
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

    /// Streamed in chunks of any size — splitting byte-order marks, line
    /// separators and prefixes — the tally summarizes as the whole file does.
    #[test]
    fn a_streamed_artifact_summarizes_as_the_whole_file_does() {
        let mut stated = 0;
        for seed in 1..=48u32 {
            let mut bytes = noise(seed * 7_727, 3_000 + seed as usize * 211);
            if seed % 3 == 0 {
                bytes.splice(0..0, [0xEF, 0xBB, 0xBF]);
            }
            if seed % 4 == 0 {
                bytes.extend_from_slice(
                    b"\n; filament_type = PLA;PETG\n; filament used [g] = 1.5,2",
                );
            }
            let whole = summarize(&bytes);
            stated += usize::from(whole.per_tool.iter().any(|t| t.color_hex.is_some()));
            for size in [1, 2, 3, 5, 64, 4_096, bytes.len().max(1)] {
                let mut tally = SliceTally::new();
                for chunk in bytes.chunks(size) {
                    tally.push(chunk);
                }
                assert_eq!(
                    tally.summary(),
                    Some(whole.clone()),
                    "seed {seed} size {size}"
                );
            }
        }
        assert!(stated >= 6, "{stated} seeds state a colour");
        for short in [
            &b""[..],
            b"\xEF",
            b"\xEF\xBB",
            b"\xEF\xBB\xBF",
            b";",
            b"; filament_type = A",
        ] {
            let mut tally = SliceTally::new();
            tally.push(short);
            assert_eq!(tally.summary(), Some(summarize(short)), "{short:?}");
        }
    }

    /// A statement longer than a session's metadata bound is not kept: the
    /// summary is unavailable, as a session refuses it.
    #[test]
    fn an_oversized_statement_leaves_no_summary() {
        let mut tally = SliceTally::new();
        tally.push(b"G1 X1\n; filament_colour = ");
        let line = vec![b'#'; 1 << 16];
        for _ in 0..(MAX_STATEMENT_BYTES >> 16) + 1 {
            tally.push(&line);
        }
        tally.push(b"\n; total layers count = 3\n");
        assert_eq!(tally.summary(), None);
        assert_eq!(tally.finish().layers, "3");
    }

    #[test]
    fn decoded_text_summarizes_as_its_bytes_do() {
        for seed in 1..=24u32 {
            let mut bytes = noise(seed * 6_151, 90_000 + seed as usize * 11_000);
            bytes.extend_from_slice(
                b"\n; filament used [mm] = 1200.5,30\n; filament used [g] = 3.5,0.1\n; total layers count = 12\n",
            );
            assert_eq!(
                summarize_text(&decode_utf8(&bytes)),
                summarize(&bytes),
                "seed {seed}"
            );
        }
    }
}
