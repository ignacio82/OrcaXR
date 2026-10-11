//! The bed the workspace places models on (`WorkspaceBed.ts`, through
//! `WorkspaceBedExchange.ts`), read from a project configuration exactly as
//! the browser reads it:
//!
//! - the bed size is the far corner of `printable_area` — the polygon as the
//!   profile's flattened text (a string as is, a list of strings joined with
//!   commas, anything else empty), split on `,` and `x` and read with
//!   `Number` (`bedSizeFromProfile`), else 200 mm a side. The workspace draws
//!   the plate from the bed corner to it and maps, places, centres, scales to
//!   fit and arranges on it;
//! - the printable area is the rectangle the polygon encloses
//!   (`printableAreaRect`), whose origin a printer may offset from the bed
//!   corner;
//! - the printable height is `parseFloat(String(printable_height))` (its
//!   first entry for a list) when positive;
//! - the placement area, where models are placed, centred, arranged and
//!   filled, is the printable rectangle the slice preflight checks, read from
//!   the configuration's engine strings exactly as the preflight reads it
//!   ([`preflight_printable_area`]); where the preflight finds none (and
//!   refuses to slice), the printable area, else the bed from its corner;
//! - the build volume scale-to-fit fills is the placement area from the bed
//!   (Z = 0) up to the printable height the preflight checks
//!   ([`preflight_printable_height`]), else the workspace's; none without a
//!   height. A placement on it never leaves the volume the preflight accepts;
//! - an enabled wipe tower keeps a square of its drawn width
//!   (`Number(prime_tower_width ?? wipe_tower_width) || 60`) clear when its
//!   plate is arranged or filled.
//!
//! The exchange is canonical JSON: `{"config","wipeTower"}` answers
//! `{"areaMm","keepOut","printableArea","printableHeightMm","sizeMm","volumeMm"}`
//! (the volume as `{"maxMm","minMm"}` corners), an absent value (or a
//! keep-out edge JSON cannot carry) `null`. A session's project answers
//! for one of its plates ([`state_bed_json`]) from the configuration the
//! workspace reads: its base profile when it records one, else its own.
use super::wipe_tower::printable_area;
use super::{Area, Volume};
use crate::js_math::{
    self,
    convert::{parse_float, utf16_number, value_to_number, value_to_string},
};
use crate::model::{ProjectState, WipeTowerState};
use crate::slicing::profile::{
    WireConfig, engine_wire_value, preflight_printable_area, preflight_printable_height,
};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;

/// The plate a configuration without a printable area gets (mm a side).
pub const DEFAULT_BED_MM: f64 = 200.0;
/// The tower width a configuration without a usable one gets (mm).
pub const DEFAULT_TOWER_WIDTH_MM: f64 = 60.0;
/// A request that is not the documented shape.
pub const INVALID_REQUEST: &str = "invalid_request";
/// A request longer than the canonical parser's bound.
pub const INPUT_LIMIT: &str = "input_limit";
/// A reply that could not be written.
pub const OUTPUT_LIMIT: &str = "output_limit";

/// The printable rectangle (`AabbXY`), in printer millimetres.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PrintableArea {
    pub x_min: f64,
    pub y_min: f64,
    pub x_max: f64,
    pub y_max: f64,
}

/// A region arranging keeps clear (`ArrangeRegion`).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct KeepOut {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}

/// The workspace's bed from a project configuration.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct WorkspaceBed {
    /// Width and depth (mm): the printable area's far corner, or 200 × 200.
    pub size_mm: [f64; 2],
    pub printable_area: Option<PrintableArea>,
    pub printable_height_mm: Option<f64>,
    /// Where models are placed, centred, arranged and filled: the
    /// preflight's printable rectangle, else the printable area, else the bed.
    pub area_mm: Area,
    /// The box scale-to-fit fills: the placement area from the bed up to the
    /// printable height; none without a height.
    pub volume_mm: Option<Volume>,
}

const COMMA: u16 = b',' as u16;
const X: u16 = b'x' as u16;

/// An own configuration value; JSON null included (it is not `undefined`).
fn field<'a>(config: &'a Value, name: &str) -> Option<&'a Value> {
    match config {
        Value::Object(fields) => fields.get(&name.encode_utf16().collect::<Vec<u16>>()),
        _ => None,
    }
}

/// `printableAreaText`: a string as is, a list of strings joined with commas, else empty.
pub fn printable_area_text(value: Option<&Value>) -> Vec<u16> {
    match value {
        Some(Value::String(units)) => units.clone(),
        Some(Value::Array(items)) => {
            let mut text = Vec::new();
            for (index, item) in items.iter().enumerate() {
                let Value::String(units) = item else {
                    return Vec::new();
                };
                if index > 0 {
                    text.push(COMMA);
                }
                text.extend_from_slice(units);
            }
            text
        }
        _ => Vec::new(),
    }
}

