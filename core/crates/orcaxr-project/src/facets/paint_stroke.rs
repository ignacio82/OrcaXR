//! Paint strokes over a live session (`PaintStrokeExchange.ts`): a host opens
//! a stroke on one volume and channel with its paint target, streams pointer
//! samples, reads the accumulated overlay, and stages the gesture as one
//! undoable edit, as the workspace's painter drives `PaintStrokeService`.
//!
//! A stroke owns what it selects over — the opened snapshot's decoded mesh,
//! the channel's assignments and persisted refinement — so samples run off
//! the session's authority. Each sample selects over that snapshot and the
//! tree the samples before it left; nothing reaches canonical state until the
//! staged commit, which carries the opened snapshot's guards, so a project
//! that changed meanwhile refuses it as stale.
use super::overlay::{self, Overlay, Region};
use super::palette::project_palette;
use super::region::{
    self, Assignment, EncodedNode, Mesh, RegionError, RegionState, Request, Roots,
};
use super::region_exchange::{
    assignments, channel_of, clipping_plane, issues_wire, optional, ranges_wire, region_tool,
    state_of, transform_of,
};
use super::{Channel, FacetChannel, FacetError, Node, PaintValue, State};
use crate::commands::{
    FacetRefinement,
    staged::{CaptureError, CapturedCommand, StagedWork},
};
use crate::ids::VolumeId;
use crate::model::{ProjectState, Text, VolumeRole};
use crate::{assets::AssetRepository, mesh::decode_indexed, store::ProjectSnapshot};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

/// The most overlay ranges one page holds.
pub const MAX_PAGE: u64 = 4096;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A channel no paint surface authors (brim), or a page over [`MAX_PAGE`].
    InvalidRequest,
    UnknownVolume,
    /// Modifiers, negative volumes and support volumes are not painted.
    UnsupportedRole,
    /// The volume's mesh asset is missing or not a readable indexed mesh.
    InvalidMesh,
    /// A state the channel cannot hold.
    InvalidTarget,
    UnknownFilament,
    UnavailableFilament,
    /// The guard a stroke opens under no longer describes the session.
    Stale,
    Disposed,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::UnknownVolume => "unknown_volume",
            Self::UnsupportedRole => "unsupported_role",
            Self::InvalidMesh => "invalid_mesh",
            Self::InvalidTarget => "invalid_target",
            Self::UnknownFilament => "unknown_filament",
            Self::UnavailableFilament => "unavailable_filament",
            Self::Stale => "stale",
            Self::Disposed => "disposed",
        }
    }
}

/// One open gesture.
pub struct PaintStroke {
    guard: wire::FacetGuard,
    channel: Channel,
    target: RegionState,
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[f64; 3]>,
    annotations_topology_revision: f64,
    assignments: Vec<Assignment>,
    /// The channel's persisted refinement, until a sample leaves a tree.
    persisted: Option<Value>,
    touched: Vec<bool>,
    /// Touched facets in the order a sample first touched them.
    touched_order: Vec<u32>,
    refinement: Option<Vec<EncodedNode>>,
    /// The session guard a session-opened stroke stages its commit under.
    pub(crate) session_guard: Option<crate::session::LocalGuard>,
}

