use crate::Text;
use serde::{Deserialize, Serialize};

pub const INDEX_BYTE_BUDGET: usize = 64 * 1024 * 1024;
pub const PREVIEW_WINDOW_RECORDS: usize = 240_000;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub mod kind {
    pub const NOOP: u8 = 0;
    pub const RETRACT: u8 = 1;
    pub const UNRETRACT: u8 = 2;
    pub const TOOL_CHANGE: u8 = 4;
    pub const COLOR_CHANGE: u8 = 5;
    pub const PAUSE: u8 = 6;
    pub const CUSTOM: u8 = 7;
    pub const TRAVEL: u8 = 8;
    pub const WIPE: u8 = 9;
    pub const EXTRUDE: u8 = 10;
    pub const LAYER_CHANGE: u8 = 11;
    pub const WIPE_START: u8 = 12;
    pub const WIPE_END: u8 = 13;
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub input_characters: usize,
    pub lines: usize,
    pub records: usize,
    pub path_points: usize,
    pub warnings: usize,
    pub line_characters: usize,
    pub roles: usize,
    pub filaments: usize,
}
impl Default for Limits {
    fn default() -> Self {
        Self {
            input_characters: 256 * 1024 * 1024,
            lines: 16_000_000,
            records: 4_000_000,
            path_points: 8_000_000,
            warnings: 2_048,
            line_characters: 64 * 1024,
            roles: 512,
            filaments: 4_096,
        }
    }
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RequestedLimits {
    pub input_characters: Option<f64>,
    pub lines: Option<f64>,
    pub records: Option<f64>,
    pub path_points: Option<f64>,
    pub warnings: Option<f64>,
    pub line_characters: Option<f64>,
    pub roles: Option<f64>,
    pub filaments: Option<f64>,
}
impl RequestedLimits {
    pub fn resolve(&self) -> Result<Limits, ParseError> {
        let hard = Limits::default();
        let clamp = |value: Option<f64>, cap: usize| {
            let value = value.unwrap_or(cap as f64);
            if !value.is_finite()
                || value.fract() != 0.0
                || !(1.0..=9_007_199_254_740_991.0).contains(&value)
            {
                Err(ParseError::InvalidLimits)
            } else {
                Ok(value.min(cap as f64) as usize)
            }
        };
        Ok(Limits {
            input_characters: clamp(self.input_characters, hard.input_characters)?,
            lines: clamp(self.lines, hard.lines)?,
            records: clamp(self.records, hard.records)?,
            path_points: clamp(self.path_points, hard.path_points)?,
            warnings: clamp(self.warnings, hard.warnings)?,
            line_characters: clamp(self.line_characters, hard.line_characters)?,
            roles: clamp(self.roles, hard.roles)?,
            filaments: clamp(self.filaments, hard.filaments)?,
        })
    }
}

#[derive(Debug, Default, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Options {
    #[serde(default)]
    pub limits: RequestedLimits,
    #[serde(default)]
    pub filament_diameters_mm: Vec<f64>,
    #[serde(default)]
    pub filament_colors: Vec<Text>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseError {
    Cancelled,
    InvalidLimits,
    InvalidFilaments,
    InvalidWindow,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub severity: &'static str,
    pub code: &'static str,
    pub message: Text,
    pub line: usize,
    pub start_offset: usize,
    pub end_offset: usize,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum Termination {
    InputCap,
    LineCap,
    RecordCap,
    PathPointCap,
    NumericCap,
    IndexCap,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Filament {
    pub id: u16,
    pub tool: u16,
    pub source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<Text>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    pub offset: usize,
    pub record_offset: usize,
    pub path_point_offset: u64,
    pub line: usize,
    pub x: f64,
    pub y: f64,
    pub z: f64,
    pub e: f64,
    pub origin_x: f64,
    pub origin_y: f64,
    pub origin_z: f64,
    pub origin_e: f64,
    pub units_to_mm: f64,
    pub global_relative: bool,
    pub extruder_relative: bool,
    pub feedrate_mm_per_second: f64,
    pub fan_percent: f64,
    pub forced_width_mm: f64,
    pub forced_height_mm: f64,
    pub current_width_mm: f64,
    pub current_height_mm: f64,
    pub extruded_last_z: f64,
    pub role: u16,
    pub tool: u16,
    pub filament: u16,
    pub layer_count: u32,
    pub wiping: bool,
    pub default_color_index: usize,
    pub roles: Vec<Text>,
    pub filaments: Vec<Filament>,
    pub tool_filaments: Vec<(u16, u16)>,
    pub hotend_temperatures: Vec<f64>,
}

impl Default for Checkpoint {
    fn default() -> Self {
        Self {
            offset: 0,
            record_offset: 0,
            path_point_offset: 0,
            line: 1,
            x: 0.0,
            y: 0.0,
            z: 0.0,
            e: 0.0,
            origin_x: 0.0,
            origin_y: 0.0,
            origin_z: 0.0,
            origin_e: 0.0,
            units_to_mm: 1.0,
            global_relative: false,
            extruder_relative: false,
            feedrate_mm_per_second: 0.0,
            fan_percent: 0.0,
            forced_width_mm: 0.0,
            forced_height_mm: 0.0,
            current_width_mm: 0.0,
            current_height_mm: 0.0,
            extruded_last_z: 0.0,
            role: 0,
            tool: 0,
            filament: 0,
            layer_count: 0,
            wiping: false,
            default_color_index: 0,
            roles: vec!["Undefined".into()],
            filaments: vec![],
            tool_filaments: vec![],
            hotend_temperatures: vec![0.0; 256],
        }
    }
}

#[derive(Debug, Default, Serialize)]
pub struct PathPoints {
    pub count: usize,
    pub x: Vec<f32>,
    pub y: Vec<f32>,
    pub z: Vec<f32>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub record_offset: Option<usize>,
    pub columns: Columns,
    pub path_points: PathPoints,
    pub roles: Vec<Text>,
    pub filaments: Vec<Filament>,
    pub layer_count: u32,
    pub warnings: Vec<Warning>,
    pub source_length: usize,
    pub parsed_characters: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source_line_offset: Option<usize>,
    pub parsed_lines: usize,
    pub complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<Termination>,
    pub limits: Limits,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexEntry {
    pub layer: u32,
    pub start_offset: usize,
    pub end_offset_exclusive: usize,
    pub records_before: usize,
    pub path_points_before: u64,
    pub checkpoint: Checkpoint,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Index {
    pub(crate) entries: Vec<IndexEntry>,
    pub layer_count: u32,
    pub record_count: usize,
    pub path_point_count: u64,
    pub source_length: usize,
    pub warnings: Vec<Warning>,
    pub complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub termination_reason: Option<Termination>,
    pub limits: Limits,
    // Retaining immutable source ownership prevents a checkpoint being applied
    // to replacement text. This field never crosses a transport boundary.
    #[serde(skip)]
    pub(crate) source: std::sync::Arc<[u16]>,
}
impl Index {
    pub fn entries(&self) -> &[IndexEntry] {
        &self.entries
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub(crate) struct Location {
    pub line: usize,
    pub start: usize,
    pub end: usize,
    pub command_line: i32,
}

#[derive(Debug)]
pub(crate) struct Record {
    pub kind: u8,
    pub start: [f64; 3],
    pub end: [f64; 3],
    pub delta_e: f64,
    pub feedrate: f64,
    pub width: f64,
    pub height: f64,
    pub mm3_per_mm: f64,
    pub flow: f64,
    pub fan: f64,
    pub temperature: f64,
    pub layer: u32,
    pub role: u16,
    pub tool: u16,
    pub filament: u16,
    pub source: Location,
    pub path_kind: u8,
    pub points: PathPoints,
    pub center: [f64; 2],
}
impl Record {
    pub fn finite(&self) -> bool {
        self.start
            .iter()
            .chain(self.end.iter())
            .chain(self.center.iter())
            .copied()
            .chain([
                self.delta_e,
                self.feedrate,
                self.width,
                self.height,
                self.mm3_per_mm,
                self.flow,
                self.fan,
                self.temperature,
            ])
            .all(crate::finite_f32)
    }
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Columns {
    pub count: usize,
    pub kind: Vec<u8>,
    pub start_x: Vec<f32>,
    pub start_y: Vec<f32>,
    pub start_z: Vec<f32>,
    pub end_x: Vec<f32>,
    pub end_y: Vec<f32>,
    pub end_z: Vec<f32>,
    pub delta_e: Vec<f32>,
    pub feedrate_mm_per_second: Vec<f32>,
    pub width_mm: Vec<f32>,
    pub height_mm: Vec<f32>,
    pub mm3_per_mm: Vec<f32>,
    pub volumetric_flow_mm3_per_second: Vec<f32>,
    pub fan_percent: Vec<f32>,
    pub hotend_temperature_c: Vec<f32>,
    pub layer: Vec<u32>,
    pub role: Vec<u16>,
    pub tool: Vec<u16>,
    pub filament: Vec<u16>,
    pub source_line: Vec<u32>,
    pub source_start_offset: Vec<u32>,
    pub source_end_offset: Vec<u32>,
    pub command_line_number: Vec<i32>,
    pub path_kind: Vec<u8>,
    pub path_point_offset: Vec<u32>,
    pub path_point_count: Vec<u32>,
    pub arc_center_x: Vec<f32>,
    pub arc_center_y: Vec<f32>,
}
impl Columns {
    pub(crate) fn push(&mut self, value: &Record, path_offset: usize, maximum: usize) {
        // Reserve uniformly and never double a column past the caller's cap.
        macro_rules! push {
            ($field:ident, $value:expr) => {{
                if self.$field.len() == self.$field.capacity() {
                    let next = (self.$field.capacity().max(512) * 2).min(maximum);
                    self.$field.reserve_exact(next - self.$field.len());
                }
                self.$field.push($value);
            }};
        }
        push!(kind, value.kind);
        push!(start_x, value.start[0] as f32);
        push!(start_y, value.start[1] as f32);
        push!(start_z, value.start[2] as f32);
        push!(end_x, value.end[0] as f32);
        push!(end_y, value.end[1] as f32);
        push!(end_z, value.end[2] as f32);
        push!(delta_e, value.delta_e as f32);
        push!(feedrate_mm_per_second, value.feedrate as f32);
        push!(width_mm, value.width as f32);
        push!(height_mm, value.height as f32);
        push!(mm3_per_mm, value.mm3_per_mm as f32);
        push!(volumetric_flow_mm3_per_second, value.flow as f32);
        push!(fan_percent, value.fan as f32);
        push!(hotend_temperature_c, value.temperature as f32);
        push!(layer, value.layer);
        push!(role, value.role);
        push!(tool, value.tool);
        push!(filament, value.filament);
        push!(source_line, value.source.line as u32);
        push!(source_start_offset, value.source.start as u32);
        push!(source_end_offset, value.source.end as u32);
        push!(command_line_number, value.source.command_line);
        push!(path_kind, value.path_kind);
        push!(path_point_offset, path_offset as u32);
        push!(path_point_count, value.points.count as u32);
        push!(arc_center_x, value.center[0] as f32);
        push!(arc_center_y, value.center[1] as f32);
        self.count += 1;
    }
}
