//! Paint facets (`PaintFacets.ts`): what a paint overlay draws, arranged for a
//! renderer that colours a volume's own facets instead of drawing a second
//! mesh over them. Whole source facets come as runs of one state in source
//! order; the leaves of subdivided facets come with their corners and source
//! facet, to draw over the facet they split; each state comes with the colour
//! the workspace draws it in (`paintOverlayColors.ts`): a colour filament's
//! palette display colour, a fixed colour per support, seam and fuzzy-skin
//! state, and white for an unpainted state (an erasing preview) or a value
//! nothing names. An unrefined channel is read from its sparse assignments
//! alone, without decoding the mesh.
//!
//! A capture owns its facets under the facet guard of the state it was read
//! from: a canonical JSON summary
//! (`{"colors","facets","guard","leaves","runs","states"}`), then packets of
//! at most [`MAX_PAGE`] runs ([`RUN_BYTES`] each: little-endian uint32 first
//! facet, facet count and state index) or leaves ([`LEAF_BYTES`] each: nine
//! little-endian float32 corners in volume space, then uint32 source facet and
//! state index).
use super::overlay::{Refusal, Region};
use super::palette::project_palette;
use super::region::{self, Assignment, Mesh, RegionError, RegionState, Request, Tool};
use super::region_exchange::{assignments, channel_of};
use super::{Channel, PaintValue};
use crate::model::{Decode, Filaments};
use crate::{assets::AssetRepository, mesh::decode_indexed, store::ProjectSnapshot};
use orcaxr_contracts::{
    canonical::{Value, parse},
    project_intent_types as wire,
};
use std::collections::BTreeMap;

/// The most runs, or leaves, one packet holds.
pub const MAX_PAGE: u64 = 16384;
/// Bytes per packed run.
pub const RUN_BYTES: usize = 12;
/// Bytes per packed leaf.
pub const LEAF_BYTES: usize = 44;
/// What a state draws in when nothing names its value.
pub const UNNAMED_COLOR: &str = "#ffffff";

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

/// The colours one channel draws its states in (`channelOverlayColors` over
/// `paintPaletteColors(projectPaintPalette(state, { includeUnavailable: true }))`),
/// keyed by `String(value)`.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ColorMap(BTreeMap<Vec<u16>, Vec<u16>>);

impl ColorMap {
    pub fn for_channel(filaments: &Filaments, channel: Channel) -> Self {
        let fixed = |pairs: &[(&str, &str)]| {
            Self(
                pairs
                    .iter()
                    .map(|(state, color)| (units(state), units(color)))
                    .collect(),
            )
        };
        match channel {
            Channel::Color => {
                let mut colors = BTreeMap::new();
                for entry in project_palette(filaments, true).entries {
                    if let Some(id) = entry.filament_id {
                        // `Map.set`: a repeated identity keeps the later colour.
                        colors.insert(id, entry.display_color);
                    }
                }
                Self(colors)
            }
            Channel::Support => fixed(&[("enforce", "#39d353"), ("block", "#f85149")]),
            Channel::Seam => fixed(&[("prefer", "#58a6ff"), ("avoid", "#ff9f43")]),
            Channel::FuzzySkin => fixed(&[("true", "#bc8cff")]),
            Channel::Brim => Self::default(),
        }
    }

    /// `paintStateColor`.
    pub fn color(&self, state: &RegionState) -> Vec<u16> {
        let key = match state {
            RegionState::Unpainted => return units(UNNAMED_COLOR),
            RegionState::Assigned(PaintValue::Text(text)) => text.to_vec(),
            RegionState::Assigned(PaintValue::Bool(flag)) => {
                units(if *flag { "true" } else { "false" })
            }
        };
        self.0
            .get(&key)
            .cloned()
            .unwrap_or_else(|| units(UNNAMED_COLOR))
    }
}

/// One volume's paint facets.
#[derive(Debug, Clone, PartialEq)]
pub struct PaintFacets {
    guard: wire::FacetGuard,
    /// `[first, count, state]`, ascending and disjoint.
    runs: Vec<[u32; 3]>,
    leaf_positions: Vec<f32>,
    leaf_sources: Vec<u32>,
    leaf_states: Vec<u32>,
    states: Vec<RegionState>,
    colors: Vec<Vec<u16>>,
}

/// States numbered in the order they are first drawn, as the overlay numbers them.
#[derive(Default)]
struct States(Vec<RegionState>);
impl States {
    fn index(&mut self, state: &RegionState) -> u32 {
        match self.0.iter().position(|known| known == state) {
            Some(index) => index as u32,
            None => {
                self.0.push(state.clone());
                (self.0.len() - 1) as u32
            }
        }
    }
}

