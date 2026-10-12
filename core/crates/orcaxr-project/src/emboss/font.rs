//! The browser's TrueType reader (`truetypeOutlines.ts`, through
//! `embossFontExchange.ts`): a font file the operator picked, read into the
//! glyph outlines a text is embossed with, outline for outline.
//!
//! The scope is the browser's: `glyf`-outline TrueType, composite glyphs
//! included, alone or in a collection; a CFF font, an unreadable character
//! map or anything cut short is refused with the browser's reason. The file's
//! tables, metrics and character map are read when it loads; a glyph's
//! outline is read when a text needs it, so a glyph the font cannot give
//! refuses then. Every read is bounded by the file; the character map is
//! searched where it is stored, the last segment or group mapping a code
//! point winning; a glyph's contours must end in order; and one character's
//! outline may expand to at most [`MAX_OUTLINE_POINTS`] flattened points and
//! component references.
//!
//! Quadratics flatten into eight segments as the browser computes them, in
//! its operation order, so every coordinate is the browser's to the bit.
use orcaxr_contracts::project_intent_types as wire;
use std::collections::{HashMap, HashSet};

use crate::drawn::units;
use crate::js_math::convert;

/// Segments per quadratic curve.
const CURVE_SEGMENTS: u32 = 8;

/// Composite glyphs nest at most this deep.
const MAX_COMPOSITE_DEPTH: u32 = 5;

/// Flattened points and component references one character's outline may
/// expand to (`MAX_OUTLINE_POINTS`).
pub const MAX_OUTLINE_POINTS: i64 = 1 << 18;

/// The largest font file a host may send, in bytes.
pub const MAX_FONT_BYTES: usize = 64 * 1024 * 1024;

const ON_CURVE: u8 = 0x01;
const X_SHORT: u8 = 0x02;
const Y_SHORT: u8 = 0x04;
const REPEAT: u8 = 0x08;
const X_SAME_OR_POSITIVE: u8 = 0x10;
const Y_SAME_OR_POSITIVE: u8 = 0x20;

/// Why a font or one of its glyphs cannot be read: the browser's
/// `EmbossError` message (always `unsupported-font`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Unreadable(pub String);

impl Unreadable {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }

    /// The refusal a reply carries.
    pub fn refusal(&self) -> wire::EmbossRefusal {
        wire::EmbossRefusal {
            code: wire::EmbossRefusalCode::UnsupportedFont,
            message: units(&self.0),
        }
    }
}

fn truncated() -> Unreadable {
    Unreadable::new("This font file is cut short: its tables point past its end")
}

/// Bounded big-endian reads from the file (`Reader`).
struct Reader<'a> {
    bytes: &'a [u8],
    offset: u64,
}

impl<'a> Reader<'a> {
    fn at(bytes: &'a [u8], offset: u64) -> Self {
        Self { bytes, offset }
    }

    fn take(&mut self, size: u64) -> Result<usize, Unreadable> {
        let at = self.offset;
        if at + size > self.bytes.len() as u64 {
            return Err(truncated());
        }
        self.offset += size;
        Ok(at as usize)
    }

    fn u8(&mut self) -> Result<u8, Unreadable> {
        let at = self.take(1)?;
        Ok(self.bytes[at])
    }

    fn u16(&mut self) -> Result<u16, Unreadable> {
        let at = self.take(2)?;
        Ok(u16::from_be_bytes([self.bytes[at], self.bytes[at + 1]]))
    }

    fn i16(&mut self) -> Result<i16, Unreadable> {
        Ok(self.u16()? as i16)
    }

    fn u32(&mut self) -> Result<u32, Unreadable> {
        let at = self.take(4)?;
        Ok(u32::from_be_bytes([
            self.bytes[at],
            self.bytes[at + 1],
            self.bytes[at + 2],
            self.bytes[at + 3],
        ]))
    }

    fn tag(&mut self) -> Result<[u8; 4], Unreadable> {
        Ok([self.u8()?, self.u8()?, self.u8()?, self.u8()?])
    }
}

struct Segment {
    end: u32,
    start: u32,
    delta: i64,
    range_offset: u64,
    /// Where this segment's idRangeOffset is.
    at: u64,
}

struct Group {
    start: u64,
    end: u64,
    start_glyph: u64,
}