/// `bedSizeFromProfile` over the flattened text: the largest finite `x` and
/// `y` of its `,`-separated `XxY` points, each falling back to 200 when zero.
pub fn bed_size(text: &[u16]) -> [f64; 2] {
    if text.is_empty() {
        return [DEFAULT_BED_MM; 2];
    }
    let (mut max_x, mut max_y) = (0.0f64, 0.0f64);
    for point in text.split(|unit| *unit == COMMA) {
        let mut parts = point.split(|unit| *unit == X);
        let x = parts.next().map_or(f64::NAN, utf16_number);
        let y = parts.next().map_or(f64::NAN, utf16_number);
        if x.is_finite() {
            max_x = js_math::max(max_x, x);
        }
        if y.is_finite() {
            max_y = js_math::max(max_y, y);
        }
    }
    // `maxX || 200`: zero (either sign) falls back; NaN cannot occur.
    let or_default = |value: f64| if value == 0.0 { DEFAULT_BED_MM } else { value };
    [or_default(max_x), or_default(max_y)]
}

/// `printableHeightMm`: `parseFloat(String(raw[0] or raw ?? ''))` when positive.
pub fn printable_height_mm(config: &Value) -> Option<f64> {
    let text: Vec<u16> = match field(config, "printable_height") {
        Some(Value::Array(items)) => match items.first() {
            Some(first) => value_to_string(first),
            None => "undefined".encode_utf16().collect(),
        },
        None | Some(Value::Null) => Vec::new(),
        Some(value) => value_to_string(value),
    };
    // A lone surrogate is neither whitespace nor a digit, as U+FFFD is not.
    let height = parse_float(&String::from_utf16_lossy(&text));
    (height.is_finite() && height > 0.0).then_some(height)
}

/// `workspaceBed`.
pub fn workspace_bed(config: &Value) -> WorkspaceBed {
    let area = field(config, "printable_area");
    let size_mm = bed_size(&printable_area_text(area));
    let printable = printable_area(area);
    let printable_height_mm = printable_height_mm(config);
    // The two facts the preflight checks, from the engine strings it reads them from.
    let mut engine = WireConfig::new();
    for name in ["printable_area", "printable_height"] {
        let key = units(name);
        if let Some(text) = field(config, name).and_then(|value| engine_wire_value(&key, value)) {
            engine.insert(key, text);
        }
    }
    let [x_min, y_min, x_max, y_max] = preflight_printable_area(&engine)
        .or(printable)
        .unwrap_or([0.0, 0.0, size_mm[0], size_mm[1]]);
    let area_mm = Area {
        x_min,
        y_min,
        x_max,
        y_max,
    };
    let top = preflight_printable_height(&engine).or(printable_height_mm);
    WorkspaceBed {
        size_mm,
        printable_area: printable.map(|[x_min, y_min, x_max, y_max]| PrintableArea {
            x_min,
            y_min,
            x_max,
            y_max,
        }),
        printable_height_mm,
        area_mm,
        volume_mm: top.map(|top| Volume {
            min: [x_min, y_min, 0.0],
            max: [x_max, y_max, top],
        }),
    }
}

/// `wipeTowerWidthMm`: `Number(prime_tower_width ?? wipe_tower_width) || 60`.
pub fn wipe_tower_width_mm(config: &Value) -> f64 {
    let prime = field(config, "prime_tower_width").filter(|v| !matches!(v, Value::Null));
    let width = value_to_number(prime.or_else(|| field(config, "wipe_tower_width")));
    if width == 0.0 || width.is_nan() {
        DEFAULT_TOWER_WIDTH_MM
    } else {
        width
    }
}

/// `wipeTowerKeepOut`: an enabled tower's square of its drawn width.
pub fn wipe_tower_keep_out(config: &Value, tower: Option<&WipeTowerState>) -> Option<KeepOut> {
    let tower = tower.filter(|tower| tower.enabled)?;
    let width = wipe_tower_width_mm(config);
    let [x, y] = tower.position_mm.map(|v| v.get());
    Some(KeepOut {
        min_x: x,
        min_y: y,
        max_x: x + width,
        max_y: y + width,
    })
}

// --- Exchange ------------------------------------------------------------------------------

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn number(value: f64) -> Value {
    if value.is_finite() {
        Value::Number(value)
    } else {
        Value::Null
    }
}
fn object(members: impl IntoIterator<Item = (&'static str, Value)>) -> Value {
    Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect())
}