impl PaintFacets {
    /// `paintFacets`: the painted facets of one channel of a volume with the
    /// guard's facet count. With a refinement (and the mesh it subdivides)
    /// every region must be assigned, as canonical assignments are: it is
    /// materialized over them; each assigned leaf of an unsplit facet is a
    /// whole facet and every other assigned leaf is drawn as a leaf. Without
    /// one each region's facets are whole facets, a later region drawing over
    /// an earlier one.
    pub fn draw(
        guard: wire::FacetGuard,
        channel: Channel,
        regions: &[Region],
        refined: Option<(&Value, Mesh<'_>)>,
        colors: &ColorMap,
    ) -> Result<Self, Refusal> {
        let triangle_count = guard.triangle_count as usize;
        let mut states = States::default();
        // (facet, state) in draw order.
        let mut whole: Vec<(u32, u32)> = Vec::new();
        let mut facets = Self {
            guard,
            runs: Vec::new(),
            leaf_positions: Vec::new(),
            leaf_sources: Vec::new(),
            leaf_states: Vec::new(),
            states: Vec::new(),
            colors: Vec::new(),
        };
        if let Some((refinement, mesh)) = refined {
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
            let topology = facets.guard.topology_revision as f64;
            let materialized = region::materialize(&Request {
                mesh,
                channel,
                annotations_topology_revision: topology,
                assignments: &assigned,
                guard_topology_revision: topology,
                guard_triangle_count: triangle_count as f64,
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
                if !matches!(leaf.state, RegionState::Assigned(_)) {
                    continue;
                }
                let index = states.index(&leaf.state);
                if leaf.path.is_empty() {
                    whole.push((leaf.source_triangle, index));
                    continue;
                }
                for vertex in leaf.vertex_indices {
                    let corner = materialized
                        .vertices
                        .get(vertex as usize)
                        .ok_or(Refusal::InvalidAnnotations)?;
                    facets.leaf_positions.extend(corner.map(|v| v as f32));
                }
                facets.leaf_sources.push(leaf.source_triangle);
                facets.leaf_states.push(index);
            }
        } else {
            for region in regions {
                if region.triangles.is_empty() {
                    continue;
                }
                let index = states.index(&region.state);
                for &triangle in &region.triangles {
                    if triangle.fract() != 0.0 || !(0.0..triangle_count as f64).contains(&triangle)
                    {
                        return Err(Refusal::InvalidAnnotations);
                    }
                    whole.push((triangle as u32, index));
                }
            }
        }
        // Source order; of one facet drawn twice, the later draw shows.
        whole.sort_by_key(|&(facet, _)| facet);
        for (position, &(facet, state)) in whole.iter().enumerate() {
            if whole.get(position + 1).is_some_and(|next| next.0 == facet) {
                continue;
            }
            match facets.runs.last_mut() {
                Some(run) if run[0] + run[1] == facet && run[2] == state => run[1] += 1,
                _ => facets.runs.push([facet, 1, state]),
            }
        }
        facets.colors = states.0.iter().map(|state| colors.color(state)).collect();
        facets.states = states.0;
        Ok(facets)
    }

    /// Whole facets drawn.
    pub fn facet_count(&self) -> u64 {
        self.runs.iter().map(|run| u64::from(run[1])).sum()
    }
    pub fn run_count(&self) -> usize {
        self.runs.len()
    }
    pub fn leaf_count(&self) -> usize {
        self.leaf_sources.len()
    }
    pub fn colors(&self) -> &[Vec<u16>] {
        &self.colors
    }

    /// `{"colors","facets","guard","leaves","runs","states"}`, canonical JSON.
    pub fn summary(&self) -> String {
        let text = |value: &[u16]| Value::String(value.to_vec());
        let number = |value: f64| Value::Number(value);
        let guard = &self.guard;
        let summary = Value::Object(BTreeMap::from([
            (
                units("colors"),
                Value::Array(self.colors.iter().map(|color| text(color)).collect()),
            ),
            (units("facets"), number(self.facet_count() as f64)),
            (
                units("guard"),
                Value::Object(BTreeMap::from([
                    (units("hash"), text(&guard.hash)),
                    (units("revision"), number(guard.revision as f64)),
                    (
                        units("topologyRevision"),
                        number(guard.topology_revision as f64),
                    ),
                    (units("triangleCount"), number(guard.triangle_count as f64)),
                    (units("volumeId"), text(&guard.volume_id)),
                ])),
            ),
            (units("leaves"), number(self.leaf_count() as f64)),
            (units("runs"), number(self.run_count() as f64)),
            (
                units("states"),
                Value::Array(
                    self.states
                        .iter()
                        .map(|state| match state {
                            RegionState::Unpainted => Value::Null,
                            RegionState::Assigned(value) => value.to_value(),
                        })
                        .collect(),
                ),
            ),
        ]));
        let mut bytes = Vec::new();
        summary
            .write_canonical(&mut bytes)
            .expect("writing to memory");
        String::from_utf8(bytes).expect("canonical JSON is UTF-8")
    }

    fn window(total: usize, start: u64, count: u64) -> Result<(usize, usize), Refusal> {
        if count > MAX_PAGE {
            return Err(Refusal::InvalidRequest);
        }
        let from = usize::try_from(start).unwrap_or(usize::MAX).min(total);
        Ok((from, from.saturating_add(count as usize).min(total)))
    }

    /// Runs `[start, start + count)` as one packet, clamped to the runs.
    pub fn runs(&self, start: u64, count: u64) -> Result<Vec<u8>, Refusal> {
        let (from, to) = Self::window(self.runs.len(), start, count)?;
        let mut packet = Vec::with_capacity((to - from) * RUN_BYTES);
        for run in &self.runs[from..to] {
            for word in run {
                packet.extend(word.to_le_bytes());
            }
        }
        Ok(packet)
    }

    /// Leaves `[start, start + count)` as one packet, clamped to the leaves.
    pub fn leaves(&self, start: u64, count: u64) -> Result<Vec<u8>, Refusal> {
        let (from, to) = Self::window(self.leaf_sources.len(), start, count)?;
        let mut packet = Vec::with_capacity((to - from) * LEAF_BYTES);
        for leaf in from..to {
            for value in &self.leaf_positions[leaf * 9..leaf * 9 + 9] {
                packet.extend(value.to_le_bytes());
            }
            packet.extend(self.leaf_sources[leaf].to_le_bytes());
            packet.extend(self.leaf_states[leaf].to_le_bytes());
        }
        Ok(packet)
    }
}

/// The paint facets of one volume's channel in an acknowledged snapshot, as
/// the workspace draws it: the channel's assignments, materialized through its
/// refinement when it has one.
pub fn capture(
    snapshot: &ProjectSnapshot,
    assets: &AssetRepository,
    request: &wire::PaintOverlayRequest,
) -> Result<PaintFacets, Refusal> {
    let state = snapshot.state();
    let volume = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.volumes.iter())
        .find(|volume| volume.id.as_utf16() == request.volume_id.as_slice())
        .ok_or(Refusal::UnknownVolume)?;
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
        channels.get(&units(channel.name())).cloned()
    });
    let guard = wire::FacetGuard {
        revision: snapshot.revision(),
        hash: snapshot.hash().encode_utf16().collect(),
        volume_id: volume.id.as_utf16().to_vec(),
        topology_revision: volume.source.topology_revision.get() as u64,
        triangle_count: volume.source.triangle_count.get() as u64,
    };
    let colors = ColorMap::for_channel(&state.filaments, channel);
    let Some(refinement) = refinement else {
        return PaintFacets::draw(guard, channel, &regions, None, &colors);
    };
    // Only a subdivided channel needs the mesh it subdivides.
    let lease = assets
        .peek(&volume.source.asset_id)
        .ok_or(Refusal::InvalidMesh)?;
    let decoded = decode_indexed(&lease).map_err(|_| Refusal::InvalidMesh)?;
    let triangles: Vec<[f64; 3]> = decoded
        .indices
        .chunks_exact(3)
        .map(|t| [t[0] as f64, t[1] as f64, t[2] as f64])
        .collect();
    PaintFacets::draw(
        guard,
        channel,
        &regions,
        Some((
            &refinement,
            Mesh {
                vertices: &decoded.positions,
                triangles: &triangles,
            },
        )),
        &colors,
    )
}

