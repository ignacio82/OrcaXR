//! `PrintToolMapping.ts` and `MoonrakerFilamentSlots.ts`: which tools a sliced
//! artifact selects and the per-tool filament it declares, what the printer
//! reports as loaded, and whether sending would print with a wrong or absent
//! filament.
//!
//! The browser runs two regular expressions over the whole G-code string;
//! [`ToolUsageScanner`] runs the same patterns over the artifact's bytes as
//! they arrive, decoded as `TextDecoder` decodes them, so a host never holds
//! the program as text. `/^T(\d+)\b/gm` counts a tool at a line start when its
//! digits are followed by a non-word character or the end, below the sentinel
//! 64; `^;\s*key\s*=\s*(.*)$` (multiline, first match) takes a configuration
//! line, where `\s` also crosses line ends.
use crate::status::LIMITS;
use orcaxr_contracts::{
    canonical::{Value, parse_javascript},
    project_intent_types as wire,
};
use orcaxr_gcode::utf8::Utf8Decoder;
use orcaxr_project::js_math::convert::{is_space, number_to_string, trim_utf16};
use std::collections::BTreeSet;

/// Tool indices at or above this are slicer sentinels (`T255` parks the head).
const MAX_REAL_TOOL_INDEX: u64 = 64;
/// Slots a printer may report.
const MAX_FILAMENT_SLOTS: usize = 32;
/// The Snapmaker extension query that reports loaded filaments.
pub const SLOTS_QUERY_PATH: &str = "/printer/objects/query?print_task_config=&filament_detect=";

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn cat(parts: &[&[u16]]) -> Vec<u16> {
    parts.concat()
}
fn terminator(unit: u16) -> bool {
    matches!(unit, 0x0a | 0x0d | 0x2028 | 0x2029)
}
fn space(unit: u16) -> bool {
    char::from_u32(u32::from(unit)).is_some_and(is_space)
}
fn word(unit: u16) -> bool {
    matches!(unit, 0x30..=0x39 | 0x41..=0x5a | 0x61..=0x7a | 0x5f)
}

/// One `^;\s*key\s*=\s*(.*)$` search: at most one attempt is ever alive,
/// since a line-start `;` either fails it or (after `=`) begins its capture.
#[derive(Debug, Clone)]
enum Declaration {
    Idle,
    BeforeKey,
    Key(usize),
    BeforeEquals,
    AfterEquals,
    Capturing(Vec<u16>),
    Found(Vec<u16>),
}
#[derive(Debug, Clone)]
struct Matcher {
    key: Vec<u16>,
    state: Declaration,
}
impl Matcher {
    fn new(key: &str) -> Self {
        Self {
            key: units(key),
            state: Declaration::Idle,
        }
    }
    fn feed(&mut self, unit: u16, line_start: bool) {
        use Declaration::*;
        let next = match std::mem::replace(&mut self.state, Idle) {
            Found(capture) => Found(capture),
            Capturing(mut capture) => {
                if terminator(unit) {
                    Found(capture)
                } else {
                    capture.push(unit);
                    Capturing(capture)
                }
            }
            AfterEquals if space(unit) => AfterEquals,
            AfterEquals => Capturing(vec![unit]),
            BeforeKey if space(unit) => BeforeKey,
            BeforeKey if unit == self.key[0] => Key(1),
            Key(i) if unit == self.key[i] => {
                if i + 1 == self.key.len() {
                    BeforeEquals
                } else {
                    Key(i + 1)
                }
            }
            BeforeEquals if space(unit) => BeforeEquals,
            BeforeEquals if unit == u16::from(b'=') => AfterEquals,
            _ => Idle,
        };
        self.state = match next {
            Idle if line_start && unit == u16::from(b';') => BeforeKey,
            other => other,
        };
    }
    fn finish(self) -> Option<Vec<u16>> {
        match self.state {
            Declaration::Found(capture) | Declaration::Capturing(capture) => Some(capture),
            Declaration::AfterEquals => Some(Vec::new()),
            _ => None,
        }
    }
}