/// The chosen character map, read but not expanded.
enum Cmap {
    None,
    Format4(Vec<Segment>),
    Format12(Vec<Group>),
}

impl Cmap {
    /// The glyph `code` maps to: the last segment or group mapping it wins.
    fn lookup(&self, bytes: &[u8], code: u32) -> Option<u64> {
        match self {
            Cmap::None => None,
            Cmap::Format4(segments) => {
                // 0xFFFF is never mapped.
                if code >= 0xffff {
                    return None;
                }
                for segment in segments.iter().rev() {
                    if code < segment.start || code > segment.end {
                        continue;
                    }
                    let glyph = if segment.range_offset == 0 {
                        (i64::from(code) + segment.delta) & 0xffff
                    } else {
                        let glyph_at =
                            segment.at + segment.range_offset + u64::from(code - segment.start) * 2;
                        if glyph_at + 1 >= bytes.len() as u64 {
                            continue;
                        }
                        let at = glyph_at as usize;
                        let raw = i64::from(u16::from_be_bytes([bytes[at], bytes[at + 1]]));
                        if raw == 0 {
                            0
                        } else {
                            (raw + segment.delta) & 0xffff
                        }
                    };
                    if glyph != 0 {
                        return Some(glyph as u64);
                    }
                }
                None
            }
            Cmap::Format12(groups) => {
                let code = u64::from(code);
                groups
                    .iter()
                    .rev()
                    .find(|g| code >= g.start && code <= g.end && code - g.start < 0x10000)
                    .map(|g| g.start_glyph + (code - g.start))
            }
        }
    }
}

/// One character's outline in font units: its advance and its contours,
/// flattened to points (the closing edge implicit).
#[derive(Debug, Clone, PartialEq)]
pub struct Outline {
    pub advance: f64,
    pub contours: Vec<Vec<[f64; 2]>>,
}

/// What one character's outline may still spend.
struct Budget(i64);

impl Budget {
    fn spend(&mut self, count: usize) -> Result<(), Unreadable> {
        self.0 -= count as i64;
        if self.0 < 0 {
            return Err(Unreadable::new(
                "This font has a glyph too complex to emboss",
            ));
        }
        Ok(())
    }
}

/// A font the operator picked, read (`readTrueTypeOutlines`).
pub struct Font {
    bytes: Vec<u8>,
    units_per_em: u16,
    glyph_count: u16,
    loca: Vec<u64>,
    advances: Vec<u16>,
    cmap: Cmap,
    glyf: u64,
}

impl Font {
    /// Read a font file, with the collection index a `.ttc` is read at.
    pub fn read(bytes: Vec<u8>, collection: f64) -> Result<Font, Unreadable> {
        if bytes.len() < 12 {
            return Err(Unreadable::new("That file is too short to be a font"));
        }
        let mut reader = Reader::at(&bytes, 0);
        let mut sfnt_start = 0u64;
        let magic = reader.tag()?;
        match &magic {
            b"ttcf" => {
                reader.u32()?; // version
                let font_count = reader.u32()?;
                if !convert::is_safe_integer(collection)
                    || collection < 0.0
                    || collection >= f64::from(font_count)
                {
                    return Err(Unreadable(format!(
                        "This collection has {font_count} font(s); index {} is outside it",
                        convert::number_to_string(collection)
                    )));
                }
                reader.offset = 12 + collection as u64 * 4;
                sfnt_start = u64::from(reader.u32()?);
                reader.offset = sfnt_start;
                reader.tag()?;
            }
            b"OTTO" => {
                return Err(Unreadable::new(
                    "This is an OpenType/CFF font; OrcaXR embosses TrueType glyph outlines, so choose a .ttf",
                ));
            }
            b"\0\x01\0\0" | b"true" | b"typ1" => {}
            _ => return Err(Unreadable::new("That file is not a TrueType font")),
        }

        let table_count = reader.u16()?;
        reader.offset = sfnt_start + 12;
        let mut tables: HashMap<[u8; 4], u64> = HashMap::new();
        for _ in 0..table_count {
            let tag = reader.tag()?;
            reader.u32()?; // checksum
            let offset = u64::from(reader.u32()?);
            reader.u32()?; // length
            tables.insert(tag, offset);
        }
        if tables.contains_key(b"CFF ") && !tables.contains_key(b"glyf") {
            return Err(Unreadable::new(
                "This font stores its outlines in a CFF table; OrcaXR embosses TrueType glyph outlines, so choose a .ttf",
            ));
        }
        for required in [b"head", b"maxp", b"loca", b"glyf", b"cmap"] {
            if !tables.contains_key(required) {
                return Err(Unreadable(format!(
                    "This font has no {} table, so its glyphs cannot be read",
                    String::from_utf8_lossy(required)
                )));
            }
        }

        let head = tables[b"head"];
        let units_per_em = Reader::at(&bytes, head + 18).u16()?;
        let loca_format = Reader::at(&bytes, head + 50).i16()?;
        if units_per_em == 0 {
            return Err(Unreadable::new("This font declares no usable units per em"));
        }
        let glyph_count = Reader::at(&bytes, tables[b"maxp"] + 4).u16()?;
        let mut loca_reader = Reader::at(&bytes, tables[b"loca"]);
        let mut loca = Vec::with_capacity(usize::from(glyph_count) + 1);
        for _ in 0..=glyph_count {
            loca.push(if loca_format == 0 {
                u64::from(loca_reader.u16()?) * 2
            } else {
                u64::from(loca_reader.u32()?)
            });
        }
        let advances = match (tables.get(b"hhea"), tables.get(b"hmtx")) {
            (Some(&hhea), Some(&hmtx)) => read_advances(&bytes, hhea, hmtx, glyph_count)?,
            _ => Vec::new(),
        };
        let cmap = read_cmap(&bytes, tables[b"cmap"])?;
        let glyf = tables[b"glyf"];
        Ok(Font {
            bytes,
            units_per_em,
            glyph_count,
            loca,
            advances,
            cmap,
            glyf,
        })
    }

