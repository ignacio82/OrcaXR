use crate::{Model, SessionError, layout};
use serde::Serialize;
use std::io::{self, Write};

pub(crate) struct BoundedJson {
    bytes: Vec<u8>,
    maximum: usize,
}
impl Write for BoundedJson {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        let end = self
            .bytes
            .len()
            .checked_add(data.len())
            .filter(|end| *end <= self.maximum)
            .ok_or_else(|| io::Error::other("metadata limit"))?;
        if end > self.bytes.capacity() {
            let capacity = end
                .max(self.bytes.capacity().max(512).saturating_mul(2))
                .min(self.maximum);
            self.bytes
                .try_reserve_exact(capacity - self.bytes.len())
                .map_err(io::Error::other)?;
        }
        self.bytes.extend_from_slice(data);
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
pub(crate) fn json(value: &impl Serialize) -> Result<Vec<u8>, SessionError> {
    let mut writer = BoundedJson {
        bytes: Vec::new(),
        maximum: layout::MAX_METADATA_BYTES,
    };
    serde_json::to_writer(&mut writer, value).map_err(|_| SessionError::ResourceLimit)?;
    Ok(writer.bytes)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Metadata<'a> {
    #[serde(skip_serializing_if = "Option::is_none")]
    record_offset: Option<usize>,
    roles: &'a [crate::Text],
    filaments: &'a [crate::Filament],
    layer_count: u32,
    warnings: &'a [crate::Warning],
    source_length: usize,
    parsed_characters: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_line_offset: Option<usize>,
    parsed_lines: usize,
    complete: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    termination_reason: Option<crate::Termination>,
    limits: crate::Limits,
}

/// An owned, little-endian packet. No view into reallocatable WASM memory or
/// parser storage survives this operation. Headers and each column align to 4.
pub fn pack(model: &Model) -> Result<Vec<u8>, SessionError> {
    if model.columns.count > layout::MAX_WINDOW_RECORDS
        || model.path_points.count > layout::MAX_PATH_POINTS
    {
        return Err(SessionError::ResourceLimit);
    }
    if !layout::valid_lengths(model) {
        return Err(SessionError::InvalidState);
    }
    let metadata = json(&Metadata {
        record_offset: model.record_offset,
        roles: &model.roles,
        filaments: &model.filaments,
        layer_count: model.layer_count,
        warnings: &model.warnings,
        source_length: model.source_length,
        parsed_characters: model.parsed_characters,
        source_line_offset: model.source_line_offset,
        parsed_lines: model.parsed_lines,
        complete: model.complete,
        termination_reason: model.termination_reason,
        limits: model.limits,
    })?;
    let data_start = (24 + metadata.len() + 3) & !3;
    let total = layout::columns_bytes(model.columns.count, model.path_points.count)
        .and_then(|bytes| bytes.checked_add(data_start))
        .filter(|bytes| *bytes <= layout::MAX_PACKET_BYTES)
        .ok_or(SessionError::ResourceLimit)?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(total)
        .map_err(|_| SessionError::ResourceLimit)?;
    bytes.extend_from_slice(b"OXGP");
    for value in [
        layout::VERSION,
        metadata.len(),
        model.columns.count,
        model.path_points.count,
        total,
    ] {
        bytes.extend_from_slice(&(value as u32).to_le_bytes());
    }
    bytes.extend(metadata);
    bytes.resize(data_start, 0);
    layout::write_columns(model, &mut bytes);
    if bytes.len() != total {
        return Err(SessionError::InvalidState);
    }
    Ok(bytes)
}