/// `summarizeGcodeToolUsage`, streamed.
#[derive(Debug)]
pub struct ToolUsageScanner {
    decoder: Utf8Decoder,
    line_start: bool,
    /// Inside `T<digits>` at a line start: the value so far (capped).
    tool: Option<Option<u64>>,
    tools: BTreeSet<u64>,
    colour: Matcher,
    color: Matcher,
    material: Matcher,
}
impl Default for ToolUsageScanner {
    fn default() -> Self {
        Self {
            decoder: Utf8Decoder::new(),
            line_start: true,
            tool: None,
            tools: BTreeSet::new(),
            colour: Matcher::new("filament_colour"),
            color: Matcher::new("filament_color"),
            material: Matcher::new("filament_type"),
        }
    }
}
impl ToolUsageScanner {
    pub fn new() -> Self {
        Self::default()
    }
    /// The next bytes of the artifact.
    pub fn append(&mut self, bytes: &[u8]) {
        let mut text = Vec::with_capacity(bytes.len());
        self.decoder.decode(bytes, false, &mut text);
        self.scan(&text);
    }
    fn scan(&mut self, text: &[u16]) {
        for &unit in text {
            if let Some(digits) = self.tool {
                if (0x30..=0x39).contains(&unit) {
                    let digit = u64::from(unit - 0x30);
                    let value = digits.unwrap_or(0).saturating_mul(10).saturating_add(digit);
                    self.tool = Some(Some(value.min(MAX_REAL_TOOL_INDEX)));
                } else {
                    self.end_tool(!word(unit));
                }
            } else if self.line_start && unit == u16::from(b'T') {
                self.tool = Some(None);
            }
            for matcher in [&mut self.colour, &mut self.color, &mut self.material] {
                matcher.feed(unit, self.line_start);
            }
            self.line_start = terminator(unit);
        }
    }
    fn end_tool(&mut self, boundary: bool) {
        if let Some(Some(value)) = self.tool.take()
            && boundary
            && value < MAX_REAL_TOOL_INDEX
        {
            self.tools.insert(value);
        }
    }
    /// The artifact ended: its usage.
    pub fn finish(mut self) -> wire::GcodeToolUsage {
        let mut rest = Vec::new();
        self.decoder.decode(&[], true, &mut rest);
        self.scan(&rest);
        self.end_tool(true);
        let list = |capture: Option<Vec<u16>>| -> Vec<Vec<u16>> {
            capture
                .map(|c| {
                    c.split(|u| *u == u16::from(b';'))
                        .map(|entry| trim_utf16(entry).to_vec())
                        .filter(|entry| !entry.is_empty())
                        .collect()
                })
                .unwrap_or_default()
        };
        let colors = self.colour.finish().or_else(|| self.color.finish());
        wire::GcodeToolUsage {
            multi_material: self.tools.len() > 1,
            tools: self.tools.into_iter().collect(),
            declared_colors: list(colors),
            declared_materials: list(self.material.finish()),
        }
    }
}