/// The reply document for a bed and a keep-out.
pub fn reply(bed: &WorkspaceBed, keep_out: Option<KeepOut>) -> Value {
    let corner = |point: [f64; 3]| Value::Array(point.map(number).to_vec());
    let area = bed.area_mm;
    object([
        (
            "areaMm",
            object([
                ("xMax", number(area.x_max)),
                ("xMin", number(area.x_min)),
                ("yMax", number(area.y_max)),
                ("yMin", number(area.y_min)),
            ]),
        ),
        (
            "keepOut",
            keep_out.map_or(Value::Null, |k| {
                object([
                    ("maxX", number(k.max_x)),
                    ("maxY", number(k.max_y)),
                    ("minX", number(k.min_x)),
                    ("minY", number(k.min_y)),
                ])
            }),
        ),
        (
            "printableArea",
            bed.printable_area.map_or(Value::Null, |a| {
                object([
                    ("xMax", number(a.x_max)),
                    ("xMin", number(a.x_min)),
                    ("yMax", number(a.y_max)),
                    ("yMin", number(a.y_min)),
                ])
            }),
        ),
        (
            "printableHeightMm",
            bed.printable_height_mm.map_or(Value::Null, number),
        ),
        (
            "sizeMm",
            Value::Array(vec![number(bed.size_mm[0]), number(bed.size_mm[1])]),
        ),
        (
            "volumeMm",
            bed.volume_mm.map_or(Value::Null, |v| {
                object([("maxMm", corner(v.max)), ("minMm", corner(v.min))])
            }),
        ),
    ])
}

fn canonical(value: &Value) -> Result<String, &'static str> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .map_err(|_| OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| OUTPUT_LIMIT)
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

fn finite(value: Option<Value>) -> Result<f64, &'static str> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Ok(n),
        _ => Err(INVALID_REQUEST),
    }
}

/// A plate's wipe tower as a request carries it (`WipeTowerState`).
fn tower(value: Value) -> Result<Option<(bool, [f64; 2])>, &'static str> {
    if matches!(value, Value::Null) {
        return Ok(None);
    }
    let mut fields = members(
        value,
        &["enabled", "positionMm", "rotationDeg"],
        &["filamentId"],
    )?;
    let Some(Value::Bool(enabled)) = fields.remove(&units("enabled")) else {
        return Err(INVALID_REQUEST);
    };
    let Some(Value::Array(position)) = fields.remove(&units("positionMm")) else {
        return Err(INVALID_REQUEST);
    };
    let [x, y]: [Value; 2] = position.try_into().map_err(|_| INVALID_REQUEST)?;
    let position = [finite(Some(x))?, finite(Some(y))?];
    finite(fields.remove(&units("rotationDeg")))?;
    if let Some(filament) = fields.remove(&units("filamentId"))
        && !matches!(filament, Value::String(_))
    {
        return Err(INVALID_REQUEST);
    }
    Ok(Some((enabled, position)))
}

/// `workspaceBedExchange`: `{"config","wipeTower"}` → the bed document.
pub fn bed_json(request: &str) -> Result<String, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let request = parse(request).map_err(|_| INVALID_REQUEST)?;
    let mut fields = members(request, &["config", "wipeTower"], &[])?;
    let config = fields.remove(&units("config")).ok_or(INVALID_REQUEST)?;
    if !matches!(config, Value::Object(_)) {
        return Err(INVALID_REQUEST);
    }
    let tower = tower(fields.remove(&units("wipeTower")).ok_or(INVALID_REQUEST)?)?;
    let keep_out = tower.and_then(|(enabled, [x, y])| {
        let width = wipe_tower_width_mm(&config);
        enabled.then_some(KeepOut {
            min_x: x,
            min_y: y,
            max_x: x + width,
            max_y: y + width,
        })
    });
    canonical(&reply(&workspace_bed(&config), keep_out))
}

/// The configuration the workspace reads its bed from: the project's base
/// profile when it records one, else its configuration
/// (`getSlicingConfiguration().config`).
pub fn workspace_config(state: &ProjectState) -> &Value {
    state
        .settings_base_config
        .as_ref()
        .unwrap_or(&state.config)
        .value()
}

/// The bed of a project and the keep-out of plate `plate_id`'s tower (none for
/// no plate or an unknown one), as the bed document.
pub fn state_bed(state: &ProjectState, plate_id: Option<&[u16]>) -> Value {
    let config = workspace_config(state);
    let tower = plate_id.and_then(|id| {
        state
            .plates
            .iter()
            .find(|plate| plate.id.as_utf16() == id)
            .and_then(|plate| plate.wipe_tower.as_deref())
    });
    reply(&workspace_bed(config), wipe_tower_keep_out(config, tower))
}

/// `{"plateId": string | null}` → [`state_bed`] as canonical JSON.
pub fn state_bed_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let mut fields = members(
        parse(request).map_err(|_| INVALID_REQUEST)?,
        &["plateId"],
        &[],
    )?;
    let plate = match fields.remove(&units("plateId")) {
        Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id),
        _ => return Err(INVALID_REQUEST),
    };
    canonical(&state_bed(state, plate.as_deref()))
}
