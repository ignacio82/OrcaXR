//! The pictures a sliced file carries (`GcodeThumbnails.ts` and the framing
//! of `PlateThumbnailRenderer.ts`, through `GcodeThumbnailsExchange.ts` and
//! `PlateThumbnailExchange.ts`), exactly as the browser computes them:
//!
//! - [`list`]: what a printer's `thumbnails` value asks for
//!   (`parseThumbnailList`, the pinned engine's
//!   `make_and_check_thumbnail_list`): a string split on commas, or each
//!   entry of a list as `String` makes it, trimmed and read as
//!   `WxH[/EXT]` with `0 < size < 1000` and PNG by default; what cannot be
//!   honoured is stated, not dropped;
//! - [`block`]: one image in the engine's wire format
//!   (`export_thumbnails_to_file`): the `THUMBNAIL_BLOCK_START` wrapper, the
//!   `; thumbnail begin WxH <base64 length>` header and 78-character rows;
//! - [`Anchor`] and [`inject`]: where the blocks go
//!   (`injectGcodeThumbnails`) — after `; HEADER_BLOCK_END` and its blank
//!   line, at the top without one, and nowhere when the file already carries
//!   a thumbnail. A host streams the G-code through an [`Anchor`] once, so a
//!   file of any size is never held;
//! - [`frame`]: the three-quarter camera that fits the drawn models
//!   (`frameCamera`), in three.js axes (Y up).
//!
//! The exchange is canonical JSON ([`list_json`], [`block_json`],
//! [`inject_json`], [`view_json`]); a malformed request is `invalid_request`.
use crate::js_math::{
    self,
    convert::{trim_utf16, utf16_number, value_to_string},
};
use crate::model::ProjectState;
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;

/// A request that is not the documented shape.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// The engine's bound on each side: `0 < size < 1000`.
pub const MAX_DIMENSION: u32 = 1000;
/// Base64 characters per row, after `; `, as the engine wraps them.
pub const MAX_ROW_LENGTH: usize = 78;
/// The marker the blocks follow (`GCode.cpp` writes them after the header for a non-BBL printer).
pub const HEADER_BLOCK_END: &[u8] = b"; HEADER_BLOCK_END\n";
/// A G-code carrying this already has its pictures: it never gets a second set.
pub const THUMBNAIL_BLOCK_START: &[u8] = b"; THUMBNAIL_BLOCK_START";

/// The image formats a thumbnail is written in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Format {
    Png,
    Jpg,
}
impl Format {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpg => "JPG",
        }
    }
    /// The block's tag (`thumbnail` for PNG, `thumbnail_JPG` for JPEG).
    pub fn tag(self) -> &'static str {
        match self {
            Self::Png => "thumbnail",
            Self::Jpg => "thumbnail_JPG",
        }
    }
}

/// One size and format a printer asks for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Request {
    pub width: u32,
    pub height: u32,
    pub format: Format,
}

/// Why an entry of a `thumbnails` value cannot be honoured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    Invalid,
    OutOfRange,
    UnsupportedFormat,
}
impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Invalid => "invalid",
            Self::OutOfRange => "out-of-range",
            Self::UnsupportedFormat => "unsupported-format",
        }
    }
}

/// An entry that cannot be honoured: its trimmed text and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Problem {
    pub entry: Vec<u16>,
    pub reason: Reason,
}

/// What a `thumbnails` value asks for, in its order.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct List {
    pub requests: Vec<Request>,
    pub problems: Vec<Problem>,
}

/// `parseThumbnailList`: a configuration's `thumbnails` value (`None` when absent).
pub fn list(value: Option<&Value>) -> List {
    let entries: Vec<Vec<u16>> = match value {
        Some(Value::Array(items)) => items.iter().map(value_to_string).collect(),
        Some(Value::String(text)) => text
            .split(|&u| u == u16::from(b','))
            .map(<[u16]>::to_vec)
            .collect(),
        _ => Vec::new(),
    };
    let mut out = List::default();
    for raw in &entries {
        let entry = trim_utf16(raw);
        if entry.is_empty() {
            continue;
        }
        match read_entry(entry) {
            Ok(request) => out.requests.push(request),
            Err(reason) => out.problems.push(Problem {
                entry: entry.to_vec(),
                reason,
            }),
        }
    }
    out
}