    pub fn units_per_em(&self) -> u16 {
        self.units_per_em
    }

    /// maxp's glyph count.
    pub fn glyph_count(&self) -> u16 {
        self.glyph_count
    }

    /// `EmbossFontReply`'s summary.
    pub fn summary(&self) -> wire::EmbossFontSummary {
        wire::EmbossFontSummary {
            units_per_em: u64::from(self.units_per_em),
            glyph_count: u64::from(self.glyph_count),
        }
    }

    /// The outline [code_point] maps to, none when the font has no glyph for
    /// it, or why its glyph cannot be read.
    pub fn outline(&self, code_point: u32) -> Result<Option<Outline>, Unreadable> {
        let Some(glyph) = self.cmap.lookup(&self.bytes, code_point) else {
            return Ok(None);
        };
        let advance = if self.advances.is_empty() {
            f64::from(self.units_per_em) / 2.0
        } else {
            let index = glyph.min(self.advances.len() as u64 - 1) as usize;
            f64::from(self.advances[index])
        };
        let contours = self.glyph(glyph, 0, &mut Budget(MAX_OUTLINE_POINTS))?;
        Ok(Some(Outline { advance, contours }))
    }

    fn glyph(
        &self,
        index: u64,
        depth: u32,
        budget: &mut Budget,
    ) -> Result<Vec<Vec<[f64; 2]>>, Unreadable> {
        if index >= u64::from(self.glyph_count) {
            return Ok(Vec::new());
        }
        let start = self.loca[index as usize];
        let end = self.loca[index as usize + 1];
        if end <= start {
            // An empty glyph, such as a space.
            return Ok(Vec::new());
        }
        let mut reader = Reader::at(&self.bytes, self.glyf + start);
        let contour_count = reader.i16()?;
        reader.offset += 8; // bounding box
        if contour_count >= 0 {
            return simple_glyph(&mut reader, contour_count as u16, budget);
        }
        if depth >= MAX_COMPOSITE_DEPTH {
            return Err(Unreadable::new(
                "This font nests composite glyphs too deeply to read",
            ));
        }
        self.composite_glyph(&mut reader, depth, budget)
    }

