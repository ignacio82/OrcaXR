//! Region selection over a live session (`FacetRegionExchange.ts`): a host names
//! a volume and a tool, the session decodes that volume's mesh and reads its
//! annotations, and the reply is a page of the selected ranges with the facet
//! guard a `facetStroke` intent commits them under. Invalid tool input reports
//! the selector's own issues; an oversized page, an unknown volume or an
//! unreadable mesh refuses.
use super::region::{
    self, Assignment, Brush, ClippingPlane, Mesh, RegionError, RegionState, Request, Tool,
    Transform,
};
use super::{Channel, PaintValue, validation::Issue};
use crate::{assets::AssetRepository, mesh::decode_indexed, store::ProjectSnapshot};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

/// The most ranges, and the most Gap Fill replacements, one page holds.
pub const MAX_PAGE: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A page larger than [`MAX_PAGE`].
    InvalidRequest,
    UnknownVolume,
    /// The volume's mesh asset is missing or not a readable indexed mesh.
    InvalidMesh,
    Disposed,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnknownVolume => "unknown_volume",
            Self::InvalidMesh => "invalid_mesh",
            Self::Disposed => "disposed",
        }
    }
}

/// Answer one request over a live session's acknowledged state.
pub fn session_reply<P: crate::validation::TimestampPolicy>(
    session: &crate::session::ProjectSession<P>,
    request: &wire::FacetRegionRequest,
) -> Result<wire::FacetRegionReply, Refusal> {
    if session.is_disposed() {
        return Err(Refusal::Disposed);
    }
    reply(&session.snapshot(), session.assets(), request)
}

/// Answer one request against an acknowledged snapshot and its assets.
pub fn reply(
    snapshot: &ProjectSnapshot,
    assets: &AssetRepository,
    request: &wire::FacetRegionRequest,
) -> Result<wire::FacetRegionReply, Refusal> {
    if request.count > MAX_PAGE {
        return Err(Refusal::InvalidRequest);
    }
    let state = snapshot.state();
    let volume = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.volumes.iter())
        .find(|volume| volume.id.as_utf16() == request.volume_id.as_slice())
        .ok_or(Refusal::UnknownVolume)?;
    let lease = assets
        .peek(&volume.source.asset_id)
        .ok_or(Refusal::InvalidMesh)?;
    let decoded = decode_indexed(&lease).map_err(|_| Refusal::InvalidMesh)?;
    let triangles: Vec<[f64; 3]> = decoded
        .indices
        .chunks_exact(3)
        .map(|t| [t[0] as f64, t[1] as f64, t[2] as f64])
        .collect();
    let channel = channel_of(&request.channel);
    let annotations = &volume.annotations;
    let assignments = assignments(match channel {
        Channel::Color => annotations.color.value(),
        Channel::Support => annotations.support.value(),
        Channel::Seam => annotations.seam.value(),
        Channel::FuzzySkin => annotations.fuzzy_skin.value(),
        Channel::Brim => annotations.brim.value(),
    });
    let topology = volume.source.topology_revision.get();
    let triangle_count = volume.source.triangle_count.get();
    let selection = region::select(&Request {
        mesh: Mesh {
            vertices: &decoded.positions,
            triangles: &triangles,
        },
        channel,
        annotations_topology_revision: annotations.topology_revision.get(),
        assignments: &assignments,
        guard_topology_revision: topology,
        guard_triangle_count: triangle_count,
        seed_triangle: request.seed_triangle as f64,
        tool: region_tool(&request.tool),
        clipping_plane: clipping_plane(&request.clipping_plane),
        transform: transform_of(&request.transform),
        highlight_by_angle_degrees: optional(&request.highlight_by_angle_degrees),
        // Refined replies (prior refinement, triangle splitting) are a later
        // step; the exchange selects source facets as the browser's does.
        refinement: None,
        refined_roots: None,
    });
    let selection = match selection {
        Ok(selection) => selection,
        Err(RegionError::Invalid(issues)) => {
            return Ok(wire::FacetRegionReply::Invalid(issues_wire(&issues)));
        }
        Err(RegionError::StaleTopology) => {
            return Ok(wire::FacetRegionReply::Stale(wire::Empty {}));
        }
    };
    let window = |len: usize| {
        let start = usize::try_from(request.start)
            .unwrap_or(usize::MAX)
            .min(len);
        start..start.saturating_add(request.count as usize).min(len)
    };
    let replacements = selection.gap_fill_replacements.unwrap_or_default();
    Ok(wire::FacetRegionReply::Page(wire::FacetRegionPage {
        guard: wire::FacetGuard {
            revision: snapshot.revision(),
            hash: snapshot.hash().encode_utf16().collect(),
            volume_id: volume.id.as_utf16().to_vec(),
            topology_revision: topology as u64,
            triangle_count: triangle_count as u64,
        },
        selected_triangles: selection.triangle_indices.len() as u64,
        total_ranges: selection.ranges.len() as u64,
        ranges: ranges_wire(&selection.ranges[window(selection.ranges.len())]),
        total_replacements: replacements.len() as u64,
        replacements: replacements[window(replacements.len())]
            .iter()
            .map(|r| wire::FacetGapFillReplacement {
                area_mm2: r.area_mm2,
                source: state_wire(&r.source),
                target: state_wire(&r.target),
                triangle_count: r.triangle_indices.len() as u64,
                ranges: ranges_wire(&r.ranges),
            })
            .collect(),
    }))
}

