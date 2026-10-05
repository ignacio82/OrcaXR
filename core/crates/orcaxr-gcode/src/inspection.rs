//! Bounded inspection of immutable rich columns. Source offsets are UTF-16 units.
use crate::{Cancellation, Limits, Model, Text, kind, layout, number, path};
use serde::Serialize;
use std::collections::BTreeMap;

pub const MAX_TICKS: usize = 100_000;
pub const MAX_CONTEXT_LINES: usize = 50;
pub const MAX_LINE_UNITS: usize = 4_096;
pub const MAX_PLAYBACK_FRAMES: usize = 100_000;
const KIND_NAMES: [&str; 14] = [
    "noop",
    "retract",
    "unretract",
    "reserved-seam",
    "tool-change",
    "color-change",
    "pause",
    "custom",
    "travel",
    "wipe",
    "extrude",
    "layer-change",
    "wipe-start",
    "wipe-end",
];

pub use crate::request_types::{InspectionRequest, PlaybackOptions};
#[derive(Debug, Serialize)]
pub struct InspectionError {
    pub code: &'static str,
    pub message: Text,
}
fn error(code: &'static str, message: impl Into<Text>) -> InspectionError {
    InspectionError {
        code,
        message: message.into(),
    }
}
fn invalid(message: impl Into<Text>) -> InspectionError {
    error("invalid-model", message)
}
fn poll(cancel: &Cancellation, i: usize) -> Result<(), InspectionError> {
    if i.is_multiple_of(4096) && cancel.is_cancelled() {
        Err(error("cancelled", "Inspection was cancelled"))
    } else {
        Ok(())
    }
}
fn inspectable(kind: u8) -> bool {
    matches!(kind, 1 | 2 | 4..=10)
}
fn geometric(kind: u8) -> bool {
    matches!(kind, 1 | 2 | 8..=10)
}
fn is_tick(kind: u8) -> bool {
    matches!(kind, 4..=7)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerIndex {
    pub count: usize,
    pub layer_ids: Vec<u32>,
    pub z_mm: Vec<f32>,
    pub first_record: Vec<u32>,
    pub last_record: Vec<u32>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LayerSelection {
    pub first_layer: u32,
    pub last_layer: u32,
    pub first_z_mm: f64,
    pub last_z_mm: f64,
    pub single_layer: bool,
    pub accessible_label: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveSelection {
    pub first_ordinal: usize,
    pub last_ordinal: usize,
    pub first_record: u32,
    pub last_record: u32,
    pub count: usize,
    pub accessible_label: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Cursor {
    pub ordinal: usize,
    pub record: u32,
    pub kind: u8,
    pub kind_label: &'static str,
    pub layer: u32,
    pub z_mm: f64,
    pub tool: u16,
    pub filament: u16,
    pub source_line: u32,
    pub source_start_offset: u32,
    pub source_end_offset: u32,
    pub position_mm: [f64; 3],
    pub accessible_label: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    pub id: String,
    pub kind: &'static str,
    pub label: String,
    pub record: u32,
    pub layer: u32,
    pub z_mm: f64,
    pub source_line: u32,
    pub source_start_offset: u32,
    pub source_end_offset: u32,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolMarker {
    pub visible: bool,
    pub record: u32,
    pub tool: u16,
    pub position_mm: [f64; 3],
    pub accessible_label: String,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceLine {
    pub number: i64,
    pub start_offset: usize,
    pub end_offset: usize,
    pub text: Text,
    pub current: bool,
    pub truncated: bool,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceWindow {
    pub current_line: u32,
    pub first_line: i64,
    pub last_line: i64,
    pub lines: Vec<SourceLine>,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub min_mm: [f64; 3],
    pub max_mm: [f64; 3],
}
#[derive(Debug, Serialize)]
pub struct Limitation {
    pub code: &'static str,
    pub message: Text,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inspection {
    pub source_record_count: usize,
    pub layers: LayerIndex,
    pub layer_selection: Option<LayerSelection>,
    pub record_indices: Vec<u32>,
    pub move_selection: Option<MoveSelection>,
    pub current: Option<Cursor>,
    pub ticks: Vec<Tick>,
    pub tool_marker: Option<ToolMarker>,
    pub source_window: Option<SourceWindow>,
    pub focus_bounds: Option<Bounds>,
    pub limitations: Vec<Limitation>,
}

/// The source is borrowed only for this call. Session bindings must supply their
/// own immutable indexed source, never accept substitute text from a request.
pub fn inspect(
    model: &Model,
    request: &InspectionRequest,
    source: Option<&[u16]>,
    cancel: &Cancellation,
) -> Result<Inspection, InspectionError> {
    poll(cancel, 0)?;
    validate_model(model, cancel)?;
    if let Some(mask) = &request.record_visibility {
        if mask.len() != model.columns.count {
            return Err(error(
                "invalid-visibility",
                format!(
                    "Record visibility must contain exactly {} bytes",
                    model.columns.count
                ),
            ));
        }
        for (i, v) in mask.iter().enumerate() {
            poll(cancel, i)?;
            if *v > 1 {
                return Err(error(
                    "invalid-visibility",
                    "Record visibility values must be zero or one",
                ));
            }
        }
    }
    let mut layers = build_layers(model, cancel)?;
    let layer_selection = select_layers(&layers, request)?;
    let mut record_indices = select_records(model, request, layer_selection.as_ref(), cancel)?;
    let mut move_selection = select_moves(&record_indices, request.move_range)?;
    let offset = model.record_offset.unwrap_or(0) as u32;
    let mut current = select_current(
        model,
        &layers,
        &record_indices,
        move_selection.as_ref(),
        request.current_record.map(|v| v - offset as f64),
    )?;
    let ticks = build_ticks(model, request, layer_selection.as_ref(), offset, cancel)?;
    let mut tool_marker = if request.show_tool_marker {
        current.as_ref().map(|c| ToolMarker {
            visible: true,
            record: c.record,
            tool: c.tool,
            position_mm: c.position_mm,
            accessible_label: format!(
                "Tool T{} at {}, {}, {} mm",
                c.tool,
                format_mm(c.position_mm[0]),
                format_mm(c.position_mm[1]),
                format_mm(c.position_mm[2])
            ),
        })
    } else {
        None
    };
    let source_window = source
        .map(|source| {
            source_window(
                model,
                current.as_ref(),
                source,
                request.source_context_lines,
                cancel,
            )
        })
        .transpose()?
        .flatten();
    let focus_bounds = focus(model, &record_indices, move_selection.as_ref(), cancel)?;
    let limitations = if model.complete {
        vec![]
    } else {
        vec![Limitation {
            code: "source-incomplete",
            message: format!(
                "Inspection covers only the parsed prefix ({}).",
                model
                    .termination_reason
                    .map_or("unknown termination", |v| v.as_str())
            )
            .into(),
        }]
    };
    if offset != 0 {
        for (i, record) in record_indices.iter_mut().enumerate() {
            poll(cancel, i)?;
            *record += offset;
        }
        for (i, record) in layers.first_record.iter_mut().enumerate() {
            poll(cancel, i)?;
            *record += offset;
        }
        for (i, record) in layers.last_record.iter_mut().enumerate() {
            poll(cancel, i)?;
            *record += offset;
        }
        if let Some(selection) = &mut move_selection {
            selection.first_record += offset;
            selection.last_record += offset;
        }
        if let Some(cursor) = &mut current {
            cursor.record += offset;
        }
        if let Some(marker) = &mut tool_marker {
            marker.record += offset;
        }
    }
    poll(cancel, 0)?;
    Ok(Inspection {
        source_record_count: model.columns.count,
        layers,
        layer_selection,
        record_indices,
        move_selection,
        current,
        ticks,
        tool_marker,
        source_window,
        focus_bounds,
        limitations,
    })
}

fn validate_model(model: &Model, cancel: &Cancellation) -> Result<(), InspectionError> {
    let c = &model.columns;
    let hard = Limits::default();
    let total = model.record_offset.unwrap_or(0).checked_add(c.count);
    let lines = model
        .source_line_offset
        .unwrap_or(0)
        .checked_add(model.parsed_lines);
    if c.count > hard.records
        || total.is_none_or(|n| n > u32::MAX as usize || model.layer_count as usize > n)
        || model.layer_count as usize > hard.lines
        || model.source_length as u64 > crate::MAX_SAFE_INTEGER
        || lines.is_none_or(|n| n > hard.lines)
        || model.parsed_lines > hard.lines
    {
        return Err(invalid(
            "Rich G-code model is outside the bounded inspection domain",
        ));
    }
    if !layout::valid_lengths(model) {
        return Err(invalid("Rich G-code columns differ in length"));
    }
    if model.roles.is_empty()
        || model.roles.len() > hard.roles
        || model.filaments.is_empty()
        || model.filaments.len() > hard.filaments
    {
        return Err(invalid(
            "Rich G-code lookup tables are outside their bounded domain",
        ));
    }
    for i in 0..c.count {
        poll(cancel, i)?;
        if c.kind[i] >= 14 || c.kind[i] == 3 {
            return Err(invalid(format!("Record {i} has an invalid kind")));
        }
        if c.layer[i] > model.layer_count
            || c.tool[i] >= 256
            || c.filament[i] as usize >= model.filaments.len()
        {
            return Err(invalid(format!(
                "Record {i} has an invalid lookup identity"
            )));
        }
        if [
            c.start_x[i],
            c.start_y[i],
            c.start_z[i],
            c.end_x[i],
            c.end_y[i],
            c.end_z[i],
        ]
        .iter()
        .any(|v| !v.is_finite())
        {
            return Err(invalid(format!("Record {i} has a non-finite position")));
        }
        if c.source_line[i] as usize <= model.source_line_offset.unwrap_or(0)
            || c.source_line[i] as usize > lines.unwrap()
            || c.source_start_offset[i] > c.source_end_offset[i]
            || c.source_end_offset[i] as usize > model.source_length
        {
            return Err(invalid(format!(
                "Record {i} has an invalid source location"
            )));
        }
    }
    path::validate(model, cancel).map_err(|e| match e {
        path::PathError::Cancelled => error("cancelled", "Inspection was cancelled"),
        path::PathError::Invalid(message) => invalid(message),
    })
}
fn maximum(a: f32, b: f32) -> f32 {
    if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() && b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if b > a {
        b
    } else {
        a
    }
}
fn build_layers(model: &Model, cancel: &Cancellation) -> Result<LayerIndex, InspectionError> {
    struct Span {
        first: u32,
        last: u32,
        z: f32,
        extrude_z: f32,
    }
    let mut spans = BTreeMap::<u32, Span>::new();
    let c = &model.columns;
    for i in 0..c.count {
        poll(cancel, i)?;
        if !inspectable(c.kind[i]) {
            continue;
        }
        let span = spans.entry(c.layer[i]).or_insert(Span {
            first: i as u32,
            last: i as u32,
            z: f32::NEG_INFINITY,
            extrude_z: f32::NEG_INFINITY,
        });
        span.last = i as u32;
        let z = maximum(c.start_z[i], c.end_z[i]);
        span.z = maximum(span.z, z);
        if c.kind[i] == kind::EXTRUDE {
            span.extrude_z = maximum(span.extrude_z, z);
        }
    }
    let count = spans.len();
    let mut result = LayerIndex {
        count,
        layer_ids: Vec::with_capacity(count),
        z_mm: Vec::with_capacity(count),
        first_record: Vec::with_capacity(count),
        last_record: Vec::with_capacity(count),
    };
    for (i, (layer, span)) in spans.into_iter().enumerate() {
        poll(cancel, i)?;
        result.layer_ids.push(layer);
        result.first_record.push(span.first);
        result.last_record.push(span.last);
        result.z_mm.push(if span.extrude_z.is_finite() {
            span.extrude_z
        } else {
            span.z
        });
    }
    Ok(result)
}
fn select_layers(
    layers: &LayerIndex,
    q: &InspectionRequest,
) -> Result<Option<LayerSelection>, InspectionError> {
    if layers.count == 0 {
        return if q.layer_range.is_some() && !q.clamp_layer_range {
            Err(error(
                "invalid-layer-range",
                "An empty inspection has no layer range",
            ))
        } else {
            Ok(None)
        };
    }
    let [mut first, mut last] = q.layer_range.unwrap_or([
        layers.layer_ids[0] as f64,
        layers.layer_ids[layers.count - 1] as f64,
    ]);
    if q.clamp_layer_range {
        if first.is_nan() || last.is_nan() || first > last {
            return Ok(None);
        }
        let start = layers.layer_ids.partition_point(|v| (*v as f64) < first);
        let end = layers.layer_ids.partition_point(|v| (*v as f64) <= last);
        if start >= end {
            return Ok(None);
        }
        first = layers.layer_ids[start] as f64;
        last = layers.layer_ids[end - 1] as f64;
    }
    let ordinal = |n: f64| {
        if n.is_finite() && n.fract() == 0.0 && (0.0..=u32::MAX as f64).contains(&n) {
            layers.layer_ids.binary_search(&(n as u32)).ok()
        } else {
            None
        }
    };
    let (Some(mut a), Some(b)) = (ordinal(first), ordinal(last)) else {
        return Err(error(
            "invalid-layer-range",
            "Layer handles must select ordered record-bearing layers",
        ));
    };
    if a > b {
        return Err(error(
            "invalid-layer-range",
            "Layer handles must select ordered record-bearing layers",
        ));
    }
    if q.single_layer {
        first = last;
        a = b;
    }
    let first_z_mm = layers.z_mm[a] as f64;
    let last_z_mm = layers.z_mm[b] as f64;
    let first_layer = first as u32;
    let last_layer = last as u32;
    let accessible_label = if first_layer == last_layer {
        format!("Layer {last_layer}, Z {} mm", format_mm(last_z_mm))
    } else {
        format!(
            "Layers {first_layer} through {last_layer}, Z {} through {} mm",
            format_mm(first_z_mm),
            format_mm(last_z_mm)
        )
    };
    Ok(Some(LayerSelection {
        first_layer,
        last_layer,
        first_z_mm,
        last_z_mm,
        single_layer: q.single_layer,
        accessible_label,
    }))
}
fn visible(q: &InspectionRequest, i: usize) -> bool {
    q.record_visibility.as_ref().is_none_or(|mask| mask[i] != 0)
}
fn in_layer(model: &Model, i: usize, selection: &LayerSelection) -> bool {
    model.columns.layer[i] >= selection.first_layer
        && model.columns.layer[i] <= selection.last_layer
}
fn select_records(
    model: &Model,
    q: &InspectionRequest,
    selected: Option<&LayerSelection>,
    cancel: &Cancellation,
) -> Result<Vec<u32>, InspectionError> {
    let Some(selected) = selected else {
        return Ok(vec![]);
    };
    let passes = |i: usize| {
        inspectable(model.columns.kind[i]) && visible(q, i) && in_layer(model, i, selected)
    };
    let mut count = 0;
    for i in 0..model.columns.count {
        poll(cancel, i)?;
        if passes(i) {
            count += 1;
        }
    }
    let mut records = Vec::with_capacity(count);
    for i in 0..model.columns.count {
        poll(cancel, i)?;
        if passes(i) {
            records.push(i as u32);
        }
    }
    Ok(records)
}
fn select_moves(
    records: &[u32],
    requested: Option<[f64; 2]>,
) -> Result<Option<MoveSelection>, InspectionError> {
    if records.is_empty() {
        return if requested.is_some() {
            Err(error(
                "invalid-move-range",
                "An empty inspection has no move range",
            ))
        } else {
            Ok(None)
        };
    }
    let [first, last] = requested.unwrap_or([0.0, (records.len() - 1) as f64]);
    if !first.is_finite()
        || !last.is_finite()
        || first.fract() != 0.0
        || last.fract() != 0.0
        || first < 0.0
        || last >= records.len() as f64
        || first > last
    {
        return Err(error(
            "invalid-move-range",
            "Move handles are outside the filtered record domain",
        ));
    }
    let a = first as usize;
    let b = last as usize;
    Ok(Some(MoveSelection {
        first_ordinal: a,
        last_ordinal: b,
        first_record: records[a],
        last_record: records[b],
        count: b - a + 1,
        accessible_label: if a == b {
            format!("Move {} of {}", a + 1, records.len())
        } else {
            format!("Moves {} through {} of {}", a + 1, b + 1, records.len())
        },
    }))
}
fn select_current(
    model: &Model,
    layers: &LayerIndex,
    records: &[u32],
    selected: Option<&MoveSelection>,
    requested: Option<f64>,
) -> Result<Option<Cursor>, InspectionError> {
    let Some(selection) = selected else {
        return if requested.is_some() {
            Err(error(
                "invalid-current-record",
                "An empty inspection has no current record",
            ))
        } else {
            Ok(None)
        };
    };
    let record = requested.unwrap_or(selection.last_record as f64);
    if !record.is_finite() || record.fract() != 0.0 || record.abs() > crate::MAX_SAFE_INTEGER as f64
    {
        return Err(error(
            "invalid-current-record",
            "Current record must be a safe integer",
        ));
    }
    let ordinal = if (0.0..=u32::MAX as f64).contains(&record) {
        records.binary_search(&(record as u32)).ok()
    } else {
        None
    };
    let Some(ordinal) =
        ordinal.filter(|v| *v >= selection.first_ordinal && *v <= selection.last_ordinal)
    else {
        return Err(error(
            "invalid-current-record",
            "Current record is outside the selected move range",
        ));
    };
    let i = record as usize;
    let c = &model.columns;
    let layer = c.layer[i];
    let kind = c.kind[i];
    let z_mm = layers
        .layer_ids
        .binary_search(&layer)
        .map_or(c.end_z[i], |l| layers.z_mm[l]) as f64;
    Ok(Some(Cursor {
        ordinal,
        record: i as u32,
        kind,
        kind_label: KIND_NAMES[kind as usize],
        layer,
        z_mm,
        tool: c.tool[i],
        filament: c.filament[i],
        source_line: c.source_line[i],
        source_start_offset: c.source_start_offset[i],
        source_end_offset: c.source_end_offset[i],
        position_mm: [c.end_x[i] as f64, c.end_y[i] as f64, c.end_z[i] as f64],
        accessible_label: format!(
            "Move {} of {}, {}, layer {layer}, source line {}",
            ordinal + 1,
            records.len(),
            KIND_NAMES[kind as usize],
            c.source_line[i]
        ),
    }))
}
fn build_ticks(
    model: &Model,
    q: &InspectionRequest,
    selected: Option<&LayerSelection>,
    offset: u32,
    cancel: &Cancellation,
) -> Result<Vec<Tick>, InspectionError> {
    let Some(selected) = selected else {
        return Ok(vec![]);
    };
    let c = &model.columns;
    let passes = |i: usize| is_tick(c.kind[i]) && visible(q, i) && in_layer(model, i, selected);
    let mut count = 0;
    for i in 0..c.count {
        poll(cancel, i)?;
        if passes(i) {
            count += 1;
            if count > MAX_TICKS {
                return Err(invalid(format!(
                    "Inspection tick count exceeds {MAX_TICKS}"
                )));
            }
        }
    }
    let mut ticks = Vec::with_capacity(count);
    for i in 0..c.count {
        poll(cancel, i)?;
        if !passes(i) {
            continue;
        }
        let (kind, label) = match c.kind[i] {
            kind::TOOL_CHANGE => ("tool-change", format!("Tool T{}", c.tool[i])),
            kind::COLOR_CHANGE => (
                "color-change",
                format!("Filament F{} on T{}", c.filament[i], c.tool[i]),
            ),
            kind::PAUSE => ("pause", "Pause print".into()),
            _ => ("custom", "Custom G-code".into()),
        };
        let record = i as u32 + offset;
        ticks.push(Tick {
            id: format!("{kind}:{record}"),
            kind,
            label,
            record,
            layer: c.layer[i],
            z_mm: maximum(c.start_z[i], c.end_z[i]) as f64,
            source_line: c.source_line[i],
            source_start_offset: c.source_start_offset[i],
            source_end_offset: c.source_end_offset[i],
        });
    }
    Ok(ticks)
}
fn newline_after(
    source: &[u16],
    start: usize,
    cancel: &Cancellation,
) -> Result<Option<usize>, InspectionError> {
    for (i, value) in source.iter().enumerate().skip(start) {
        poll(cancel, i)?;
        if *value == 10 {
            return Ok(Some(i));
        }
    }
    Ok(None)
}
fn source_window(
    model: &Model,
    cursor: Option<&Cursor>,
    source: &[u16],
    requested_context: Option<f64>,
    cancel: &Cancellation,
) -> Result<Option<SourceWindow>, InspectionError> {
    if source.len() != model.source_length {
        return Err(error(
            "invalid-source",
            "G-code source length differs from the parsed model",
        ));
    }
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let context = requested_context.unwrap_or(3.0);
    if !context.is_finite()
        || context.fract() != 0.0
        || !(0.0..=MAX_CONTEXT_LINES as f64).contains(&context)
    {
        return Err(error(
            "invalid-source",
            format!("Source context must be in [0, {MAX_CONTEXT_LINES}]"),
        ));
    }
    let context = context as usize;
    let mut start = cursor.source_start_offset as usize;
    let mut first = cursor.source_line as i64;
    for _ in 0..context {
        if start == 0 {
            break;
        }
        let mut previous = None;
        // At offset 1, code unit 0 is the delimiter immediately before this
        // line. It must not be rediscovered as the previous line's delimiter.
        if let Some(from) = start.checked_sub(2) {
            let from = from.min(source.len().saturating_sub(1));
            for i in (0..=from).rev() {
                poll(cancel, i)?;
                if source[i] == 10 {
                    previous = Some(i);
                    break;
                }
            }
        }
        start = previous.map_or(0, |i| i + 1);
        first -= 1;
    }
    let mut end = newline_after(source, cursor.source_end_offset as usize, cancel)?
        .map_or(source.len(), |i| i + 1);
    let mut last = cursor.source_line as i64;
    for _ in 0..context {
        if end >= source.len() {
            break;
        }
        end = newline_after(source, end, cancel)?.map_or(source.len(), |i| i + 1);
        last += 1;
    }
    let mut lines = Vec::with_capacity(context * 2 + 1);
    let mut offset = start;
    let mut line_number = first;
    while offset < end && line_number <= last {
        let newline = newline_after(source, offset, cancel)?;
        let raw_end = newline.map_or(end, |i| i.min(end));
        let content_end = if raw_end > offset && source[raw_end - 1] == 13 {
            raw_end - 1
        } else {
            raw_end
        };
        let length = content_end - offset;
        let truncated = length > MAX_LINE_UNITS;
        let text = if truncated {
            let mut units = source[offset..offset + MAX_LINE_UNITS - 1].to_vec();
            units.push(0x2026);
            Text(units)
        } else {
            Text(source[offset..content_end].to_vec())
        };
        lines.push(SourceLine {
            number: line_number,
            start_offset: offset,
            end_offset: raw_end,
            text,
            current: line_number == cursor.source_line as i64,
            truncated,
        });
        let Some(newline) = newline.filter(|i| *i < end) else {
            break;
        };
        offset = newline + 1;
        line_number += 1;
    }
    Ok(Some(SourceWindow {
        current_line: cursor.source_line,
        first_line: first,
        last_line: lines.last().map_or(first, |line| line.number),
        lines,
    }))
}
fn focus(
    model: &Model,
    records: &[u32],
    selected: Option<&MoveSelection>,
    cancel: &Cancellation,
) -> Result<Option<Bounds>, InspectionError> {
    let Some(selection) = selected else {
        return Ok(None);
    };
    let mut bounds = Bounds {
        min_mm: [f64::INFINITY; 3],
        max_mm: [f64::NEG_INFINITY; 3],
    };
    let mut include = |point: [f32; 3]| {
        for (axis, value) in point.into_iter().enumerate() {
            bounds.min_mm[axis] = bounds.min_mm[axis].min(value as f64);
            bounds.max_mm[axis] = bounds.max_mm[axis].max(value as f64);
        }
    };
    let c = &model.columns;
    let points = &model.path_points;
    for (ordinal, record) in records
        .iter()
        .enumerate()
        .take(selection.last_ordinal + 1)
        .skip(selection.first_ordinal)
    {
        poll(cancel, ordinal)?;
        let i = *record as usize;
        if !geometric(c.kind[i]) {
            continue;
        }
        include([c.start_x[i], c.start_y[i], c.start_z[i]]);
        let a = c.path_point_offset[i] as usize;
        let b = a + c.path_point_count[i] as usize;
        for p in a..b {
            poll(cancel, p)?;
            include([points.x[p], points.y[p], points.z[p]]);
        }
        include([c.end_x[i], c.end_y[i], c.end_z[i]]);
    }
    Ok(bounds.min_mm[0].is_finite().then_some(bounds))
}
fn format_mm(value: f64) -> String {
    let rounded: f64 = ryu_js::Buffer::new()
        .format_to_fixed(value, 3)
        .parse()
        .unwrap();
    if rounded == 0.0 {
        "0".into()
    } else {
        number(rounded)
    }
}

// Public Rust outputs are owned and mutable. Reject corrupted selection metadata
// if a caller modifies it before invoking stepping/playback.
fn playback_selection(state: &Inspection) -> Result<Option<&MoveSelection>, InspectionError> {
    let Some(s) = &state.move_selection else {
        return Ok(None);
    };
    if state.record_indices.len() > Limits::default().records
        || s.first_ordinal > s.last_ordinal
        || s.last_ordinal >= state.record_indices.len()
        || state
            .current
            .as_ref()
            .is_some_and(|c| c.ordinal < s.first_ordinal || c.ordinal > s.last_ordinal)
    {
        return Err(error(
            "invalid-playback",
            "Inspection selection is outside the bounded record domain",
        ));
    }
    Ok(Some(s))
}
pub fn step(
    state: &Inspection,
    direction: f64,
    wrap: bool,
) -> Result<Option<u32>, InspectionError> {
    if direction != -1.0 && direction != 1.0 {
        return Err(error(
            "invalid-playback",
            "Inspection step direction must be -1 or 1",
        ));
    }
    let selection = playback_selection(state)?;
    let (Some(selection), Some(current)) = (selection, &state.current) else {
        return Ok(None);
    };
    let mut ordinal = current.ordinal as i64 + direction as i64;
    if ordinal < selection.first_ordinal as i64 || ordinal > selection.last_ordinal as i64 {
        if !wrap {
            return Ok(None);
        }
        ordinal = if direction > 0.0 {
            selection.first_ordinal
        } else {
            selection.last_ordinal
        } as i64;
    }
    Ok(Some(state.record_indices[ordinal as usize]))
}
pub fn playback(
    state: &Inspection,
    options: &PlaybackOptions,
    cancel: &Cancellation,
) -> Result<Vec<u32>, InspectionError> {
    poll(cancel, 0)?;
    let max = options.max_frames.unwrap_or(MAX_PLAYBACK_FRAMES as f64);
    if (options.direction != -1.0 && options.direction != 1.0)
        || !max.is_finite()
        || max.fract() != 0.0
        || !(1.0..=MAX_PLAYBACK_FRAMES as f64).contains(&max)
    {
        return Err(error(
            "invalid-playback",
            "Playback options are outside the bounded domain",
        ));
    }
    let Some(s) = playback_selection(state)? else {
        return Ok(vec![]);
    };
    let mut ordinal = state.current.as_ref().map_or(
        if options.direction > 0.0 {
            s.first_ordinal
        } else {
            s.last_ordinal
        },
        |c| c.ordinal,
    ) as i64;
    let direction = options.direction as i64;
    if !options.include_current {
        ordinal += direction;
    }
    let count = s.last_ordinal - s.first_ordinal + 1;
    let maximum = if options.wrap {
        (max as usize).min(count)
    } else {
        max as usize
    };
    let mut result = Vec::with_capacity(maximum.min(count));
    while result.len() < maximum {
        poll(cancel, result.len())?;
        if ordinal < s.first_ordinal as i64 || ordinal > s.last_ordinal as i64 {
            if !options.wrap {
                break;
            }
            ordinal = if direction > 0 {
                s.first_ordinal
            } else {
                s.last_ordinal
            } as i64;
        }
        result.push(state.record_indices[ordinal as usize]);
        ordinal += direction;
    }
    poll(cancel, 0)?;
    Ok(result)
}