impl PaintStroke {
    /// Open a stroke against an acknowledged snapshot and its assets, with the
    /// browser's checks in its order: channel, volume, role, target, mesh.
    pub fn open(
        snapshot: &ProjectSnapshot,
        assets: &AssetRepository,
        request: &wire::PaintStrokeOpen,
    ) -> Result<Self, Refusal> {
        let channel = channel_of(&request.channel);
        if channel == Channel::Brim {
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
        if volume.role != VolumeRole::Model {
            return Err(Refusal::UnsupportedRole);
        }
        let target = state_of(&request.target);
        if let RegionState::Assigned(value) = &target {
            check_target(state, channel, value)?;
        }
        let lease = assets
            .peek(&volume.source.asset_id)
            .ok_or(Refusal::InvalidMesh)?;
        let decoded = decode_indexed(&lease).map_err(|_| Refusal::InvalidMesh)?;
        let annotations = &volume.annotations;
        let triangle_count = volume.source.triangle_count.get();
        Ok(Self {
            guard: wire::FacetGuard {
                revision: snapshot.revision(),
                hash: snapshot.hash().encode_utf16().collect(),
                volume_id: volume.id.as_utf16().to_vec(),
                topology_revision: volume.source.topology_revision.get() as u64,
                triangle_count: triangle_count as u64,
            },
            channel,
            target,
            triangles: decoded
                .indices
                .chunks_exact(3)
                .map(|t| [t[0] as f64, t[1] as f64, t[2] as f64])
                .collect(),
            vertices: decoded.positions,
            annotations_topology_revision: annotations.topology_revision.get(),
            assignments: assignments(match channel {
                Channel::Color => annotations.color.value(),
                Channel::Support => annotations.support.value(),
                Channel::Seam => annotations.seam.value(),
                Channel::FuzzySkin => annotations.fuzzy_skin.value(),
                Channel::Brim => annotations.brim.value(),
            }),
            persisted: annotations.refinement.as_ref().and_then(|refinement| {
                let Value::Object(channels) = refinement.value() else {
                    return None;
                };
                channels
                    .get(&channel.name().encode_utf16().collect::<Vec<_>>())
                    .cloned()
            }),
            touched: vec![false; triangle_count as usize],
            touched_order: Vec::new(),
            refinement: None,
            session_guard: None,
        })
    }

    /// One pointer sample: select over the opened snapshot and the tree the
    /// samples before it left, then accumulate the facets and the post-sample
    /// tree. Invalid tool input reports the selector's issues and leaves the
    /// stroke as it was.
    pub fn sample(&mut self, request: &wire::PaintStrokeSample) -> wire::PaintStrokeSampleReply {
        let mut tool = region_tool(&request.tool);
        if request.triangle_splitting {
            tool = tool.with_triangle_splitting();
        }
        let triangle_count = self.guard.triangle_count as usize;
        let selected = region::select(&Request {
            mesh: Mesh {
                vertices: &self.vertices,
                triangles: &self.triangles,
            },
            channel: self.channel,
            annotations_topology_revision: self.annotations_topology_revision,
            assignments: &self.assignments,
            guard_topology_revision: self.guard.topology_revision as f64,
            guard_triangle_count: triangle_count as f64,
            seed_triangle: request.seed_triangle as f64,
            tool,
            clipping_plane: clipping_plane(&request.clipping_plane),
            transform: transform_of(&request.transform),
            highlight_by_angle_degrees: optional(&request.highlight_by_angle_degrees),
            refinement: match self.refinement {
                Some(_) => None,
                None => self.persisted.as_ref(),
            },
            refined_roots: self.refinement.as_deref().map(Roots::Nodes),
        })
        .and_then(|selection| {
            let after = region::refinement_after(
                self.channel,
                &selection,
                &self.assignments,
                triangle_count,
                &self.target,
            )?;
            Ok((selection, after))
        });
        let (selection, after) = match selected {
            Ok(result) => result,
            Err(RegionError::Invalid(issues)) => {
                return wire::PaintStrokeSampleReply::Invalid(issues_wire(&issues));
            }
            Err(RegionError::StaleTopology) => {
                return wire::PaintStrokeSampleReply::Stale(wire::Empty {});
            }
        };
        for &triangle in &selection.triangle_indices {
            if let Some(slot) = self.touched.get_mut(triangle as usize)
                && !*slot
            {
                *slot = true;
                self.touched_order.push(triangle);
            }
        }
        if after.is_some() {
            self.refinement = after;
        }
        let leaves = selection
            .refinement
            .as_ref()
            .map_or(&[][..], |refined| &refined.leaves[..]);
        wire::PaintStrokeSampleReply::Sampled(wire::PaintStrokeSampled {
            selected_triangles: selection.triangle_indices.len() as u64,
            leaves: leaves.len() as u64,
            selected_leaves: leaves.iter().filter(|leaf| leaf.selected).count() as u64,
            stroke_triangles: self.touched_order.len() as u64,
            refined: self.refinement.is_some(),
        })
    }

    /// A page of the facets the stroke has touched so far, as ranges.
    pub fn overlay(
        &self,
        request: &wire::PaintStrokeOverlayRequest,
    ) -> Result<wire::PaintStrokeOverlay, Refusal> {
        if request.count > MAX_PAGE {
            return Err(Refusal::InvalidRequest);
        }
        let ranges = self.ranges();
        let start = usize::try_from(request.start)
            .unwrap_or(usize::MAX)
            .min(ranges.len());
        let end = start
            .saturating_add(request.count as usize)
            .min(ranges.len());
        Ok(wire::PaintStrokeOverlay {
            guard: self.guard.clone(),
            stroke_triangles: self.touched_order.len() as u64,
            refined: self.refinement.is_some(),
            total_ranges: ranges.len() as u64,
            ranges: ranges_wire(&ranges[start..end]),
        })
    }

    /// The whole gesture as one staged edit under the opened snapshot's facet
    /// guard, or `None` when it touched no facet: the refined tree when any
    /// sample left one, otherwise the touched facets as one `facetStroke`.
    pub fn work(
        &self,
        label: Option<Vec<u16>>,
        max_units: u64,
    ) -> Result<Option<StagedWork>, CaptureError> {
        if self.touched_order.is_empty() {
            return Ok(None);
        }
        let verb = if self.target == RegionState::Unpainted {
            "Erase"
        } else {
            "Paint"
        };
        let name = channel_label(self.channel);
        let guard = &self.guard;
        if let Some(roots) = &self.refinement {
            let label = label.unwrap_or_else(|| {
                format!("{verb} refined {name} facets")
                    .encode_utf16()
                    .collect()
            });
            let roots = roots
                .iter()
                .map(node_of)
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| CaptureError::Encoding)?;
            let request = FacetRefinement {
                revision: guard.revision,
                hash: guard.hash.clone(),
                volume: VolumeId::try_from_utf16(guard.volume_id.clone())
                    .map_err(|_| CaptureError::Encoding)?,
                topology_revision: guard.topology_revision as f64,
                triangle_count: guard.triangle_count as f64,
                channel: self.channel,
                roots,
                label: Some(Text::new(label)),
            };
            return StagedWork::facet_refinement(request, max_units).map(Some);
        }
        let label =
            label.unwrap_or_else(|| format!("{verb} {name} facets").encode_utf16().collect());
        let ranges = ranges_wire(&self.ranges());
        let stroke = wire::FacetStroke {
            guard: guard.clone(),
            channel: channel_wire(self.channel),
            operation: match &self.target {
                RegionState::Unpainted => {
                    wire::FacetStrokeOperationInput::Erase(wire::FacetEraseStroke { ranges })
                }
                RegionState::Assigned(value) => {
                    wire::FacetStrokeOperationInput::Paint(wire::FacetPaintStroke {
                        ranges,
                        value: match value {
                            PaintValue::Text(text) => wire::PaintValueInput::Text(text.to_vec()),
                            PaintValue::Bool(flag) => wire::PaintValueInput::Flag(*flag),
                        },
                    })
                }
            },
            label: wire::OptionalText::Value(label),
        };
        Ok(Some(StagedWork::single(CapturedCommand::facet_stroke(
            stroke, max_units,
        )?)))
    }

