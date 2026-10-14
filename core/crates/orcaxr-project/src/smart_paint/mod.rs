//! Smart Paint assistant proposal validation, geometric projection, and commit planning (P4.9).
pub mod plan;
pub mod projection;
pub mod proposal;
pub mod types;

pub use plan::{build_smart_paint_batch, channel_label, parse_channel};
pub use projection::project_proposal;
pub use proposal::parse_proposal;
pub use types::*;

/// Validate raw proposal JSON string and re-serialize if valid.
pub fn validate_proposal_json(raw_json: &str) -> Result<String, SmartPaintProposalError> {
    let proposal = parse_proposal(raw_json)?;
    serde_json::to_string(&proposal).map_err(|e| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedProposal,
            format!("Serialization error: {e}"),
        )
    })
}

/// Project proposal JSON onto mesh geometry and return serialized SmartPaintProjection JSON.
pub fn project_proposal_json(
    proposal_json: &str,
    vertices: &[[f64; 3]],
    triangles: &[[u32; 3]],
    volume_id: &str,
    topology_revision: u64,
) -> Result<String, SmartPaintProposalError> {
    let proposal = parse_proposal(proposal_json)?;
    let projection =
        project_proposal(&proposal, vertices, triangles, volume_id, topology_revision)?;
    serde_json::to_string(&projection).map_err(|e| {
        SmartPaintProposalError::new(
            SmartPaintErrorCode::MalformedProposal,
            format!("Serialization error: {e}"),
        )
    })
}

/// Produce the minimal geometry descriptor for an assistant request
/// (facet count and bounding extent mm only — never vertices or IDs).
pub fn describe_geometry(vertices: &[[f64; 3]], triangles: &[[u32; 3]]) -> Option<serde_json::Value> {
    if vertices.is_empty() || triangles.is_empty() {
        return None;
    }
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for v in vertices {
        for axis in 0..3 {
            if v[axis] < min[axis] {
                min[axis] = v[axis];
            }
            if v[axis] > max[axis] {
                max[axis] = v[axis];
            }
        }
    }
    if !min.iter().all(|x| x.is_finite()) || !max.iter().all(|x| x.is_finite()) {
        return None;
    }
    let extent = [
        max[0] - min[0],
        max[1] - min[1],
        max[2] - min[2],
    ];
    Some(serde_json::json!({
        "triangleCount": triangles.len(),
        "extentMm": extent,
    }))
}