/// The `thumbnails` a project's slice reads: its base profile's when it
/// records one, else its configuration's (`getSlicingConfiguration().config`).
pub fn state_list(state: &ProjectState) -> List {
    let config = crate::placement::bed::workspace_config(state);
    let value = match config {
        Value::Object(fields) => fields.get(&units("thumbnails")),
        _ => None,
    };
    // `??`: a `null` value falls through like an absent one, and the browser
    // then reads its selected profile's, which a host passes separately.
    list(value.filter(|value| !matches!(value, Value::Null)))
}

fn is_digit(unit: u16) -> bool {
    (0x30..=0x39).contains(&unit)
}
fn is_space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(js_math::convert::is_space)
}

/// `/^(\d+)\s*x\s*(\d+)(?:\s*\/\s*([A-Za-z_]+))?$/` over a trimmed entry, then
/// the engine's bounds and the formats a picture can be written in.
fn read_entry(entry: &[u16]) -> Result<Request, Reason> {
    let mut at = 0;
    let digits = |at: &mut usize| {
        let start = *at;
        while *at < entry.len() && is_digit(entry[*at]) {
            *at += 1;
        }
        (*at > start).then(|| &entry[start..*at])
    };
    let spaces = |at: &mut usize| {
        while *at < entry.len() && is_space(entry[*at]) {
            *at += 1;
        }
    };
    let width = digits(&mut at).ok_or(Reason::Invalid)?;
    spaces(&mut at);
    if entry.get(at) != Some(&u16::from(b'x')) {
        return Err(Reason::Invalid);
    }
    at += 1;
    spaces(&mut at);
    let height = digits(&mut at).ok_or(Reason::Invalid)?;
    let extension = if at == entry.len() {
        None
    } else {
        spaces(&mut at);
        if entry.get(at) != Some(&u16::from(b'/')) {
            return Err(Reason::Invalid);
        }
        at += 1;
        spaces(&mut at);
        let start = at;
        while at < entry.len()
            && entry[at] < 0x80
            && (entry[at] as u8 == b'_' || (entry[at] as u8).is_ascii_alphabetic())
        {
            at += 1;
        }
        if at == start || at != entry.len() {
            return Err(Reason::Invalid);
        }
        Some(&entry[start..at])
    };
    let width = utf16_number(width);
    let height = utf16_number(height);
    let limit = f64::from(MAX_DIMENSION);
    // `!(n > 0) || n >= 1000`, NaN included (digits never read as one).
    let in_range = |n: f64| n > 0.0 && n < limit;
    if !in_range(width) || !in_range(height) {
        return Err(Reason::OutOfRange);
    }
    let extension: String = extension.map_or_else(
        || "PNG".to_owned(),
        |units| {
            units
                .iter()
                .map(|&u| (u as u8).to_ascii_uppercase() as char)
                .collect()
        },
    );
    let format = match extension.as_str() {
        "PNG" => Format::Png,
        "JPG" | "JPEG" => Format::Jpg,
        _ => return Err(Reason::UnsupportedFormat),
    };
    // Both are whole numbers below 1000 here.
    Ok(Request {
        width: width as u32,
        height: height as u32,
        format,
    })
}

/// Standard base64 with padding (`btoa`).
fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for (i, shift) in [18, 12, 6, 0].into_iter().enumerate() {
            out.push(if i <= chunk.len() {
                ALPHABET[(n >> shift) as usize & 63] as char
            } else {
                '='
            });
        }
    }
    out
}

/// `encodeThumbnailBlock`: one image in the engine's wire format.
pub fn block(request: Request, image: &[u8]) -> String {
    let encoded = base64(image);
    let tag = request.format.tag();
    let mut out = String::with_capacity(encoded.len() + encoded.len() / MAX_ROW_LENGTH * 3 + 128);
    out.push_str("; THUMBNAIL_BLOCK_START\n");
    out.push_str(&format!(
        "\n;\n; {tag} begin {}x{} {}\n",
        request.width,
        request.height,
        encoded.len()
    ));
    // Base64 is ASCII, so byte offsets are character offsets.
    for row in encoded.as_bytes().chunks(MAX_ROW_LENGTH) {
        out.push_str("; ");
        out.push_str(std::str::from_utf8(row).expect("base64 is ASCII"));
        out.push('\n');
    }
    out.push_str(&format!("; {tag} end\n"));
    out.push_str("; THUMBNAIL_BLOCK_END\n\n");
    out
}