/// `String.prototype.toUpperCase` over UTF-16: full case mapping per code
/// point (`ß` → `SS`, `ﬀ` → `FF`); lone surrogates pass through.
fn upper(text: &[u16]) -> Vec<u16> {
    let mut out = Vec::with_capacity(text.len());
    for decoded in char::decode_utf16(text.iter().copied()) {
        match decoded {
            Ok(c) => {
                for u in c.to_uppercase() {
                    out.extend_from_slice(u.encode_utf16(&mut [0; 2]));
                }
            }
            Err(lone) => out.push(lone.unpaired_surrogate()),
        }
    }
    out
}
/// `safeLabel`: control characters dropped by code point, trimmed, then the
/// first 128 UTF-16 units (a pair may be split, as `slice` splits it).
fn safe_label(text: &[u16]) -> Vec<u16> {
    let kept: Vec<u16> = text
        .iter()
        .copied()
        .filter(|&u| u > 0x1f && u != 0x7f)
        .collect();
    let trimmed = trim_utf16(&kept);
    trimmed[..trimmed.len().min(128)].to_vec()
}
/// `normalizeFilamentMaterial`: the family a printer and the slicer agree on.
pub fn normalize_material(text: &[u16]) -> Vec<u16> {
    let material = upper(&safe_label(text));
    for known in ["PETG", "PLA", "ABS", "ASA", "TPU", "PVA"] {
        if material.starts_with(&units(known)) {
            return units(known);
        }
    }
    if material.starts_with(&units("PA")) {
        return units("PA");
    }
    if material.is_empty() {
        units("PLA")
    } else {
        material
    }
}
/// `normalizedColor`: the first six hex digits, else white.
fn slot_color(text: &[u16]) -> Vec<u16> {
    let trimmed = trim_utf16(text);
    let raw = trimmed.strip_prefix(&[u16::from(b'#')]).unwrap_or(trimmed);
    let hex = raw.len() >= 6
        && raw[..6]
            .iter()
            .all(|&u| (u as u8 as u16 == u) && (u as u8).is_ascii_hexdigit());
    let digits = if hex {
        raw[..6].to_vec()
    } else {
        units("FFFFFF")
    };
    [vec![u16::from(b'#')], upper(&digits)].concat()
}
/// `normalizeColor` (mapping): six or eight hex digits after uppercasing,
/// reported as the first six.
fn mapping_color(text: &[u16]) -> Option<Vec<u16>> {
    if text.is_empty() {
        return None;
    }
    let trimmed = trim_utf16(text);
    let hex = upper(trimmed.strip_prefix(&[u16::from(b'#')]).unwrap_or(trimmed));
    let valid =
        matches!(hex.len(), 6 | 8) && hex.iter().all(|&u| matches!(u, 0x30..=0x39 | 0x41..=0x46));
    valid.then(|| [vec![u16::from(b'#')], hex[..6].to_vec()].concat())
}

fn field<'a>(value: Option<&'a Value>, name: &str) -> Option<&'a Value> {
    match value {
        Some(Value::Object(fields)) => fields.get(&units(name)),
        _ => None,
    }
}
fn record(value: Option<&Value>) -> Option<&Value> {
    value.filter(|v| matches!(v, Value::Object(_)))
}
fn scalars(value: Option<&Value>) -> Option<&[Value]> {
    match value {
        Some(Value::Array(items)) if items.len() <= MAX_FILAMENT_SLOTS * 4 => Some(items),
        _ => None,
    }
}
/// `stringLikeArray`: every entry a string or number, read as `String`.
fn string_like(value: Option<&Value>) -> Option<Vec<Vec<u16>>> {
    scalars(value)?
        .iter()
        .map(|entry| match entry {
            Value::String(s) => Some(s.clone()),
            Value::Number(n) => Some(units(&number_to_string(*n))),
            _ => None,
        })
        .collect()
}
fn loaded(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => *n == 1.0,
        Value::String(s) => *s == units("1") || *s == units("true"),
        _ => false,
    }
}