    /// The stroke's live preview as the workspace draws it: the refined tree a
    /// sample left, collapsed and materialized, or the touched facets in the
    /// target state, in the order they were first touched.
    pub fn preview(&self) -> Result<Overlay, overlay::Refusal> {
        let mesh = Mesh {
            vertices: &self.vertices,
            triangles: &self.triangles,
        };
        let Some(roots) = &self.refinement else {
            let regions = if self.touched_order.is_empty() {
                Vec::new()
            } else {
                vec![Region {
                    triangles: self.touched_order.iter().map(|&t| f64::from(t)).collect(),
                    state: self.target.clone(),
                }]
            };
            return Overlay::draw(self.guard.clone(), mesh, self.channel, &regions, None);
        };
        let invalid = |_| overlay::Refusal::InvalidAnnotations;
        let nodes = roots
            .iter()
            .map(node_of)
            .collect::<Result<Vec<_>, _>>()
            .map_err(invalid)?;
        let collapsed = FacetChannel::from_roots(self.channel, nodes, None).map_err(invalid)?;
        let encoding = collapsed.encoding().map(|encoding| encoding.to_value());
        Overlay::draw(
            self.guard.clone(),
            mesh,
            self.channel,
            &overlay::assigned_regions(collapsed.assignments()),
            encoding.as_ref(),
        )
    }

