use crate::{Cancellation, Limits, Model, Text, kind, layout, lexer, number};
use serde::{Deserialize, Serialize};
#[path = "preview_catalog.rs"]
mod catalog;
use catalog::*;

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModeDefinition {
    pub id: &'static str,
    pub label: &'static str,
    pub value_kind: &'static str,
    pub unit: Option<&'static str>,
    pub scale: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LayerTimes {
    pub seconds_by_layer: Vec<f32>,
    pub provenance: Text,
}
pub use crate::request_types::PreviewRequest;
impl<T> PreviewRequest<T> {
    pub(crate) fn map_layer_times(self, convert: impl FnOnce(T) -> LayerTimes) -> PreviewRequest {
        PreviewRequest {
            mode: self.mode,
            role_visibility: self.role_visibility,
            tool_visibility: self.tool_visibility,
            event_visibility: self.event_visibility,
            layer_range: self.layer_range,
            record_range: self.record_range,
            value_range: self.value_range,
            layer_times: self.layer_times.map(convert),
            max_projected_records: self.max_projected_records,
        }
    }
}
#[derive(Debug, Serialize)]
pub struct PreviewError {
    pub code: &'static str,
    pub message: Text,
}
impl PreviewError {
    pub(crate) fn new(code: &'static str, message: impl Into<Text>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MissingMetadata {
    pub key: &'static str,
    pub message: Text,
    pub indices: Vec<u32>,
    pub additional_count: usize,
}
#[derive(Debug, Serialize)]
pub struct Limitation {
    pub code: &'static str,
    pub message: Text,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LegendEntry {
    pub id: String,
    pub label: String,
    pub code: String,
    pub accessible_label: String,
    pub pattern: String,
    pub color: [f64; 4],
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewRange {
    pub min: f64,
    pub max: f64,
    pub unit: &'static str,
    pub scale: &'static str,
    pub sample_count: usize,
}
#[derive(Debug, Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
pub enum Preview {
    Unsupported {
        mode: ModeDefinition,
        source_record_count: usize,
        missing_metadata: Vec<MissingMetadata>,
        limitations: Vec<Limitation>,
    },
    Ready {
        mode: ModeDefinition,
        source_record_count: usize,
        count: usize,
        record_indices: Vec<u32>,
        values: Vec<f32>,
        value_valid: Vec<u8>,
        colors_rgba: Vec<f32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: Option<PreviewRange>,
        legend: Vec<LegendEntry>,
        limitations: Vec<Limitation>,
        #[serde(skip_serializing_if = "Option::is_none")]
        layer_time_provenance: Option<Text>,
    },
}
struct Request<'a> {
    mode: ModeDefinition,
    original: &'a PreviewRequest,
    first_layer: u32,
    last_layer: u32,
    first: usize,
    end: usize,
    maximum: usize,
}
fn err(code: &'static str, message: impl Into<Text>) -> PreviewError {
    PreviewError::new(code, message)
}
fn poll(cancel: &Cancellation, i: usize) -> Result<(), PreviewError> {
    if i.is_multiple_of(4096) && cancel.is_cancelled() {
        Err(err("cancelled", "Preview computation was cancelled"))
    } else {
        Ok(())
    }
}

pub fn project(
    model: &Model,
    request: &PreviewRequest,
    cancel: &Cancellation,
) -> Result<Preview, PreviewError> {
    poll(cancel, 0)?;
    validate_model(model, cancel)?;
    let request = validate_request(model, request)?;
    let limitations = limitations(model, cancel)?;
    let missing = find_missing(model, &request, cancel)?;
    if !missing.is_empty() {
        poll(cancel, 0)?;
        return Ok(Preview::Unsupported {
            mode: request.mode,
            source_record_count: model.columns.count,
            missing_metadata: missing,
            limitations,
        });
    }
    let mut count = 0;
    let mut value_count = 0;
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for i in request.first..request.end {
        poll(cancel, i)?;
        if !passes(model, &request, i) {
            continue;
        }
        if has_value(request.mode.id, model.columns.kind[i]) {
            let value = value(model, &request, i);
            if request
                .original
                .value_range
                .is_some_and(|[a, b]| value < a || value > b)
            {
                continue;
            }
            if request.mode.value_kind == "number" {
                let value = if request.mode.id == "VolumetricRate" {
                    bin(value)
                } else {
                    value
                };
                min = min.min(value);
                max = max.max(value);
                value_count += 1;
            }
        }
        count += 1;
    }
    if count > request.maximum {
        return Err(err(
            "projection-cap",
            format!(
                "Preview projection requires {count} records, exceeding the bounded limit of {}",
                request.maximum
            ),
        ));
    }
    let range = (value_count > 0 && request.mode.value_kind == "number").then_some(PreviewRange {
        min,
        max,
        unit: request.mode.unit.unwrap_or(""),
        scale: request.mode.scale,
        sample_count: value_count,
    });
    let mut indices = Vec::with_capacity(count);
    let mut values = Vec::with_capacity(count);
    let mut valid_values = Vec::with_capacity(count);
    let mut colors = Vec::with_capacity(count * 4);
    let mut categories = vec![
        false;
        match request.mode.id {
            "FeatureType" => 20,
            "Tool" => 256,
            "ColorPrint" => model.filaments.len(),
            "FilamentId" => 5120,
            _ => 1,
        }
    ];
    let mut events = [false; 14];
    for i in request.first..request.end {
        poll(cancel, i)?;
        if !passes(model, &request, i) {
            continue;
        }
        let kind = model.columns.kind[i];
        let valid = has_value(request.mode.id, kind);
        let value = if valid {
            value(model, &request, i)
        } else {
            0.0
        };
        if valid
            && request
                .original
                .value_range
                .is_some_and(|[a, b]| value < a || value > b)
        {
            continue;
        }
        indices.push(i as u32);
        values.push(value as f32);
        valid_values.push(u8::from(valid));
        let color = if valid {
            mode_color(model, request.mode.id, i, value, range.as_ref())
        } else {
            event_color(model, kind, i)
        };
        colors.extend(color.map(|n| n as f32));
        if valid {
            categories[category(model, request.mode.id, i)] = true;
        } else {
            events[kind as usize] = true;
        }
    }
    let legend = legend(
        model,
        request.mode,
        range.as_ref(),
        &categories,
        &events,
        cancel,
    )?;
    poll(cancel, 0)?;
    Ok(Preview::Ready {
        mode: request.mode,
        source_record_count: model.columns.count,
        count,
        record_indices: indices,
        values,
        value_valid: valid_values,
        colors_rgba: colors,
        range,
        legend,
        limitations,
        layer_time_provenance: request
            .original
            .layer_times
            .as_ref()
            .map(|t| t.provenance.clone()),
    })
}

fn validate_model(model: &Model, cancel: &Cancellation) -> Result<(), PreviewError> {
    let c = &model.columns;
    let hard = Limits::default();
    if model
        .record_offset
        .unwrap_or(0)
        .checked_add(c.count)
        .is_none_or(|n| n > u32::MAX as usize)
    {
        return Err(err(
            "invalid-model",
            "Source record offset is outside the bounded domain",
        ));
    }
    if c.count > hard.records {
        return Err(err(
            "invalid-model",
            "Rich G-code record count is outside the bounded preview domain",
        ));
    }
    if !layout::valid_lengths(model) {
        return Err(err(
            "invalid-model",
            "Rich G-code column lengths are inconsistent",
        ));
    }
    if model.roles.is_empty()
        || model.roles.len() > hard.roles
        || model.filaments.is_empty()
        || model.filaments.len() > hard.filaments
        || model.layer_count as usize > hard.lines
    {
        return Err(err(
            "invalid-model",
            "Rich G-code lookup tables are outside their bounded domain",
        ));
    }
    for (id, filament) in model.filaments.iter().enumerate() {
        if filament.id as usize != id || filament.tool >= 256 {
            return Err(err(
                "invalid-model",
                format!("Rich G-code filament identity {id} is malformed"),
            ));
        }
    }
    for i in 0..c.count {
        poll(cancel, i)?;
        if c.kind[i] >= 14 || c.kind[i] == 3 {
            return Err(err(
                "invalid-model",
                format!("Record {i} has an unsupported kind"),
            ));
        }
        if c.role[i] as usize >= model.roles.len()
            || c.tool[i] >= 256
            || c.filament[i] as usize >= model.filaments.len()
            || c.layer[i] > model.layer_count
        {
            return Err(err(
                "invalid-model",
                format!("Record {i} references an out-of-range lookup value"),
            ));
        }
        if [
            c.start_x[i],
            c.start_y[i],
            c.start_z[i],
            c.end_x[i],
            c.end_y[i],
            c.end_z[i],
            c.delta_e[i],
            c.feedrate_mm_per_second[i],
            c.width_mm[i],
            c.height_mm[i],
            c.volumetric_flow_mm3_per_second[i],
            c.fan_percent[i],
            c.hotend_temperature_c[i],
        ]
        .iter()
        .any(|n| !n.is_finite())
        {
            return Err(err(
                "invalid-model",
                format!("Record {i} contains a non-finite preview value"),
            ));
        }
    }
    crate::path::validate(model, cancel).map_err(|error| match error {
        crate::path::PathError::Cancelled => err("cancelled", "Preview computation was cancelled"),
        crate::path::PathError::Invalid(message) => err("invalid-model", message),
    })
}
fn validate_request<'a>(
    model: &Model,
    request: &'a PreviewRequest,
) -> Result<Request<'a>, PreviewError> {
    let mode = MODES
        .iter()
        .find(|m| m.id == request.mode)
        .copied()
        .ok_or_else(|| {
            err(
                "invalid-mode",
                format!("Unknown official preview mode \"{}\"", request.mode),
            )
        })?;
    for (mask, count, label) in [
        (&request.role_visibility, 20, "role"),
        (&request.tool_visibility, 256, "tool"),
        (&request.event_visibility, 14, "event"),
    ] {
        if let Some(mask) = mask {
            if mask.len() != count {
                return Err(err(
                    "invalid-mask",
                    format!("{label} visibility mask must have {count} bytes"),
                ));
            }
            if mask.iter().any(|v| *v > 1) {
                return Err(err(
                    "invalid-mask",
                    format!("{label} visibility mask values must be 0 or 1"),
                ));
            }
        }
    }
    let [first_layer, last_layer] = integer_range(
        request.layer_range,
        0,
        model.layer_count as usize,
        false,
        "layer",
    )?;
    let offset = model.record_offset.unwrap_or(0);
    let range = integer_range(
        request.record_range,
        offset,
        offset + model.columns.count.saturating_sub(1),
        model.columns.count == 0,
        "record",
    )?;
    if let Some([a, b]) = request.value_range {
        if mode.value_kind != "number" {
            return Err(err(
                "invalid-range",
                format!(
                    "{} is categorical and cannot use a numeric value range",
                    mode.id
                ),
            ));
        }
        if !a.is_finite() || !b.is_finite() || a > b {
            return Err(err(
                "invalid-range",
                "Preview value range must be two ordered finite numbers",
            ));
        }
    }
    let maximum = request
        .max_projected_records
        .unwrap_or(Limits::default().records as f64);
    if !maximum.is_finite()
        || maximum.fract() != 0.0
        || !(1.0..=Limits::default().records as f64).contains(&maximum)
    {
        return Err(err(
            "projection-cap",
            "Requested preview record cap is outside the hard domain",
        ));
    }
    if let Some(times) = &request.layer_times
        && (times.seconds_by_layer.len() > Limits::default().lines + 1
            || times.provenance.len() > 256
            || lexer::trim(&times.provenance.0).is_empty())
    {
        return Err(err(
            "invalid-layer-times",
            "Layer times require a bounded Float32Array and non-empty bounded provenance",
        ));
    }
    Ok(Request {
        mode,
        original: request,
        first_layer: first_layer as u32,
        last_layer: last_layer as u32,
        first: if model.columns.count == 0 {
            0
        } else {
            range[0] - offset
        },
        end: if model.columns.count == 0 {
            0
        } else {
            range[1] - offset + 1
        },
        maximum: maximum as usize,
    })
}
fn integer_range(
    request: Option<[f64; 2]>,
    minimum: usize,
    maximum: usize,
    empty: bool,
    label: &str,
) -> Result<[usize; 2], PreviewError> {
    let Some([a, b]) = request else {
        return Ok([minimum, maximum]);
    };
    if empty
        || ![a, b]
            .iter()
            .all(|n| n.is_finite() && n.fract() == 0.0 && n.abs() <= crate::MAX_SAFE_INTEGER as f64)
        || a < minimum as f64
        || b > maximum as f64
        || a > b
    {
        return Err(err(
            "invalid-range",
            format!("Preview {label} range is outside the source domain"),
        ));
    }
    Ok([a as usize, b as usize])
}
fn passes(model: &Model, r: &Request<'_>, i: usize) -> bool {
    let c = &model.columns;
    let q = r.original;
    c.layer[i] >= r.first_layer
        && c.layer[i] <= r.last_layer
        && q.event_visibility
            .as_ref()
            .is_none_or(|m| m[c.kind[i] as usize] != 0)
        && q.tool_visibility
            .as_ref()
            .is_none_or(|m| m[c.tool[i] as usize] != 0)
        && (c.kind[i] != kind::EXTRUDE
            || q.role_visibility
                .as_ref()
                .is_none_or(|m| m[official_role(&model.roles[c.role[i] as usize])] != 0))
}
fn has_value(mode: &str, kind: u8) -> bool {
    kind == kind::EXTRUDE || (kind == kind::TRAVEL && matches!(mode, "Feedrate" | "Tool"))
}
fn find_missing(
    model: &Model,
    r: &Request<'_>,
    cancel: &Cancellation,
) -> Result<Vec<MissingMetadata>, PreviewError> {
    let mut output = vec![];
    let needs_times = matches!(r.mode.id, "LayerTime" | "LayerTimeLog");
    if needs_times && r.original.layer_times.is_none() {
        output.push(MissingMetadata{key:"layer-times",message:"Authoritative G-code processor layer durations are required; geometric feedrate estimates are not substituted".into(),indices:vec![],additional_count:0});
        return Ok(output);
    }
    let mut colors = vec![false; model.filaments.len()];
    let mut roles = [false; 20];
    let mut layers = if needs_times {
        vec![false; model.layer_count as usize + 1]
    } else {
        vec![]
    };
    let c = &model.columns;
    for i in r.first..r.end {
        poll(cancel, i)?;
        if !passes(model, r, i) || !has_value(r.mode.id, c.kind[i]) {
            continue;
        }
        match r.mode.id {
            "ColorPrint" => {
                let f = c.filament[i] as usize;
                if hex(model.filaments[f].color.as_ref()).is_none() {
                    colors[f] = true;
                }
            }
            "FeatureType" => {
                let role = official_role(&model.roles[c.role[i] as usize]);
                if ROLE_RGBA[role].is_none() {
                    roles[role] = true;
                }
            }
            _ if needs_times => {
                let layer = c.layer[i] as usize;
                let seconds = r
                    .original
                    .layer_times
                    .as_ref()
                    .unwrap()
                    .seconds_by_layer
                    .get(layer)
                    .copied()
                    .unwrap_or(f32::NAN);
                if !seconds.is_finite() || seconds <= 0.0 {
                    layers[layer] = true;
                }
            }
            _ => {}
        }
    }
    for (mask, key, message) in [
        (
            &colors[..],
            "filament-colors",
            "Exact #RRGGBB filament colors are unavailable",
        ),
        (
            &layers[..],
            "layer-times",
            "Positive authoritative durations are unavailable for layers",
        ),
        (
            &roles[..],
            "role-color",
            "The pinned viewer defines no display color for extrusion roles",
        ),
    ] {
        let mut total: usize = 0;
        let mut indices = Vec::new();
        for (i, present) in mask.iter().enumerate() {
            poll(cancel, i)?;
            if *present {
                total += 1;
                if indices.len() < 64 {
                    indices.push(i as u32);
                }
            }
        }
        if total > 0 {
            output.push(MissingMetadata {
                key,
                message: message.into(),
                indices,
                additional_count: total.saturating_sub(64),
            });
        }
    }
    Ok(output)
}
fn official_role(name: &Text) -> usize {
    ROLE_NAMES
        .iter()
        .position(|role| name.equals(role))
        .unwrap_or(0)
}
fn bin(value: f64) -> f64 {
    let scales = [100.0, 1000.0, 10000.0, 100000.0, 1000000.0];
    let thresholds = [0.095, 0.0095, 0.00095, 0.000095, 0.0000095];
    let mut i = 0;
    while value < thresholds[i] && i < 4 {
        i += 1;
    }
    let v = value * scales[i];
    let floor = v.floor();
    let rounded = if v - floor >= 0.5 { floor + 1.0 } else { floor };
    if rounded == 0.0 {
        0.0_f64.copysign(value)
    } else {
        rounded / scales[i]
    }
}
fn value(model: &Model, r: &Request<'_>, i: usize) -> f64 {
    let c = &model.columns;
    match r.mode.id {
        "FeatureType" => official_role(&model.roles[c.role[i] as usize]) as f64,
        "Height" => bin(c.height_mm[i] as f64),
        "Width" => bin(c.width_mm[i] as f64),
        "Feedrate" => c.feedrate_mm_per_second[i] as f64,
        "FanSpeed" => c.fan_percent[i] as f64,
        "Temperature" => c.hotend_temperature_c[i] as f64,
        "VolumetricRate" => c.volumetric_flow_mm3_per_second[i] as f64,
        "Tool" => c.tool[i] as f64,
        "ColorPrint" => c.filament[i] as f64,
        "FilamentId" => {
            (c.tool[i] as usize * 20 + official_role(&model.roles[c.role[i] as usize])) as f64
        }
        _ => r.original.layer_times.as_ref().unwrap().seconds_by_layer[c.layer[i] as usize] as f64,
    }
}
fn mode_color(
    model: &Model,
    mode: &str,
    i: usize,
    value: f64,
    range: Option<&PreviewRange>,
) -> [f64; 4] {
    let c = &model.columns;
    match mode {
        "FeatureType" => ROLE_RGBA[value as usize].unwrap(),
        "Tool" => RANGE_RGBA[c.tool[i] as usize % 10],
        "ColorPrint" => {
            adjust(hex(model.filaments[c.filament[i] as usize].color.as_ref()).unwrap())
        }
        "FilamentId" => {
            let tool = c.tool[i] as f64 / 256.0;
            [
                tool,
                official_role(&model.roles[c.role[i] as usize]) as f64 / 256.0,
                tool,
                1.0,
            ]
        }
        _ => range_color(value, range.unwrap()),
    }
}
fn event_color(model: &Model, kind: u8, i: usize) -> [f64; 4] {
    if kind == kind::TRAVEL {
        if model.columns.delta_e[i] < 0.0 {
            return [0.505, 0.064, 0.028, 1.0];
        }
        if model.columns.delta_e[i] > 0.0 {
            return [0.112, 0.422, 0.103, 1.0];
        }
    }
    EVENT_RGBA[kind as usize]
}
fn range_color(value: f64, range: &PreviewRange) -> [f64; 4] {
    if range.min == range.max {
        return RANGE_RGBA[0];
    }
    // Use the pinned pure-Rust fdlibm implementation on every target. Host
    // libc log/exp changed a reference legend label by one binary64 ULP.
    let normalized = if range.scale == "log" {
        (libm::log(value) - libm::log(range.min)) / (libm::log(range.max) - libm::log(range.min))
    } else {
        (value - range.min) / (range.max - range.min)
    };
    let global = normalized.clamp(0.0, 1.0) * 9.0;
    let low = global.floor() as usize;
    let high = (low + 1).min(9);
    let amount = global - low as f64;
    std::array::from_fn(|c| {
        RANGE_RGBA[low][c] + (RANGE_RGBA[high][c] - RANGE_RGBA[low][c]) * amount
    })
}
fn category(model: &Model, mode: &str, i: usize) -> usize {
    let c = &model.columns;
    match mode {
        "FeatureType" => official_role(&model.roles[c.role[i] as usize]),
        "Tool" => c.tool[i] as usize,
        "ColorPrint" => c.filament[i] as usize,
        "FilamentId" => c.tool[i] as usize * 20 + official_role(&model.roles[c.role[i] as usize]),
        _ => 0,
    }
}
fn hex(value: Option<&Text>) -> Option<[f64; 4]> {
    let value = &value?.0;
    if value.len() != 7 || value[0] != 35 {
        return None;
    }
    let digit = |v: u16| char::from_u32(v as u32)?.to_digit(16);
    Some([
        (digit(value[1])? * 16 + digit(value[2])?) as f64 / 255.0,
        (digit(value[3])? * 16 + digit(value[4])?) as f64 / 255.0,
        (digit(value[5])? * 16 + digit(value[6])?) as f64 / 255.0,
        1.0,
    ])
}
fn adjust(color: [f64; 4]) -> [f64; 4] {
    if color[3] < 0.1 {
        [1.0, 1.0, 1.0, 0.3]
    } else if color[..3].iter().all(|v| *v < 0.2) {
        [0.2, 0.2, 0.2, color[3]]
    } else {
        color
    }
}
fn entry(
    id: String,
    label: String,
    code: String,
    accessible_label: String,
    pattern: String,
    color: [f64; 4],
) -> LegendEntry {
    LegendEntry {
        id,
        label,
        code,
        accessible_label,
        pattern,
        color,
    }
}
fn legend(
    model: &Model,
    mode: ModeDefinition,
    range: Option<&PreviewRange>,
    categories: &[bool],
    events: &[bool],
    cancel: &Cancellation,
) -> Result<Vec<LegendEntry>, PreviewError> {
    let mut output = vec![];
    if let Some(range) = range {
        let steps = if range.min == range.max { 1 } else { 10 };
        for rank in (0..steps).rev() {
            let fraction = if steps == 1 {
                0.0
            } else {
                rank as f64 / (steps - 1) as f64
            };
            let value = if range.scale == "log" {
                libm::exp(
                    libm::log(range.min) + fraction * (libm::log(range.max) - libm::log(range.min)),
                )
            } else {
                range.min + fraction * (range.max - range.min)
            };
            let label = format!("{} {}", format_number(value), range.unit);
            output.push(entry(
                format!("{}:range:{rank}", mode.id),
                label.clone(),
                format!("R{}", rank + 1),
                format!(
                    "{}, {label}, range step {} of {steps}",
                    mode.label,
                    rank + 1
                ),
                format!("range-{}", rank + 1),
                range_color(value, range),
            ));
        }
    } else {
        for (i, present) in categories.iter().enumerate() {
            poll(cancel, i)?;
            if !present {
                continue;
            }
            let pattern = PATTERNS[i % 6].into();
            match mode.id {
                "FeatureType" => output.push(entry(
                    format!("role:{i}"),
                    ROLE_NAMES[i].into(),
                    format!("R{i}"),
                    format!("Line type R{i}: {}", ROLE_NAMES[i]),
                    pattern,
                    ROLE_RGBA[i].unwrap(),
                )),
                "Tool" => output.push(entry(
                    format!("tool:{i}"),
                    format!("Tool {i}"),
                    format!("T{i}"),
                    format!("Physical tool T{i}"),
                    pattern,
                    RANGE_RGBA[i % 10],
                )),
                "ColorPrint" => {
                    let identity = &model.filaments[i];
                    let tool = identity.tool;
                    let color = identity.color.as_ref().unwrap();
                    output.push(entry(
                        format!("filament:{i}"),
                        format!("Filament {i} · Tool {tool}"),
                        format!("F{i}/T{tool}"),
                        format!(
                            "Filament F{i}, physical tool T{tool}, color {}",
                            color.utf8().unwrap()
                        ),
                        pattern,
                        adjust(hex(Some(color)).unwrap()),
                    ));
                }
                "FilamentId" => {
                    let tool = i / 20;
                    let role = i % 20;
                    output.push(entry(
                        format!("filament-id:{tool}:{role}"),
                        format!("Tool {tool} · {}", ROLE_NAMES[role]),
                        format!("T{tool}/R{role}"),
                        format!(
                            "Calibration encoding for physical tool T{tool} and role R{role}, {}",
                            ROLE_NAMES[role]
                        ),
                        PATTERNS[(tool + role) % 6].into(),
                        [
                            tool as f64 / 256.0,
                            role as f64 / 256.0,
                            tool as f64 / 256.0,
                            1.0,
                        ],
                    ));
                }
                _ => {}
            }
        }
    }
    for (kind, present) in events.iter().enumerate() {
        if *present {
            output.push(entry(
                format!("event:{kind}"),
                EVENT_LABELS[kind].into(),
                format!("E{kind}"),
                format!("Event E{kind}: {}", EVENT_LABELS[kind]),
                PATTERNS[kind % 6].into(),
                EVENT_RGBA[kind],
            ));
        }
    }
    if output.len() > 8192 {
        return Err(err(
            "projection-cap",
            "Preview legend exceeds its bounded hard cap",
        ));
    }
    Ok(output)
}
fn format_number(value: f64) -> String {
    let mut b = ryu_js::Buffer::new();
    if value.abs() >= 100.0 {
        return b.format_to_fixed(value, 0).into();
    }
    let text = b.format_to_fixed(value, if value.abs() >= 10.0 { 1 } else { 2 });
    text.trim_end_matches('0').trim_end_matches('.').into()
}
fn limitations(model: &Model, cancel: &Cancellation) -> Result<Vec<Limitation>, PreviewError> {
    if model.complete {
        return Ok(vec![]);
    }
    let mut highest: Option<f32> = None;
    for (i, value) in model.columns.end_z.iter().copied().enumerate() {
        poll(cancel, i)?;
        if value.is_finite() && highest.is_none_or(|max| value > max) {
            highest = Some(value);
        }
    }
    let height = highest.map_or_else(String::new, |z| {
        format!(
            " up to Z {} mm",
            ryu_js::Buffer::new().format_to_fixed(z as f64, 2)
        )
    });
    let raw = number(model.columns.count as f64);
    let mut grouped = String::new();
    for (i, c) in raw.chars().enumerate() {
        if i > 0 && (raw.len() - i).is_multiple_of(3) {
            grouped.push(',');
        }
        grouped.push(c);
    }
    let reason = model
        .termination_reason
        .map_or("unknown limit", |v| v.as_str());
    Ok(vec![Limitation{code:"source-incomplete",message:format!("This preview shows only the first {grouped} moves{height}, because the preview parser reached a limit ({reason}). Later input was not inspected. This preview limit does not determine whether slicing completed.").into()}])
}