/// Where the blocks go in a G-code.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Insertion {
    /// The file stays as it is: there is nothing to add, or it already carries a thumbnail.
    Unchanged,
    /// The blocks go before the byte at this offset.
    At(u64),
}

/// A pattern's progress through a stream (Knuth–Morris–Pratt), so a marker
/// split across chunks is still found.
#[derive(Debug, Clone)]
struct Search {
    pattern: &'static [u8],
    border: Vec<usize>,
    matched: usize,
}
impl Search {
    fn new(pattern: &'static [u8]) -> Self {
        let mut border = vec![0; pattern.len()];
        let mut k = 0;
        for i in 1..pattern.len() {
            while k > 0 && pattern[i] != pattern[k] {
                k = border[k - 1];
            }
            if pattern[i] == pattern[k] {
                k += 1;
            }
            border[i] = k;
        }
        Self {
            pattern,
            border,
            matched: 0,
        }
    }
    /// Whether `byte` completes the pattern.
    fn step(&mut self, byte: u8) -> bool {
        while self.matched > 0 && self.pattern[self.matched] != byte {
            self.matched = self.border[self.matched - 1];
        }
        if self.pattern[self.matched] == byte {
            self.matched += 1;
        }
        if self.matched == self.pattern.len() {
            self.matched = self.border[self.matched - 1];
            return true;
        }
        false
    }
}

/// Finds where a G-code's thumbnail blocks go as its bytes pass through in
/// chunks of any size ([`inject`] over a stream): the end of the first
/// `; HEADER_BLOCK_END` line and whether a blank line follows it, and whether
/// the file already carries `; THUMBNAIL_BLOCK_START` anywhere.
#[derive(Debug, Clone)]
pub struct Anchor {
    offset: u64,
    header: Search,
    thumbnail: Search,
    /// The offset just after the first header marker, once found.
    header_end: Option<u64>,
    /// Whether the byte at `header_end` is a line feed; unknown until it passes.
    blank_line: Option<bool>,
    has_thumbnail: bool,
}
impl Default for Anchor {
    fn default() -> Self {
        Self::new()
    }
}
impl Anchor {
    pub fn new() -> Self {
        Self {
            offset: 0,
            header: Search::new(HEADER_BLOCK_END),
            thumbnail: Search::new(THUMBNAIL_BLOCK_START),
            header_end: None,
            blank_line: None,
            has_thumbnail: false,
        }
    }
    pub fn push(&mut self, chunk: &[u8]) {
        for &byte in chunk {
            if self.header_end == Some(self.offset) {
                self.blank_line = Some(byte == b'\n');
            }
            self.offset += 1;
            if self.thumbnail.step(byte) {
                self.has_thumbnail = true;
            }
            if self.header.step(byte) && self.header_end.is_none() {
                self.header_end = Some(self.offset);
            }
        }
    }
    /// Bytes seen so far.
    pub fn length(&self) -> u64 {
        self.offset
    }
    /// Where `blocks` blocks go in the file seen.
    pub fn finish(&self, blocks: usize) -> Insertion {
        if blocks == 0 || self.has_thumbnail {
            return Insertion::Unchanged;
        }
        match self.header_end {
            None => Insertion::At(0),
            Some(end) => Insertion::At(end + u64::from(self.blank_line == Some(true))),
        }
    }
}

/// `injectGcodeThumbnails` over a whole G-code's UTF-16 text.
pub fn inject(gcode: &[u16], blocks: &[Vec<u16>]) -> Vec<u16> {
    if blocks.is_empty() || find(gcode, THUMBNAIL_BLOCK_START).is_some() {
        return gcode.to_vec();
    }
    let at = match find(gcode, HEADER_BLOCK_END) {
        None => 0,
        Some(start) => {
            let end = start + HEADER_BLOCK_END.len();
            end + usize::from(gcode.get(end) == Some(&u16::from(b'\n')))
        }
    };
    let mut out = Vec::with_capacity(gcode.len() + blocks.iter().map(Vec::len).sum::<usize>());
    out.extend_from_slice(&gcode[..at]);
    for block in blocks {
        out.extend_from_slice(block);
    }
    out.extend_from_slice(&gcode[at..]);
    out
}
fn find(text: &[u16], pattern: &[u8]) -> Option<usize> {
    text.windows(pattern.len())
        .position(|window| window.iter().zip(pattern).all(|(&u, &b)| u == u16::from(b)))
}

