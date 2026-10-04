use crate::{Cancellation, SessionError, inspection, packet, preview, view_layout as layout};
use serde::Serialize;
use std::collections::BTreeMap;

enum Data<'a> {
    U8(&'a [u8]),
    U32(&'a [u32]),
    F32(&'a [f32]),
}
impl Data<'_> {
    fn kind(&self) -> &'static str {
        match self {
            Self::U8(_) => "u8",
            Self::U32(_) => "u32",
            Self::F32(_) => "f32",
        }
    }
    fn len(&self) -> usize {
        match self {
            Self::U8(v) => v.len(),
            Self::U32(v) => v.len(),
            Self::F32(v) => v.len(),
        }
    }
    fn write(&self, output: &mut Vec<u8>, cancellation: &Cancellation) -> Result<(), SessionError> {
        for i in 0..self.len() {
            if i.is_multiple_of(4096) && cancellation.is_cancelled() {
                return Err(SessionError::Cancelled);
            }
            match self {
                Self::U8(v) => output.push(v[i]),
                Self::U32(v) => output.extend(v[i].to_le_bytes()),
                Self::F32(v) => output.extend(v[i].to_le_bytes()),
            }
        }
        while !output.len().is_multiple_of(4) {
            output.push(0);
        }
        Ok(())
    }
}
fn pack(
    kind: usize,
    counts: [usize; 3],
    metadata: &impl Serialize,
    columns: &[(&str, Data<'_>)],
    cancel: &Cancellation,
) -> Result<Vec<u8>, SessionError> {
    if cancel.is_cancelled() {
        return Err(SessionError::Cancelled);
    }
    if counts[0] > layout::MAX_RECORDS
        || counts[1] > layout::MAX_LAYERS
        || counts[2] > layout::MAX_TICKS
    {
        return Err(SessionError::ResourceLimit);
    }
    let fields = layout::fields(kind).ok_or(SessionError::InvalidState)?;
    if fields.len() != columns.len() {
        return Err(SessionError::InvalidState);
    }
    let mut bytes = 0usize;
    for (field, (name, data)) in fields.iter().zip(columns) {
        let count = counts[field.counter]
            .checked_mul(field.factor)
            .ok_or(SessionError::ResourceLimit)?;
        if field.name != *name || field.kind != data.kind() || data.len() != count {
            return Err(SessionError::InvalidState);
        }
        bytes = bytes
            .checked_add(
                count
                    .checked_mul(field.bytes)
                    .and_then(|n| n.checked_add(3))
                    .ok_or(SessionError::ResourceLimit)?
                    & !3,
            )
            .ok_or(SessionError::ResourceLimit)?;
    }
    let metadata = packet::json_with_cancellation(metadata, Some(cancel))?;
    let start = (32 + metadata.len() + 3) & !3;
    let total = start
        .checked_add(bytes)
        .filter(|n| *n <= layout::MAX_PACKET_BYTES)
        .ok_or(SessionError::ResourceLimit)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(total)
        .map_err(|_| SessionError::ResourceLimit)?;
    output.extend(b"OXGV");
    for number in [
        layout::VERSION,
        kind,
        metadata.len(),
        counts[0],
        counts[1],
        counts[2],
        total,
    ] {
        output.extend((number as u32).to_le_bytes());
    }
    output.extend(metadata);
    output.resize(start, 0);
    for (_, data) in columns {
        data.write(&mut output, cancel)?;
    }
    if cancel.is_cancelled() {
        return Err(SessionError::Cancelled);
    }
    if output.len() != total {
        return Err(SessionError::InvalidState);
    }
    Ok(output)
}

#[derive(Serialize)]
#[serde(
    tag = "status",
    rename_all = "lowercase",
    rename_all_fields = "camelCase"
)]
enum PreviewMetadata<'a> {
    Ready {
        mode: &'a preview::ModeDefinition,
        source_record_count: usize,
        #[serde(skip_serializing_if = "Option::is_none")]
        range: &'a Option<preview::PreviewRange>,
        legend: &'a [preview::LegendEntry],
        limitations: &'a [preview::Limitation],
        #[serde(skip_serializing_if = "Option::is_none")]
        layer_time_provenance: &'a Option<crate::Text>,
    },
    Unsupported {
        mode: &'a preview::ModeDefinition,
        source_record_count: usize,
        missing_metadata: &'a [preview::MissingMetadata],
        limitations: &'a [preview::Limitation],
    },
}
pub(crate) fn preview(
    value: &preview::Preview,
    cancel: &Cancellation,
) -> Result<Vec<u8>, SessionError> {
    match value {
        preview::Preview::Ready {
            mode,
            source_record_count,
            count,
            record_indices,
            values,
            value_valid,
            colors_rgba,
            range,
            legend,
            limitations,
            layer_time_provenance,
        } => pack(
            layout::PREVIEW,
            [*count, 0, 0],
            &PreviewMetadata::Ready {
                mode,
                source_record_count: *source_record_count,
                range,
                legend,
                limitations,
                layer_time_provenance,
            },
            &[
                ("recordIndices", Data::U32(record_indices)),
                ("values", Data::F32(values)),
                ("valueValid", Data::U8(value_valid)),
                ("colorsRgba", Data::F32(colors_rgba)),
            ],
            cancel,
        ),
        preview::Preview::Unsupported {
            mode,
            source_record_count,
            missing_metadata,
            limitations,
        } => pack(
            layout::PREVIEW,
            [0, 0, 0],
            &PreviewMetadata::Unsupported {
                mode,
                source_record_count: *source_record_count,
                missing_metadata,
                limitations,
            },
            &[
                ("recordIndices", Data::U32(&[])),
                ("values", Data::F32(&[])),
                ("valueValid", Data::U8(&[])),
                ("colorsRgba", Data::F32(&[])),
            ],
            cancel,
        ),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct InspectionMetadata<'a> {
    source_record_count: usize,
    layer_selection: &'a Option<inspection::LayerSelection>,
    move_selection: &'a Option<inspection::MoveSelection>,
    current: &'a Option<inspection::Cursor>,
    tool_marker: &'a Option<inspection::ToolMarker>,
    source_window: &'a Option<inspection::SourceWindow>,
    focus_bounds: &'a Option<inspection::Bounds>,
    limitations: &'a [inspection::Limitation],
    tick_labels: Vec<&'a str>,
}
pub(crate) fn inspection(
    value: &inspection::Inspection,
    cancel: &Cancellation,
) -> Result<Vec<u8>, SessionError> {
    if value.record_indices.len() > layout::MAX_RECORDS
        || value.layers.count > layout::MAX_LAYERS
        || value.ticks.len() > layout::MAX_TICKS
    {
        return Err(SessionError::ResourceLimit);
    }
    let mut labels = Vec::new();
    let mut by_label = BTreeMap::new();
    let mut label_indices = Vec::with_capacity(value.ticks.len());
    let mut kinds = Vec::with_capacity(value.ticks.len());
    let mut records = Vec::with_capacity(value.ticks.len());
    let mut layers = Vec::with_capacity(value.ticks.len());
    let mut z = Vec::with_capacity(value.ticks.len());
    let mut source_lines = Vec::with_capacity(value.ticks.len());
    let mut starts = Vec::with_capacity(value.ticks.len());
    let mut ends = Vec::with_capacity(value.ticks.len());
    for (i, tick) in value.ticks.iter().enumerate() {
        if i.is_multiple_of(4096) && cancel.is_cancelled() {
            return Err(SessionError::Cancelled);
        }
        let next = labels.len() as u32;
        let index = *by_label.entry(tick.label.as_str()).or_insert_with(|| {
            labels.push(tick.label.as_str());
            next
        });
        label_indices.push(index);
        kinds.push(match tick.kind {
            "tool-change" => 4,
            "color-change" => 5,
            "pause" => 6,
            "custom" => 7,
            _ => return Err(SessionError::InvalidState),
        });
        records.push(tick.record);
        layers.push(tick.layer);
        z.push(tick.z_mm as f32);
        source_lines.push(tick.source_line);
        starts.push(tick.source_start_offset);
        ends.push(tick.source_end_offset);
    }
    let metadata = InspectionMetadata {
        source_record_count: value.source_record_count,
        layer_selection: &value.layer_selection,
        move_selection: &value.move_selection,
        current: &value.current,
        tool_marker: &value.tool_marker,
        source_window: &value.source_window,
        focus_bounds: &value.focus_bounds,
        limitations: &value.limitations,
        tick_labels: labels,
    };
    pack(
        layout::INSPECTION,
        [
            value.record_indices.len(),
            value.layers.count,
            value.ticks.len(),
        ],
        &metadata,
        &[
            ("recordIndices", Data::U32(&value.record_indices)),
            ("layerIds", Data::U32(&value.layers.layer_ids)),
            ("layerZMm", Data::F32(&value.layers.z_mm)),
            ("layerFirstRecord", Data::U32(&value.layers.first_record)),
            ("layerLastRecord", Data::U32(&value.layers.last_record)),
            ("tickKind", Data::U8(&kinds)),
            ("tickRecord", Data::U32(&records)),
            ("tickLayer", Data::U32(&layers)),
            ("tickZMm", Data::F32(&z)),
            ("tickSourceLine", Data::U32(&source_lines)),
            ("tickStartOffset", Data::U32(&starts)),
            ("tickEndOffset", Data::U32(&ends)),
            ("tickLabel", Data::U32(&label_indices)),
        ],
        cancel,
    )
}
pub(crate) fn playback(records: &[u32], cancel: &Cancellation) -> Result<Vec<u8>, SessionError> {
    pack(
        layout::PLAYBACK,
        [records.len(), 0, 0],
        &serde_json::json!({}),
        &[("recordIndices", Data::U32(records))],
        cancel,
    )
}
