//! Paint overlay packets (`PaintOverlay.ts`): the facets a renderer draws for
//! one volume's channel — every assigned leaf of the materialized refinement
//! when the channel is subdivided, otherwise each region's whole facets in
//! order — as a summary of their states and packets of
//! [`FACET_BYTES`]-byte facets: nine little-endian float32 corners in volume
//! space, then a little-endian uint32 index into the summary's states.
use super::Channel;
use super::region::{self, Assignment, Mesh, RegionError, RegionState, Request, Tool};
use super::region_exchange::{assignments, channel_of, state_wire};
use crate::{assets::AssetRepository, mesh::decode_indexed, store::ProjectSnapshot};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

/// The most facets one packet holds.
pub const MAX_PAGE: u64 = 16384;
/// Bytes per packed facet.
pub const FACET_BYTES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A packet larger than [`MAX_PAGE`].
    InvalidRequest,
    UnknownVolume,
    /// The volume's mesh asset is missing or not a readable indexed mesh.
    InvalidMesh,
    /// Annotations the materializer refuses.
    InvalidAnnotations,
    Disposed,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnknownVolume => "unknown_volume",
            Self::InvalidMesh => "invalid_mesh",
            Self::InvalidAnnotations => "invalid_annotations",
            Self::Disposed => "disposed",
        }
    }
}

/// One overlay region: whole source facets drawn in one state.
pub struct Region {
    pub triangles: Vec<f64>,
    pub state: RegionState,
}

/// One overlay's facets under the facet guard of the state they were drawn
/// from.
#[derive(Debug, Clone, PartialEq)]
pub struct Overlay {
    guard: wire::FacetGuard,
    positions: Vec<f32>,
    state_indices: Vec<u32>,
    states: Vec<RegionState>,
}

impl Overlay {
    /// `paintOverlayFacets`: with a refinement every region must be assigned,
    /// as canonical assignments are; it is materialized over them and each
    /// assigned leaf drawn in leaf order. Without one each region's facets are
    /// drawn in region order.
    pub fn draw(
        guard: wire::FacetGuard,
        mesh: Mesh<'_>,
        channel: Channel,
        regions: &[Region],
        refinement: Option<&Value>,
    ) -> Result<Self, Refusal> {
        let mut overlay = Self {
            guard,
            positions: Vec::new(),
            state_indices: Vec::new(),
            states: Vec::new(),
        };
        let Some(refinement) = refinement else {
            for region in regions {
                for &triangle in &region.triangles {
                    let corners = mesh
                        .triangles
                        .get(triangle as usize)
                        .ok_or(Refusal::InvalidAnnotations)?;
                    overlay.push(mesh.vertices, corners.map(|v| v as usize), &region.state)?;
                }
            }
            return Ok(overlay);
        };
        let assigned = regions
            .iter()
            .map(|region| match &region.state {
                RegionState::Assigned(value) => Ok(Assignment {
                    value: value.clone(),
                    triangles: region.triangles.clone(),
                }),
                RegionState::Unpainted => Err(Refusal::InvalidAnnotations),
            })
            .collect::<Result<Vec<_>, _>>()?;
        let topology = overlay.guard.topology_revision as f64;
        let materialized = region::materialize(&Request {
            mesh,
            channel,
            annotations_topology_revision: topology,
            assignments: &assigned,
            guard_topology_revision: topology,
            guard_triangle_count: overlay.guard.triangle_count as f64,
            seed_triangle: 0.0,
            tool: Tool::Triangle { hit: None },
            clipping_plane: None,
            transform: None,
            highlight_by_angle_degrees: None,
            refinement: Some(refinement),
            refined_roots: None,
        })
        .map_err(|_: RegionError| Refusal::InvalidAnnotations)?;
        for leaf in &materialized.leaves {
            if matches!(leaf.state, RegionState::Assigned(_)) {
                overlay.push(
                    &materialized.vertices,
                    leaf.vertex_indices.map(|v| v as usize),
                    &leaf.state,
                )?;
            }
        }
        Ok(overlay)
    }

    fn push(
        &mut self,
        vertices: &[[f64; 3]],
        corners: [usize; 3],
        state: &RegionState,
    ) -> Result<(), Refusal> {
        for corner in corners {
            let vertex = vertices.get(corner).ok_or(Refusal::InvalidAnnotations)?;
            self.positions.extend(vertex.map(|v| v as f32));
        }
        let index = match self.states.iter().position(|known| known == state) {
            Some(index) => index,
            None => {
                self.states.push(state.clone());
                self.states.len() - 1
            }
        };
        self.state_indices.push(index as u32);
        Ok(())
    }

    pub fn facet_count(&self) -> usize {
        self.state_indices.len()
    }

    pub fn summary(&self) -> wire::PaintOverlaySummary {
        wire::PaintOverlaySummary {
            guard: self.guard.clone(),
            facets: self.state_indices.len() as u64,
            states: self.states.iter().map(state_wire).collect(),
        }
    }

    /// Facets `[start, start + count)` as one packet, clamped to the facets
    /// drawn.
    pub fn packet(&self, start: u64, count: u64) -> Result<Vec<u8>, Refusal> {
        if count > MAX_PAGE {
            return Err(Refusal::InvalidRequest);
        }
        let total = self.state_indices.len();
        let from = usize::try_from(start).unwrap_or(usize::MAX).min(total);
        let to = from.saturating_add(count as usize).min(total);
        let mut packet = Vec::with_capacity((to - from) * FACET_BYTES);
        for facet in from..to {
            for value in &self.positions[facet * 9..facet * 9 + 9] {
                packet.extend(value.to_le_bytes());
            }
            packet.extend(self.state_indices[facet].to_le_bytes());
        }
        Ok(packet)
    }
}

/// The canonical overlay of one volume's channel in an acknowledged snapshot,
/// as the workspace draws it.
pub fn capture(
    snapshot: &ProjectSnapshot,
    assets: &AssetRepository,
    request: &wire::PaintOverlayRequest,
) -> Result<Overlay, Refusal> {
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
    let regions: Vec<Region> = assignments(match channel {
        Channel::Color => annotations.color.value(),
        Channel::Support => annotations.support.value(),
        Channel::Seam => annotations.seam.value(),
        Channel::FuzzySkin => annotations.fuzzy_skin.value(),
        Channel::Brim => annotations.brim.value(),
    })
    .into_iter()
    .map(|assignment| Region {
        triangles: assignment.triangles,
        state: RegionState::Assigned(assignment.value),
    })
    .collect();
    let refinement = annotations.refinement.as_ref().and_then(|refinement| {
        let Value::Object(channels) = refinement.value() else {
            return None;
        };
        channels
            .get(&channel.name().encode_utf16().collect::<Vec<_>>())
            .cloned()
    });
    Overlay::draw(
        wire::FacetGuard {
            revision: snapshot.revision(),
            hash: snapshot.hash().encode_utf16().collect(),
            volume_id: volume.id.as_utf16().to_vec(),
            topology_revision: volume.source.topology_revision.get() as u64,
            triangle_count: volume.source.triangle_count.get() as u64,
        },
        Mesh {
            vertices: &decoded.positions,
            triangles: &triangles,
        },
        channel,
        &regions,
        refinement.as_ref(),
    )
}

/// Assigned value regions from a collapsed channel, in its order.
pub(super) fn assigned_regions(assignments: &[super::Assignment]) -> Vec<Region> {
    assignments
        .iter()
        .map(|assignment| Region {
            triangles: assignment.triangles.iter().map(|t| t.number()).collect(),
            state: RegionState::Assigned(assignment.value.clone()),
        })
        .collect()
}