/// The thumbnail camera's field of view (degrees), where it stands and what it looks at.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct View {
    pub fov_deg: f64,
    pub position: [f64; 3],
    pub target: [f64; 3],
}

/// The camera's vertical field of view.
pub const FOV_DEG: f64 = 30.0;
const ELEVATION_DEG: f64 = 28.0;
const AZIMUTH_DEG: f64 = -35.0;
/// Slack around the models' bounding sphere, so nothing touches the edge.
const FRAMING_MARGIN: f64 = 1.18;

/// `frameCamera`: a three-quarter view from the front left, above, that fits
/// the bounds `min`..`max` (three.js axes, Y up; not empty) in an image of
/// `aspect` (width over height).
pub fn frame(min: [f64; 3], max: [f64; 3], aspect: f64) -> View {
    let degrees = |value: f64| value * (std::f64::consts::PI / 180.0);
    let centre: [f64; 3] = std::array::from_fn(|i| (min[i] + max[i]) * 0.5);
    let size: [f64; 3] = std::array::from_fn(|i| max[i] - min[i]);
    let radius = (size[0] * size[0] + size[1] * size[1] + size[2] * size[2]).sqrt() * 0.5;
    let v_fov = degrees(FOV_DEG);
    let h_fov = 2.0 * js_math::atan(js_math::tan(v_fov / 2.0) * aspect);
    let radius = js_math::max(radius, 1e-4) * FRAMING_MARGIN;
    let distance = radius / js_math::sin(js_math::min(v_fov, h_fov) / 2.0);
    let azimuth = degrees(AZIMUTH_DEG);
    let elevation = degrees(ELEVATION_DEG);
    View {
        fov_deg: FOV_DEG,
        position: [
            centre[0] + distance * js_math::cos(elevation) * js_math::sin(azimuth),
            centre[1] + distance * js_math::sin(elevation),
            centre[2] + distance * js_math::cos(elevation) * js_math::cos(azimuth),
        ],
        target: centre,
    }
}

// --- Exchange --------------------------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn read(request: &str) -> Result<Value, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    parse(request).map_err(|_| INVALID_REQUEST)
}
fn members(
    value: Value,
    required: &[&str],
    optional: &[&str],
) -> Result<BTreeMap<Vec<u16>, Value>, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| required.iter().chain(optional).any(|n| units(n) == *key);
    if !fields.keys().all(known) || !required.iter().all(|n| fields.contains_key(&units(n))) {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}
fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| "output_limit")?;
    String::from_utf8(bytes).map_err(|_| "output_limit")
}
fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect())
}

/// A list as its reply document: `{"problems","requests"}`.
pub fn list_value(list: &List) -> Value {
    object([
        (
            "problems",
            Value::Array(
                list.problems
                    .iter()
                    .map(|problem| {
                        object([
                            ("entry", Value::String(problem.entry.clone())),
                            ("reason", Value::String(units(problem.reason.as_str()))),
                        ])
                    })
                    .collect(),
            ),
        ),
        (
            "requests",
            Value::Array(
                list.requests
                    .iter()
                    .map(|request| request_value(*request))
                    .collect(),
            ),
        ),
    ])
}
/// A request as `{"format","height","width"}`.
pub fn request_value(request: Request) -> Value {
    object([
        ("format", Value::String(units(request.format.as_str()))),
        ("height", Value::Number(f64::from(request.height))),
        ("width", Value::Number(f64::from(request.width))),
    ])
}
/// `{"format","height","width"}`, each side a whole number inside the engine's bounds.
pub fn read_request(value: Value) -> Result<Request, &'static str> {
    let mut fields = members(value, &["format", "height", "width"], &[])?;
    let side = |value: Option<Value>| match value {
        Some(Value::Number(n)) if n.fract() == 0.0 && n > 0.0 && n < f64::from(MAX_DIMENSION) => {
            Ok(n as u32)
        }
        _ => Err(INVALID_REQUEST),
    };
    let format = match fields.remove(&units("format")) {
        Some(Value::String(text)) if text == units("PNG") => Format::Png,
        Some(Value::String(text)) if text == units("JPG") => Format::Jpg,
        _ => return Err(INVALID_REQUEST),
    };
    Ok(Request {
        width: side(fields.remove(&units("width")))?,
        height: side(fields.remove(&units("height")))?,
        format,
    })
}