    fn composite_glyph(
        &self,
        reader: &mut Reader<'_>,
        depth: u32,
        budget: &mut Budget,
    ) -> Result<Vec<Vec<[f64; 2]>>, Unreadable> {
        const ARG_1_AND_2_ARE_WORDS: u16 = 0x0001;
        const ARGS_ARE_XY_VALUES: u16 = 0x0002;
        const WE_HAVE_A_SCALE: u16 = 0x0008;
        const MORE_COMPONENTS: u16 = 0x0020;
        const WE_HAVE_AN_X_AND_Y_SCALE: u16 = 0x0040;
        const WE_HAVE_A_TWO_BY_TWO: u16 = 0x0080;
        let f2dot14 = |reader: &mut Reader<'_>| -> Result<f64, Unreadable> {
            Ok(f64::from(reader.i16()?) / 16384.0)
        };
        let mut contours = Vec::new();
        loop {
            let flags = reader.u16()?;
            let glyph = reader.u16()?;
            budget.spend(1)?;
            let (mut dx, mut dy) = if flags & ARG_1_AND_2_ARE_WORDS != 0 {
                (f64::from(reader.i16()?), f64::from(reader.i16()?))
            } else {
                (f64::from(reader.u8()? as i8), f64::from(reader.u8()? as i8))
            };
            // Only offset placement is meaningful for a contour then transformed.
            if flags & ARGS_ARE_XY_VALUES == 0 {
                dx = 0.0;
                dy = 0.0;
            }
            let (mut a, mut b, mut c, mut d) = (1.0, 0.0, 0.0, 1.0);
            if flags & WE_HAVE_A_SCALE != 0 {
                a = f2dot14(reader)?;
                d = a;
            } else if flags & WE_HAVE_AN_X_AND_Y_SCALE != 0 {
                a = f2dot14(reader)?;
                d = f2dot14(reader)?;
            } else if flags & WE_HAVE_A_TWO_BY_TWO != 0 {
                a = f2dot14(reader)?;
                b = f2dot14(reader)?;
                c = f2dot14(reader)?;
                d = f2dot14(reader)?;
            }
            for contour in self.glyph(u64::from(glyph), depth + 1, budget)? {
                contours.push(
                    contour
                        .iter()
                        .map(|&[px, py]| [a * px + c * py + dx, b * px + d * py + dy])
                        .collect(),
                );
            }
            if flags & MORE_COMPONENTS == 0 {
                return Ok(contours);
            }
        }
    }

    /// `EmbossGlyphsReply`: the outlines a cut of [text] reads, each
    /// character once in the order it first does, those the font lacks left
    /// out; or the first glyph that cannot be read.
    pub fn glyphs(&self, text: &[u16]) -> wire::EmbossGlyphsReply {
        let mut glyphs = Vec::new();
        for code_point in code_points(text) {
            match self.outline(code_point) {
                Err(unreadable) => return wire::EmbossGlyphsReply::Refused(unreadable.refusal()),
                Ok(None) => {}
                Ok(Some(outline)) => glyphs.push(wire::GlyphOutline {
                    code_point: u64::from(code_point),
                    advance: outline.advance,
                    contours: outline
                        .contours
                        .into_iter()
                        .map(|contour| contour.into_iter().map(|p| p.to_vec()).collect())
                        .collect(),
                }),
            }
        }
        wire::EmbossGlyphsReply::Glyphs(wire::GlyphFont {
            units_per_em: f64::from(self.units_per_em),
            glyphs,
        })
    }
}

/// The code points a cut of [text] looks up, each once, in the order it
/// first does (`embossCodePoints`): line by line, a lone surrogate standing
/// for itself.
pub fn code_points(text: &[u16]) -> Vec<u32> {
    let mut seen = HashSet::new();
    let mut order = Vec::new();
    for line in text.split(|&unit| unit == 0x0a) {
        for unit in char::decode_utf16(line.iter().copied()) {
            let code_point = match unit {
                Ok(c) => u32::from(c),
                Err(error) => u32::from(error.unpaired_surrogate()),
            };
            if seen.insert(code_point) {
                order.push(code_point);
            }
        }
    }
    order
}

fn read_advances(
    bytes: &[u8],
    hhea: u64,
    hmtx: u64,
    glyph_count: u16,
) -> Result<Vec<u16>, Unreadable> {
    let metrics = Reader::at(bytes, hhea + 34).u16()?;
    let mut reader = Reader::at(bytes, hmtx);
    let mut advances = Vec::with_capacity(usize::from(glyph_count));
    for _ in 0..metrics.min(glyph_count) {
        advances.push(reader.u16()?);
        reader.i16()?; // left side bearing
    }
    // Remaining glyphs reuse the final advance, as the format specifies.
    let last = advances.last().copied().unwrap_or(0);
    advances.resize(usize::from(glyph_count), last);
    Ok(advances)
}