    fn ranges(&self) -> Vec<(u32, u32)> {
        let mut ranges: Vec<(u32, u32)> = Vec::new();
        for (triangle, _) in self.touched.iter().enumerate().filter(|(_, t)| **t) {
            let triangle = triangle as u32;
            match ranges.last_mut() {
                Some(last) if last.1 == triangle => last.1 += 1,
                _ => ranges.push((triangle, triangle + 1)),
            }
        }
        ranges
    }
}

fn node_of(node: &EncodedNode) -> Result<Node, FacetError> {
    match node {
        EncodedNode::Leaf(RegionState::Unpainted) => Ok(Node::leaf(State::Unpainted)),
        EncodedNode::Leaf(RegionState::Assigned(value)) => {
            Ok(Node::leaf(State::Assigned(value.clone())))
        }
        EncodedNode::Split {
            split_sides,
            special_side,
            children,
        } => Node::split(
            *split_sides,
            *special_side,
            children.iter().map(node_of).collect::<Result<_, _>>()?,
        ),
    }
}

fn channel_wire(channel: Channel) -> wire::FacetChannelName {
    match channel {
        Channel::Color => wire::FacetChannelName::Color,
        Channel::Support => wire::FacetChannelName::Support,
        Channel::Seam => wire::FacetChannelName::Seam,
        Channel::FuzzySkin => wire::FacetChannelName::FuzzySkin,
        Channel::Brim => wire::FacetChannelName::Brim,
    }
}

/// `channelLabel`.
fn channel_label(channel: Channel) -> &'static str {
    match channel {
        Channel::Support => "support",
        Channel::Seam => "seam",
        Channel::FuzzySkin => "fuzzy-skin",
        _ => "colour",
    }
}

/// `assertPaintTarget` for an assigned state: the channel's pinned order, or
/// a selectable palette entry for colour.
fn check_target(state: &ProjectState, channel: Channel, value: &PaintValue) -> Result<(), Refusal> {
    let allowed: &[&str] = match channel {
        Channel::Support => &["enforce", "block"],
        Channel::Seam => &["prefer", "avoid"],
        Channel::FuzzySkin => {
            return match value {
                PaintValue::Bool(true) => Ok(()),
                _ => Err(Refusal::InvalidTarget),
            };
        }
        _ => {
            let palette = project_palette(&state.filaments, true);
            let PaintValue::Text(id) = value else {
                return Err(Refusal::UnknownFilament);
            };
            let entry = palette
                .entries
                .iter()
                .find(|entry| entry.filament_id.as_deref() == Some(&id[..]))
                .ok_or(Refusal::UnknownFilament)?;
            return if entry.selectable {
                Ok(())
            } else {
                Err(Refusal::UnavailableFilament)
            };
        }
    };
    match value {
        PaintValue::Text(text)
            if allowed
                .iter()
                .any(|allowed| allowed.encode_utf16().eq(text.iter().copied())) =>
        {
            Ok(())
        }
        _ => Err(Refusal::InvalidTarget),
    }
}