/// `{"value"?}` → `{"problems","requests"}`.
pub fn list_json(request: &str) -> Result<String, &'static str> {
    let fields = members(read(request)?, &[], &["value"])?;
    canonical(&list_value(&list(fields.get(&units("value")))))
}

/// `{"image": lowercase hex, "request"}` → the block's text as a JSON string.
pub fn block_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["image", "request"], &[])?;
    let thumbnail = read_request(fields.remove(&units("request")).ok_or(INVALID_REQUEST)?)?;
    let Some(Value::String(hex)) = fields.remove(&units("image")) else {
        return Err(INVALID_REQUEST);
    };
    let nibble = |unit: u16| match unit {
        0x30..=0x39 => Ok((unit - 0x30) as u8),
        0x61..=0x66 => Ok((unit - 0x61 + 10) as u8),
        _ => Err(INVALID_REQUEST),
    };
    if hex.len() % 2 != 0 {
        return Err(INVALID_REQUEST);
    }
    let image = hex
        .chunks(2)
        .map(|pair| Ok(nibble(pair[0])? << 4 | nibble(pair[1])?))
        .collect::<Result<Vec<u8>, &'static str>>()?;
    canonical(&Value::String(units(&block(thumbnail, &image))))
}

/// `{"blocks","gcode"}` → the G-code with its blocks, as a JSON string.
pub fn inject_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["blocks", "gcode"], &[])?;
    let Some(Value::String(gcode)) = fields.remove(&units("gcode")) else {
        return Err(INVALID_REQUEST);
    };
    let Some(Value::Array(blocks)) = fields.remove(&units("blocks")) else {
        return Err(INVALID_REQUEST);
    };
    let blocks = blocks
        .into_iter()
        .map(|block| match block {
            Value::String(text) => Ok(text),
            _ => Err(INVALID_REQUEST),
        })
        .collect::<Result<Vec<_>, _>>()?;
    canonical(&Value::String(inject(&gcode, &blocks)))
}

/// `{"aspect","max","min"}` → `{"fovDeg","position","target"}`.
pub fn view_json(request: &str) -> Result<String, &'static str> {
    let mut fields = members(read(request)?, &["aspect", "max", "min"], &[])?;
    let vector = |value: Option<Value>| match value {
        Some(Value::Array(items)) if items.len() == 3 => {
            let mut out = [0.0; 3];
            for (slot, item) in out.iter_mut().zip(items) {
                match item {
                    Value::Number(n) if n.is_finite() => *slot = n,
                    _ => return Err(INVALID_REQUEST),
                }
            }
            Ok(out)
        }
        _ => Err(INVALID_REQUEST),
    };
    let aspect = match fields.remove(&units("aspect")) {
        Some(Value::Number(n)) if n.is_finite() && n > 0.0 => n,
        _ => return Err(INVALID_REQUEST),
    };
    let min = vector(fields.remove(&units("min")))?;
    let max = vector(fields.remove(&units("max")))?;
    // `Box3.isEmpty`.
    if (0..3).any(|i| max[i] < min[i]) {
        return Err(INVALID_REQUEST);
    }
    let view = frame(min, max, aspect);
    let triple = |v: [f64; 3]| Value::Array(v.map(Value::Number).to_vec());
    canonical(&object([
        ("fovDeg", Value::Number(view.fov_deg)),
        ("position", triple(view.position)),
        ("target", triple(view.target)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_pads_as_btoa_does() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(&[1, 2, 3, 4, 5, 6]), "AQIDBAUG");
    }

    #[test]
    fn markers_split_across_chunks_are_found() {
        let gcode = b"G28\n; HEADER_BLOCK_END\n\nG1\n";
        for split in 0..gcode.len() {
            let mut anchor = Anchor::new();
            anchor.push(&gcode[..split]);
            anchor.push(&gcode[split..]);
            assert_eq!(anchor.finish(1), Insertion::At(24), "split at {split}");
        }
        let mut anchor = Anchor::new();
        anchor.push(b"; ; HEADER_BLOCK_END\n; THUMBNAIL_BLOCK_STAR");
        anchor.push(b"T");
        assert_eq!(anchor.finish(1), Insertion::Unchanged);
    }
}