/// `readCmap`: the best encoding record's subtable, read but not expanded.
fn read_cmap(bytes: &[u8], offset: u64) -> Result<Cmap, Unreadable> {
    let mut reader = Reader::at(bytes, offset + 2);
    let record_count = reader.u16()?;
    let mut best: Option<u64> = None;
    let mut best_score = -1;
    for _ in 0..record_count {
        let platform = reader.u16()?;
        let encoding = reader.u16()?;
        let subtable = u64::from(reader.u32()?);
        // Prefer full Unicode (3,10), then BMP (3,1), then any Unicode platform.
        let score = match (platform, encoding) {
            (3, 10) => 3,
            (3, 1) => 2,
            (0, _) => 1,
            _ => 0,
        };
        if score > best_score {
            best_score = score;
            best = Some(offset + subtable);
        }
    }
    let Some(best) = best else {
        return Ok(Cmap::None);
    };
    let mut subtable = Reader::at(bytes, best);
    let format = subtable.u16()?;
    match format {
        4 => {
            subtable.offset = best + 6;
            let seg_count_x2 = u64::from(subtable.u16()?);
            let ends_at = best + 14;
            let starts_at = ends_at + seg_count_x2 + 2;
            let deltas_at = starts_at + seg_count_x2;
            let ranges_at = deltas_at + seg_count_x2;
            let mut segments = Vec::new();
            // `segment < segCountX2 / 2`: an odd count reads one segment more.
            for segment in 0..seg_count_x2.div_ceil(2) {
                let end = Reader::at(bytes, ends_at + segment * 2).u16()?;
                let start = Reader::at(bytes, starts_at + segment * 2).u16()?;
                let delta = Reader::at(bytes, deltas_at + segment * 2).i16()?;
                let range_offset = Reader::at(bytes, ranges_at + segment * 2).u16()?;
                if start > end {
                    continue;
                }
                segments.push(Segment {
                    end: u32::from(end),
                    start: u32::from(start),
                    delta: i64::from(delta),
                    range_offset: u64::from(range_offset),
                    at: ranges_at + segment * 2,
                });
            }
            Ok(Cmap::Format4(segments))
        }
        12 => {
            subtable.offset = best + 12;
            let group_count = subtable.u32()?;
            let mut groups = Vec::new();
            for _ in 0..group_count {
                let start = u64::from(subtable.u32()?);
                let end = u64::from(subtable.u32()?);
                let start_glyph = u64::from(subtable.u32()?);
                groups.push(Group {
                    start,
                    end,
                    start_glyph,
                });
            }
            Ok(Cmap::Format12(groups))
        }
        _ => Err(Unreadable(format!(
            "This font uses cmap format {format}, which OrcaXR cannot read"
        ))),
    }
}

fn simple_glyph(
    reader: &mut Reader<'_>,
    contour_count: u16,
    budget: &mut Budget,
) -> Result<Vec<Vec<[f64; 2]>>, Unreadable> {
    let mut end_points = Vec::with_capacity(usize::from(contour_count));
    for _ in 0..contour_count {
        end_points.push(u32::from(reader.u16()?));
    }
    let point_count = end_points.last().map_or(0, |&last| last as usize + 1);
    if point_count == 0 {
        return Ok(Vec::new());
    }
    // The last contour ends at the last point; one ending beyond it would
    // read points the glyph does not have.
    if end_points.iter().any(|&end| end as usize >= point_count) {
        return Err(Unreadable::new(
            "This font has a glyph whose contours are out of order",
        ));
    }
    let instructions = reader.u16()?;
    reader.offset += u64::from(instructions);

    let mut flags = Vec::with_capacity(point_count);
    while flags.len() < point_count {
        let flag = reader.u8()?;
        flags.push(flag);
        if flag & REPEAT != 0 {
            let repeats = reader.u8()?;
            for _ in 0..repeats {
                if flags.len() >= point_count {
                    break;
                }
                flags.push(flag);
            }
        }
    }
    let mut xs = Vec::with_capacity(point_count);
    let mut x = 0.0f64;
    for &flag in &flags {
        if flag & X_SHORT != 0 {
            let sign = if flag & X_SAME_OR_POSITIVE != 0 {
                1.0
            } else {
                -1.0
            };
            x += sign * f64::from(reader.u8()?);
        } else if flag & X_SAME_OR_POSITIVE == 0 {
            x += f64::from(reader.i16()?);
        }
        xs.push(x);
    }
    let mut ys = Vec::with_capacity(point_count);
    let mut y = 0.0f64;
    for &flag in &flags {
        if flag & Y_SHORT != 0 {
            let sign = if flag & Y_SAME_OR_POSITIVE != 0 {
                1.0
            } else {
                -1.0
            };
            y += sign * f64::from(reader.u8()?);
        } else if flag & Y_SAME_OR_POSITIVE == 0 {
            y += f64::from(reader.i16()?);
        }
        ys.push(y);
    }

    let mut contours = Vec::new();
    let mut start = 0usize;
    for &end in &end_points {
        let end = end as usize;
        if end < start {
            start = end + 1;
            continue;
        }
        let points: Vec<([f64; 2], bool)> = (start..=end)
            .map(|index| ([xs[index], ys[index]], flags[index] & ON_CURVE != 0))
            .collect();
        let flattened = flatten_quadratic_contour(&points);
        budget.spend(flattened.len())?;
        if flattened.len() >= 3 {
            contours.push(flattened);
        }
        start = end + 1;
    }
    Ok(contours)
}