pub(super) fn channel_of(name: &wire::FacetChannelName) -> Channel {
    match name {
        wire::FacetChannelName::Color => Channel::Color,
        wire::FacetChannelName::Support => Channel::Support,
        wire::FacetChannelName::Seam => Channel::Seam,
        wire::FacetChannelName::FuzzySkin => Channel::FuzzySkin,
        wire::FacetChannelName::Brim => Channel::Brim,
    }
}

/// Canonical `[{ value, triangles }]` as the selector reads it.
pub(super) fn assignments(value: &Value) -> Vec<Assignment> {
    let Value::Array(entries) = value else {
        return Vec::new();
    };
    entries
        .iter()
        .filter_map(|entry| {
            let Value::Object(fields) = entry else {
                return None;
            };
            let value = fields
                .get(&units("value"))
                .and_then(PaintValue::from_value)?;
            let triangles = match fields.get(&units("triangles")) {
                Some(Value::Array(list)) => list
                    .iter()
                    .filter_map(|t| match t {
                        Value::Number(n) => Some(*n),
                        _ => None,
                    })
                    .collect(),
                _ => Vec::new(),
            };
            Some(Assignment { value, triangles })
        })
        .collect()
}

/// A wire tool as the selector takes it.
pub(super) fn region_tool(wire: &wire::FacetRegionTool) -> Tool {
    let hit = |value: &wire::OptionalVector| match value {
        wire::OptionalVector::Value(v) => Some(vector(v)),
        wire::OptionalVector::Absent(_) => None,
    };
    let brush = |b: &wire::FacetRegionBrush| Brush {
        center: vector(&b.center),
        previous_center: hit(&b.previous_center),
        camera_position: vector(&b.camera_position),
        radius_mm: b.radius_mm,
        triangle_splitting: None,
    };
    match wire {
        wire::FacetRegionTool::Triangle(t) => Tool::Triangle { hit: hit(&t.hit) },
        wire::FacetRegionTool::Fill(f) => Tool::Fill {
            hit: hit(&f.hit),
            edge_detection: optional(&f.max_adjacent_angle_degrees),
        },
        wire::FacetRegionTool::HeightRange(h) => Tool::HeightRange {
            start_z_mm: h.start_z_mm,
            height_mm: h.height_mm,
            triangle_splitting: None,
        },
        wire::FacetRegionTool::GapFill(g) => Tool::GapFill {
            max_area_mm2: g.max_area_mm2,
            state_order: g.state_order.iter().map(paint).collect(),
        },
        wire::FacetRegionTool::Circle(b) => Tool::Circle(brush(b)),
        wire::FacetRegionTool::Sphere(b) => Tool::Sphere(brush(b)),
    }
}

fn paint(value: &wire::PaintValueInput) -> PaintValue {
    match value {
        wire::PaintValueInput::Text(text) => PaintValue::text(text.clone()),
        wire::PaintValueInput::Flag(flag) => PaintValue::Bool(*flag),
    }
}

/// A wire paint state as the selector takes it.
pub(super) fn state_of(wire: &wire::FacetRegionState) -> RegionState {
    match wire {
        wire::FacetRegionState::Unpainted(_) => RegionState::Unpainted,
        wire::FacetRegionState::Assigned(value) => RegionState::Assigned(paint(value)),
    }
}

pub(super) fn clipping_plane(wire: &wire::OptionalFacetClippingPlane) -> Option<ClippingPlane> {
    match wire {
        wire::OptionalFacetClippingPlane::Value(p) => Some(ClippingPlane {
            normal: vector(&p.normal),
            offset: p.offset,
        }),
        wire::OptionalFacetClippingPlane::Absent(_) => None,
    }
}

pub(super) fn transform_of(wire: &wire::OptionalFacetSelectionTransform) -> Option<Transform> {
    match wire {
        wire::OptionalFacetSelectionTransform::Value(t) => Some(Transform {
            linear: [
                vector(&t.linear[0]),
                vector(&t.linear[1]),
                vector(&t.linear[2]),
            ],
            translation: vector(&t.translation),
            scaling_factors: vector(&t.scaling_factors),
        }),
        wire::OptionalFacetSelectionTransform::Absent(_) => None,
    }
}

pub(super) fn issues_wire(issues: &[Issue]) -> Vec<wire::FacetRegionIssue> {
    issues
        .iter()
        .map(|issue| wire::FacetRegionIssue {
            code: units(issue.code),
            path: units(&issue.path),
            message: units(&issue.message),
        })
        .collect()
}

pub(super) fn state_wire(state: &RegionState) -> wire::FacetRegionState {
    match state {
        RegionState::Unpainted => wire::FacetRegionState::Unpainted(wire::Empty {}),
        RegionState::Assigned(PaintValue::Text(text)) => {
            wire::FacetRegionState::Assigned(wire::PaintValueInput::Text(text.to_vec()))
        }
        RegionState::Assigned(PaintValue::Bool(flag)) => {
            wire::FacetRegionState::Assigned(wire::PaintValueInput::Flag(*flag))
        }
    }
}

pub(super) fn ranges_wire(ranges: &[(u32, u32)]) -> Vec<wire::TriangleRangeInput> {
    ranges
        .iter()
        .map(|&(start, end)| wire::TriangleRangeInput {
            start: u64::from(start),
            end_exclusive: u64::from(end),
        })
        .collect()
}

pub(super) fn optional(value: &wire::OptionalFinite) -> Option<f64> {
    match value {
        wire::OptionalFinite::Value(v) => Some(*v),
        wire::OptionalFinite::Absent(_) => None,
    }
}

fn vector(v: &[f64]) -> [f64; 3] {
    [v[0], v[1], v[2]]
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
