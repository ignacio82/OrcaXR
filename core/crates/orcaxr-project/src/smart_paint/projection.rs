//! Projection of Smart Paint proposals onto mesh triangles (P4.9).
use std::f64::consts::PI;

use super::types::{
    SmartPaintErrorCode, SmartPaintProjection, SmartPaintProposal, SmartPaintProposalError,
    SmartPaintResolvedRegion, SmartPaintShape,
};

struct MeshBounds {
    min: [f64; 3],
    span: [f64; 3],
}

/// Project an assistant proposal onto a volume's mesh triangles.
/// Regions are applied in declared order, with later regions overwriting earlier ones.
pub fn project_proposal(
    proposal: &SmartPaintProposal,
    vertices: &[[f64; 3]],
    triangles: &[[u32; 3]],
    volume_id: &str,
    topology_revision: u64,
) -> Result<SmartPaintProjection, SmartPaintProposalError> {
    let triangle_count = triangles.len();
    if triangle_count == 0 {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::DegenerateMesh,
            "The target volume has no facets to paint",
        ));
    }

    let bounds = compute_mesh_bounds(vertices)?;

    // -1 means no region claims this facet; later regions overwrite.
    let mut owner = vec![-1i32; triangle_count];

    for (region_idx, region) in proposal.regions.iter().enumerate() {
        for (tri_idx, tri) in triangles.iter().enumerate() {
            let v0 = vertices.get(tri[0] as usize);
            let v1 = vertices.get(tri[1] as usize);
            let v2 = vertices.get(tri[2] as usize);
            if let (Some(&a), Some(&b), Some(&c)) = (v0, v1, v2)
                && matches_region(&region.shape, a, b, c, &bounds)
            {
                owner[tri_idx] = region_idx as i32;
            }
        }
    }

    let mut per_region: Vec<Vec<u32>> = vec![Vec::new(); proposal.regions.len()];
    let mut claimed = 0usize;

    for (tri_idx, &region_idx) in owner.iter().enumerate() {
        if region_idx >= 0 {
            per_region[region_idx as usize].push(tri_idx as u32);
            claimed += 1;
        }
    }

    let mut regions = Vec::with_capacity(proposal.regions.len());
    let mut weighted_confidence = 0.0f64;

    for (index, region) in proposal.regions.iter().enumerate() {
        let indices = &per_region[index];
        let coverage = indices.len() as f64 / triangle_count as f64;
        weighted_confidence += region.confidence * indices.len() as f64;
        regions.push(SmartPaintResolvedRegion {
            id: region.id.clone(),
            label: region.label.clone(),
            confidence: region.confidence,
            triangle_indices: indices.clone(),
            coverage,
        });
    }

    let confidence = if claimed == 0 {
        0.0
    } else {
        weighted_confidence / claimed as f64
    };

    Ok(SmartPaintProjection {
        volume_id: volume_id.to_string(),
        topology_revision,
        triangle_count,
        regions,
        coverage: claimed as f64 / triangle_count as f64,
        unassigned_triangle_count: triangle_count - claimed,
        confidence,
    })
}

fn compute_mesh_bounds(vertices: &[[f64; 3]]) -> Result<MeshBounds, SmartPaintProposalError> {
    if vertices.is_empty() {
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::DegenerateMesh,
            "The target volume has no vertices",
        ));
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
        return Err(SmartPaintProposalError::new(
            SmartPaintErrorCode::DegenerateMesh,
            "The target volume has no finite bounds",
        ));
    }

    let span = [
        max[0] - min[0],
        max[1] - min[1],
        max[2] - min[2],
    ];

    Ok(MeshBounds { min, span })
}

fn matches_region(
    shape: &SmartPaintShape,
    a: [f64; 3],
    b: [f64; 3],
    c: [f64; 3],
    bounds: &MeshBounds,
) -> bool {
    match shape {
        SmartPaintShape::Box { min, max } => {
            for axis in 0..3 {
                let centroid = (a[axis] + b[axis] + c[axis]) / 3.0;
                let normalized = if bounds.span[axis] == 0.0 {
                    0.0
                } else {
                    (centroid - bounds.min[axis]) / bounds.span[axis]
                };
                if normalized < min[axis] || normalized > max[axis] {
                    return false;
                }
            }
            true
        }
        SmartPaintShape::Direction {
            axis,
            max_angle_deg,
        } => {
            let normal = match triangle_normal(a, b, c) {
                Some(n) => n,
                None => return false,
            };
            let axis_unit = match normalize(*axis) {
                Some(a) => a,
                None => return false,
            };
            let dot = (normal[0] * axis_unit[0] + normal[1] * axis_unit[1] + normal[2] * axis_unit[2])
                .clamp(-1.0, 1.0);
            let angle_deg = dot.acos() * 180.0 / PI;
            angle_deg <= *max_angle_deg
        }
    }
}

fn triangle_normal(a: [f64; 3], b: [f64; 3], c: [f64; 3]) -> Option<[f64; 3]> {
    let ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    let cross = [
        ab[1] * ac[2] - ab[2] * ac[1],
        ab[2] * ac[0] - ab[0] * ac[2],
        ab[0] * ac[1] - ab[1] * ac[0],
    ];
    normalize(cross)
}

fn normalize(v: [f64; 3]) -> Option<[f64; 3]> {
    let len = (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt();
    if !len.is_finite() || len <= 1e-18 {
        None
    } else {
        Some([v[0] / len, v[1] / len, v[2] / len])
    }
}