/// TrueType contours alternate on- and off-curve points, with an implied
/// on-curve midpoint between consecutive off-curve points: every quadratic
/// flattened to line segments (`flattenQuadraticContour`).
fn flatten_quadratic_contour(points: &[([f64; 2], bool)]) -> Vec<[f64; 2]> {
    if points.is_empty() {
        return Vec::new();
    }
    let count = points.len();
    let mut out = Vec::new();
    // Start from an on-curve point so the walk is unambiguous.
    let (mut current, start_index) = match points.iter().position(|&(_, on)| on) {
        Some(index) => (points[index].0, index + 1),
        None => {
            // An all-off-curve contour starts at the midpoint of the last and first.
            let first = points[0].0;
            let last = points[count - 1].0;
            ([(first[0] + last[0]) / 2.0, (first[1] + last[1]) / 2.0], 0)
        }
    };
    out.push(current);
    let mut control: Option<[f64; 2]> = None;
    for step in 0..count {
        let (point, on_curve) = points[(start_index + step) % count];
        if on_curve {
            match control.take() {
                Some(c) => append_quadratic(&mut out, current, c, point),
                None => out.push(point),
            }
            current = point;
            continue;
        }
        if let Some(c) = control {
            // Two off-curve points in a row imply an on-curve midpoint.
            let midpoint = [(c[0] + point[0]) / 2.0, (c[1] + point[1]) / 2.0];
            append_quadratic(&mut out, current, c, midpoint);
            current = midpoint;
        }
        control = Some(point);
    }
    if let Some(c) = control {
        let first = out[0];
        append_quadratic(&mut out, current, c, first);
    }
    out
}

fn append_quadratic(out: &mut Vec<[f64; 2]>, from: [f64; 2], control: [f64; 2], to: [f64; 2]) {
    for step in 1..=CURVE_SEGMENTS {
        let t = f64::from(step) / f64::from(CURVE_SEGMENTS);
        let inverse = 1.0 - t;
        out.push([
            inverse * inverse * from[0] + 2.0 * inverse * t * control[0] + t * t * to[0],
            inverse * inverse * from[1] + 2.0 * inverse * t * control[1] + t * t * to[1],
        ]);
    }
}

/// A font file read for a host: the font, or why it cannot be read.
pub struct ReadFont {
    outcome: Result<Font, wire::EmbossRefusal>,
}

/// `readEmbossFontWire`: an `EmbossFontRequest` and the font file's bytes.
pub fn read(request: &wire::EmbossFontRequest, bytes: Vec<u8>) -> ReadFont {
    ReadFont {
        outcome: Font::read(bytes, request.collection).map_err(|unreadable| unreadable.refusal()),
    }
}

impl ReadFont {
    /// `EmbossFontReply`: the font's summary, or the refusal.
    pub fn reply(&self) -> wire::EmbossFontReply {
        match &self.outcome {
            Ok(font) => wire::EmbossFontReply::Read(font.summary()),
            Err(refusal) => wire::EmbossFontReply::Refused(refusal.clone()),
        }
    }

    /// The font, when it could be read.
    pub fn font(&self) -> Option<&Font> {
        self.outcome.as_ref().ok()
    }
}