/// `paintFacetColorsExchange`: `{"channel","filaments","states"}` →
/// `{"colors"}`, a state being its assigned value or `null` unpainted.
pub fn colors_json(request: &str) -> Result<String, &'static str> {
    use crate::placement::bed::{INPUT_LIMIT, INVALID_REQUEST};
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let Value::Object(mut fields) = parse(request).map_err(|_| INVALID_REQUEST)? else {
        return Err(INVALID_REQUEST);
    };
    let keys = ["channel", "filaments", "states"];
    if fields.len() != keys.len() || !keys.iter().all(|k| fields.contains_key(&units(k))) {
        return Err(INVALID_REQUEST);
    }
    let Some(Value::String(name)) = fields.remove(&units("channel")) else {
        return Err(INVALID_REQUEST);
    };
    let channel = Channel::ALL
        .into_iter()
        .find(|channel| units(channel.name()) == name)
        .ok_or(INVALID_REQUEST)?;
    let filaments =
        Filaments::from_value(fields.remove(&units("filaments")).unwrap_or(Value::Null))
            .map_err(|_| INVALID_REQUEST)?;
    let Some(Value::Array(states)) = fields.remove(&units("states")) else {
        return Err(INVALID_REQUEST);
    };
    let colors = ColorMap::for_channel(&filaments, channel);
    let colors = states
        .iter()
        .map(|state| {
            let state = match state {
                Value::Null => RegionState::Unpainted,
                Value::String(text) => RegionState::Assigned(PaintValue::text(text.clone())),
                Value::Bool(flag) => RegionState::Assigned(PaintValue::Bool(*flag)),
                _ => return Err(INVALID_REQUEST),
            };
            Ok(Value::String(colors.color(&state)))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut bytes = Vec::new();
    Value::Object(BTreeMap::from([(units("colors"), Value::Array(colors))]))
        .write_canonical(&mut bytes)
        .map_err(|_| crate::placement::bed::OUTPUT_LIMIT)?;
    String::from_utf8(bytes).map_err(|_| crate::placement::bed::OUTPUT_LIMIT)
}
