//! Strict Smart Paint proposal parsing and validation (P4.9).
use serde_json::Value;

use super::types::{
    AI_PAINT_MAX_LABEL_LENGTH, AI_PAINT_MAX_REGIONS, AI_PAINT_PROPOSAL_VERSION,
    SmartPaintErrorCode, SmartPaintProposal, SmartPaintProposalError, SmartPaintRegionProposal,
    SmartPaintShape,
};

/// Strictly parse and validate an assistant proposal string.
pub fn parse_proposal(raw_json: &str) -> Result<SmartPaintProposal, SmartPaintProposalError> {
    let value: Value = serde_json::from_str(raw_json).map_err(|err| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedProposal,
            format!("The assistant response is not valid JSON: {err}"),
        )
    })?;

    let root = match value.as_object() {
        Some(obj) => obj,
        None => {
            return Err(SmartPaintProposalError::new(
                SmartPaintErrorCode::MalformedProposal,
                "The assistant response is not a JSON object",
            ));
        }
    };

    let schema_version = root
        .get("schemaVersion")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| {
            SmartPaintProposalError::new(
                SmartPaintErrorCode::UnsupportedVersion,
                "Missing or invalid schemaVersion",
            )
        })?;

    if schema_version != AI_PAINT_PROPOSAL_VERSION as u64 {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::UnsupportedVersion,
            format!(
                "Expected proposal schema {}, received {}",
                AI_PAINT_PROPOSAL_VERSION, schema_version
            ),
        ));
    }

    let regions_array = root
        .get("regions")
        .and_then(|v| v.as_array())
        .ok_or_else(|| {
            SmartPaintProposalError::new(
                SmartPaintErrorCode::MalformedProposal,
                "The assistant response has no region list",
            )
        })?;

    if regions_array.is_empty() {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::EmptyProposal,
            "The assistant proposed no regions",
        ));
    }

    if regions_array.len() > AI_PAINT_MAX_REGIONS {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::TooManyRegions,
            format!(
                "The assistant proposed {} regions; at most {} are accepted",
                regions_array.len(),
                AI_PAINT_MAX_REGIONS
            ),
        ));
    }

    let mut regions = Vec::with_capacity(regions_array.len());
    for (index, item) in regions_array.iter().enumerate() {
        regions.push(parse_region(item, index)?);
    }

    Ok(SmartPaintProposal {
        schema_version: AI_PAINT_PROPOSAL_VERSION,
        regions,
    })
}

fn parse_region(raw: &Value, index: usize) -> Result<SmartPaintRegionProposal, SmartPaintProposalError> {
    let obj = raw.as_object().ok_or_else(|| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} is not an object", index + 1),
        )
    })?;

    let label_str = obj
        .get("label")
        .and_then(|v| v.as_str())
        .map(|s| s.trim())
        .ok_or_else(|| {
            SmartPaintProposalError::new(
                SmartPaintErrorCode::MalformedRegion,
                format!(
                    "Region {} needs a label of 1–{} characters",
                    index + 1,
                    AI_PAINT_MAX_LABEL_LENGTH
                ),
            )
        })?;

    if label_str.is_empty() || label_str.chars().count() > AI_PAINT_MAX_LABEL_LENGTH {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!(
                "Region {} needs a label of 1–{} characters",
                index + 1,
                AI_PAINT_MAX_LABEL_LENGTH
            ),
        ));
    }

    let confidence = obj
        .get("confidence")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| {
            SmartPaintProposalError::new(
                SmartPaintErrorCode::MalformedRegion,
                format!("Region {} needs a confidence in [0, 1]", index + 1),
            )
        })?;

    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} needs a confidence in [0, 1]", index + 1),
        ));
    }

    let shape_val = obj.get("shape").ok_or_else(|| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} has no shape", index + 1),
        )
    })?;

    let shape = parse_shape(shape_val, index)?;

    Ok(SmartPaintRegionProposal {
        id: format!("ai-region-{}", index + 1),
        label: label_str.to_string(),
        confidence,
        shape,
    })
}

fn parse_shape(raw: &Value, index: usize) -> Result<SmartPaintShape, SmartPaintProposalError> {
    let obj = raw.as_object().ok_or_else(|| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} has no shape", index + 1),
        )
    })?;

    let kind = obj.get("kind").and_then(|v| v.as_str()).unwrap_or("");
    match kind {
        "box" => {
            let min = parse_vec3(obj.get("min"), index, "min")?;
            let max = parse_vec3(obj.get("max"), index, "max")?;
            for axis in 0..3 {
                if min[axis] < 0.0 || max[axis] > 1.0 || max[axis] < min[axis] {
                    return Err(SmartPaintProposalError::new(
                        SmartPaintErrorCode::MalformedRegion,
                        format!(
                            "Region {} needs a non-inverted box inside the normalized [0, 1] volume",
                            index + 1
                        ),
                    ));
                }
            }
            Ok(SmartPaintShape::Box { min, max })
        }
        "direction" => {
            let axis = parse_vec3(obj.get("axis"), index, "axis")?;
            let len_sq = axis[0] * axis[0] + axis[1] * axis[1] + axis[2] * axis[2];
            if !len_sq.is_finite() || len_sq <= 1e-18 {
                return Err(SmartPaintProposalError::new(
                    SmartPaintErrorCode::MalformedRegion,
                    format!("Region {} has a zero-length direction axis", index + 1),
                ));
            }
            let max_angle = obj
                .get("maxAngleDeg")
                .and_then(|v| v.as_f64())
                .ok_or_else(|| {
                    SmartPaintProposalError::new(
                        SmartPaintErrorCode::MalformedRegion,
                        format!(
                            "Region {} needs a direction half-angle in (0, 180] degrees",
                            index + 1
                        ),
                    )
                })?;
            if !max_angle.is_finite() || max_angle <= 0.0 || max_angle > 180.0 {
                return Err(SmartPaintProposalError::new(
                    SmartPaintErrorCode::MalformedRegion,
                    format!(
                        "Region {} needs a direction half-angle in (0, 180] degrees",
                        index + 1
                    ),
                ));
            }
            Ok(SmartPaintShape::Direction {
                axis,
                max_angle_deg: max_angle,
            })
        }
        other => Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} uses unsupported shape kind {other}", index + 1),
        )),
    }
}

fn parse_vec3(
    raw: Option<&Value>,
    index: usize,
    field: &str,
) -> Result<[f64; 3], SmartPaintProposalError> {
    let arr = raw.and_then(|v| v.as_array()).ok_or_else(|| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} field {field} must be three numbers", index + 1),
        )
    })?;

    if arr.len() != 3 {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedRegion,
            format!("Region {} field {field} must be three numbers", index + 1),
        ));
    }

    let mut out = [0.0; 3];
    for (i, v) in arr.iter().enumerate() {
        let val = v.as_f64().ok_or_else(|| {
            SmartPaintProposalError::new(
                SmartPaintErrorCode::MalformedRegion,
                format!("Region {} field {field} must be three numbers", index + 1),
            )
        })?;
        if !val.is_finite() {
            return Err(SmartPaintProposalError::new(
                SmartPaintErrorCode::MalformedRegion,
                format!("Region {} field {field} must be finite", index + 1),
            ));
        }
        out[i] = val;
    }

    Ok(out)
}