/// `parseMoonrakerFilamentSlots` over the query's reply text.
pub fn filament_slots(text: &str) -> wire::FilamentSlotsReply {
    let Ok(result) = parse_javascript(text, LIMITS) else {
        return wire::FilamentSlotsReply::InvalidResponse(wire::Empty {});
    };
    let config = record(field(
        record(field(Some(&result), "status")),
        "print_task_config",
    ));
    let Some(colors) = config.and_then(|c| string_like(field(Some(c), "filament_color_rgba")))
    else {
        return wire::FilamentSlotsReply::InvalidResponse(wire::Empty {});
    };
    let types = string_like(field(config, "filament_type"));
    let sub_types = string_like(field(config, "filament_sub_type"));
    let vendors = string_like(field(config, "filament_vendor"));
    let exists = scalars(field(config, "filament_exist"));
    let at = |list: &Option<Vec<Vec<u16>>>, i: usize| {
        list.as_ref()
            .and_then(|l| l.get(i))
            .cloned()
            .unwrap_or_default()
    };
    let mut slots = Vec::new();
    for index in 0..colors.len().min(MAX_FILAMENT_SLOTS) {
        if exists.is_some_and(|e| index < e.len() && !loaded(&e[index])) {
            continue;
        }
        let sub_type = safe_label(&at(&sub_types, index));
        slots.push(wire::MoonrakerFilamentSlot {
            slot_index: index as u64,
            color_hex: slot_color(&colors[index]),
            material: normalize_material(&at(&types, index)),
            sub_type: if sub_type.is_empty() {
                wire::OptionalText::Absent(wire::Empty {})
            } else {
                wire::OptionalText::Value(sub_type)
            },
            vendor: safe_label(&at(&vendors, index)),
        });
    }
    wire::FilamentSlotsReply::Slots(slots)
}

/// `validateToolMapping`: a tool with no loaded slot blocks the send; a
/// material family or colour difference is a warning, since only the operator
/// knows whether a spool was swapped unnoticed.
pub fn mapping(request: &wire::ToolMappingRequest) -> wire::ToolMappingReport {
    let usage = &request.usage;
    let mut blockers = Vec::new();
    let mut warnings = Vec::new();
    let notice = |code, message: Vec<u16>, tool: Option<u64>| wire::ToolMappingNotice {
        code,
        message,
        tool_index: match tool {
            Some(t) => wire::OptionalCounter::Value(t),
            None => wire::OptionalCounter::Absent(wire::Empty {}),
        },
    };
    let slots = match &request.slots {
        wire::OptionalMoonrakerFilamentSlots::Value(slots) if !slots.is_empty() => slots,
        _ => {
            if usage.multi_material {
                warnings.push(notice(
                    wire::ToolMappingNoticeCode::SlotsUnknown,
                    units(&format!(
                        "This artifact uses {} tools, but the printer did not report its loaded filaments; verify the slots yourself before printing.",
                        usage.tools.len()
                    )),
                    None,
                ));
            }
            return wire::ToolMappingReport { blockers, warnings };
        }
    };
    for &tool in &usage.tools {
        // `new Map(...)`: the last slot reported for an index wins.
        let Some(slot) = slots.iter().rev().find(|s| s.slot_index == tool) else {
            blockers.push(notice(
                wire::ToolMappingNoticeCode::MissingSlot,
                units(&format!(
                    "The artifact prints with tool T{tool}, but the printer reports no filament loaded in slot {}.",
                    tool + 1
                )),
                Some(tool),
            ));
            continue;
        };
        let declared = usage.declared_materials.get(tool as usize);
        if let Some(material) = declared.filter(|m| !m.is_empty())
            && !slot.material.is_empty()
            && normalize_material(material) != normalize_material(&slot.material)
        {
            warnings.push(notice(
                wire::ToolMappingNoticeCode::MaterialMismatch,
                cat(&[
                    &units(&format!("T{tool} was sliced for ")),
                    material,
                    &units(&format!(", but slot {} holds ", tool + 1)),
                    &slot.material,
                    &units("."),
                ]),
                Some(tool),
            ));
        }
        let color = usage
            .declared_colors
            .get(tool as usize)
            .and_then(|c| mapping_color(c));
        let slot_color = mapping_color(&slot.color_hex);
        if let (Some(color), Some(slot_color)) = (color, slot_color)
            && color != slot_color
        {
            warnings.push(notice(
                wire::ToolMappingNoticeCode::ColorMismatch,
                cat(&[
                    &units(&format!("T{tool} was sliced as ")),
                    &color,
                    &units(&format!(", but slot {} holds ", tool + 1)),
                    &slot_color,
                    &units("."),
                ]),
                Some(tool),
            ));
        }
    }
    wire::ToolMappingReport { blockers, warnings }
}
