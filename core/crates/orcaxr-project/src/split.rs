//! A volume's split over a live session (`volumeSplitExchange.ts`): "Split to
//! Parts" and "Split to Objects" prepared from an acknowledged state and its
//! assets, then staged under host-drawn IDs.
//!
//! A preparation reports each connected component in the pinned order (its
//! counts, its distinct geometry and its recentred transform) and each
//! distinct geometry's digest; a source the workspace cannot split refuses
//! with a code and the browser's message. Staging names the parts (one asset
//! ID per distinct geometry), reuses any project asset already holding a
//! part's exact bytes, and captures one staged work: parts of the source's
//! object or, with object identities, one object per part.
use crate::assets::{AssetLease, AssetPayload, AssetRepository};
use crate::commands::staged::{CaptureError, CapturedCommand, StagedWork};
use crate::commands::{SeparatedObject, SplitPart, StagedAsset, VolumeSplitGuard};
use crate::ids::{AssetId, EntityId, VolumeId};
use crate::mesh::split::{self, Component};
use crate::model::{Encode, ProjectState};
use crate::session::LocalGuard;
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types as wire;
use std::collections::{HashMap, HashSet};

/// One volume's split, prepared on the state its session guard captured.
pub struct VolumeSplit {
    pub(crate) session_guard: Option<LocalGuard>,
    outcome: Result<Prepared, wire::VolumeSplitRefusal>,
}

struct Prepared {
    guard: VolumeSplitGuard,
    source: AssetId,
    components: Vec<Component>,
    /// The distinct geometry each part is, numbered as each first appears.
    geometries: Vec<usize>,
    /// Each distinct geometry's first part.
    firsts: Vec<usize>,
}

/// Why a prepared split does not stage.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageError {
    /// The split was refused, or its names are not one per part and one per
    /// distinct geometry of stable IDs that no part or other geometry shares.
    Invalid,
    /// The work is over its input budget.
    Limit,
}

fn refusal(
    code: wire::VolumeSplitRefusalCode,
    prefix: &str,
    id: &[u16],
    suffix: &str,
) -> wire::VolumeSplitRefusal {
    wire::VolumeSplitRefusal {
        code,
        message: prefix
            .encode_utf16()
            .chain(id.iter().copied())
            .chain(suffix.encode_utf16())
            .collect(),
    }
}

/// `prepareVolumeSplit`: the workspace's source checks in its order, then the
/// pinned components.
pub fn prepare(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::VolumeSplitRequest,
) -> VolumeSplit {
    VolumeSplit {
        session_guard: None,
        outcome: prepared(state, assets, request),
    }
}

fn prepared(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::VolumeSplitRequest,
) -> Result<Prepared, wire::VolumeSplitRefusal> {
    use wire::VolumeSplitRefusalCode as Code;
    let volume = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.volumes.iter())
        .find(|volume| volume.id.as_utf16() == request.volume_id.as_slice())
        .ok_or_else(|| {
            refusal(
                Code::UnknownVolume,
                "Unknown volume ",
                &request.volume_id,
                "",
            )
        })?;
    let source = &volume.source.asset_id;
    let mut declared = state.source_assets.iter().filter(|d| d.id == *source);
    let (Some(descriptor), None) = (declared.next(), declared.next()) else {
        return Err(refusal(
            Code::AssetMetadata,
            "Split source asset ",
            source.as_utf16(),
            " is not declared exactly once",
        ));
    };
    let lease = assets.peek(source).ok_or_else(|| {
        refusal(
            Code::MissingAsset,
            "Split source asset ",
            source.as_utf16(),
            " is missing",
        )
    })?;
    if !descriptor
        .matches_value(lease.descriptor())
        .unwrap_or(false)
    {
        return Err(refusal(
            Code::AssetMetadata,
            "Split source asset ",
            source.as_utf16(),
            " differs from its canonical descriptor",
        ));
    }
    // `captureVolumeSplitGuard`.
    let mut fingerprint = Vec::new();
    volume
        .write_json(&mut fingerprint)
        .expect("writing to memory cannot fail");
    let guard = VolumeSplitGuard {
        volume_id: volume.id.as_utf16().to_vec(),
        asset_id: source.as_utf16().to_vec(),
        asset_digest: descriptor.digest.units().to_vec(),
        topology_revision: volume.source.topology_revision.get(),
        triangle_count: volume.source.triangle_count.get(),
        volume_fingerprint: String::from_utf8(fingerprint)
            .expect("canonical JSON is UTF-8")
            .encode_utf16()
            .collect(),
    };
    let components = split::components(&lease, descriptor.digest.units(), &volume.transform)
        .map_err(|(code, message)| wire::VolumeSplitRefusal {
            code: match code {
                split::Refusal::InvalidMesh => Code::InvalidMesh,
                split::Refusal::InvalidTransform => Code::InvalidTransform,
                split::Refusal::NotSplittable => Code::NotSplittable,
            },
            message: message.encode_utf16().collect(),
        })?;
    let mut by_digest: HashMap<&[u16], usize> = HashMap::new();
    let mut firsts = Vec::new();
    let geometries = components
        .iter()
        .enumerate()
        .map(|(index, component)| {
            *by_digest
                .entry(component.digest.as_slice())
                .or_insert_with(|| {
                    firsts.push(index);
                    firsts.len() - 1
                })
        })
        .collect();
    Ok(Prepared {
        guard,
        source: source.clone(),
        components,
        geometries,
        firsts,
    })
}

impl VolumeSplit {
    /// `VolumeSplitReply`: the parts and geometries, or the refusal.
    pub fn reply(&self) -> wire::VolumeSplitReply {
        let prepared = match &self.outcome {
            Ok(prepared) => prepared,
            Err(refusal) => return wire::VolumeSplitReply::Refused(refusal.clone()),
        };
        let numbers = |values: &[crate::model::Number]| values.iter().map(|v| v.get()).collect();
        wire::VolumeSplitReply::Prepared(wire::VolumeSplitPreview {
            parts: prepared
                .components
                .iter()
                .zip(&prepared.geometries)
                .map(|(component, &geometry)| wire::VolumeSplitPart {
                    triangle_count: component.source_triangles.len() as u64,
                    vertex_count: component.vertices as u64,
                    geometry: geometry as u64,
                    transform: wire::Transform {
                        translation_mm: numbers(&component.transform.translation_mm),
                        rotation: numbers(&component.transform.rotation),
                        scale: numbers(&component.transform.scale),
                    },
                })
                .collect(),
            geometries: prepared
                .firsts
                .iter()
                .map(|&index| {
                    let component = &prepared.components[index];
                    wire::VolumeSplitGeometry {
                        digest: component.digest.clone(),
                        byte_length: component.payload.bytes.len() as u64,
                    }
                })
                .collect(),
        })
    }

    /// `stageVolumeSplitWire` over the state the split was prepared from:
    /// name the parts, reuse the project's own copies of their bytes, and
    /// capture the work.
    pub fn work(
        &self,
        state: &ProjectState,
        assets: &AssetRepository,
        request: &wire::VolumeSplitStage,
        max_units: u64,
    ) -> Result<StagedWork, StageError> {
        let prepared = self.outcome.as_ref().map_err(|_| StageError::Invalid)?;
        let parts = prepared
            .parts(state, assets, &request.volume_ids, &request.asset_ids)
            .ok_or(StageError::Invalid)?;
        let captured = |error| match error {
            CaptureError::Limit => StageError::Limit,
            _ => StageError::Invalid,
        };
        match &request.objects {
            wire::OptionalSeparatedObjects::Absent(_) => {
                CapturedCommand::split_volume_to_parts(prepared.guard.clone(), parts, max_units)
                    .map(StagedWork::single)
                    .map_err(captured)
            }
            wire::OptionalSeparatedObjects::Value(objects) => {
                let identities = objects
                    .iter()
                    .map(|object| {
                        Some(SeparatedObject {
                            source_volume: stable(&object.source_volume_id)?,
                            object: stable(&object.object_id)?,
                            instances: object
                                .instance_ids
                                .iter()
                                .map(|id| stable(id))
                                .collect::<Option<_>>()?,
                        })
                    })
                    .collect::<Option<Vec<_>>>()
                    .ok_or(StageError::Invalid)?;
                StagedWork::split_to_objects(prepared.guard.clone(), parts, identities, max_units)
                    .map_err(captured)
            }
        }
    }
}

fn stable<K>(units: &[u16]) -> Option<EntityId<K>> {
    EntityId::try_from_utf16(units.to_vec()).ok()
}

impl Prepared {
    /// `PreparedVolumeSplit.parts`: `assignVolumeSplitIdentities` under one
    /// volume ID per part and one asset ID per distinct geometry, then the
    /// project's own copy of any part's exact bytes. `None` for bad names.
    fn parts(
        &self,
        state: &ProjectState,
        assets: &AssetRepository,
        volume_ids: &[Vec<u16>],
        asset_ids: &[Vec<u16>],
    ) -> Option<Vec<SplitPart>> {
        if volume_ids.len() != self.components.len() || asset_ids.len() != self.firsts.len() {
            return None;
        }
        let volumes = volume_ids
            .iter()
            .map(|id| stable(id))
            .collect::<Option<Vec<VolumeId>>>()?;
        let named = asset_ids
            .iter()
            .map(|id| stable(id))
            .collect::<Option<Vec<AssetId>>>()?;
        // No part reuses the immutable source; no two parts share a volume;
        // no two geometries share an asset; no ID names a volume and an asset.
        let distinct_assets: HashSet<&[u16]> = named.iter().map(|id| id.as_utf16()).collect();
        let distinct_volumes: HashSet<&[u16]> = volumes.iter().map(|id| id.as_utf16()).collect();
        if named.contains(&self.source)
            || distinct_volumes.len() != volumes.len()
            || distinct_assets.len() != named.len()
            || distinct_volumes
                .iter()
                .any(|id| distinct_assets.contains(id))
        {
            return None;
        }
        let mut reusable: HashMap<&[u16], AssetLease> = HashMap::new();
        for descriptor in state.source_assets.iter() {
            let digest = descriptor.digest.units();
            if descriptor.id == self.source || reusable.contains_key(digest) {
                continue;
            }
            if let Some(lease) = assets.peek(&descriptor.id)
                && descriptor
                    .matches_value(lease.descriptor())
                    .unwrap_or(false)
            {
                reusable.insert(digest, lease);
            }
        }
        let geometries = self
            .firsts
            .iter()
            .zip(&named)
            .map(|(&index, id)| {
                let component = &self.components[index];
                match reusable.get(component.digest.as_slice()) {
                    Some(lease) => StagedAsset::from_lease(lease.clone()),
                    None => StagedAsset::new(renamed(&component.payload, id)),
                }
                .ok()
            })
            .collect::<Option<Vec<_>>>()?;
        Some(
            self.components
                .iter()
                .zip(&self.geometries)
                .zip(volume_ids)
                .map(|((component, &geometry), volume)| SplitPart {
                    volume_id: volume.clone(),
                    asset: geometries[geometry].clone(),
                    transform: component.transform.clone(),
                    source_triangles: component
                        .source_triangles
                        .iter()
                        .map(|&t| f64::from(t))
                        .collect(),
                })
                .collect(),
        )
    }
}

/// A component payload under its drawn asset ID.
fn renamed(payload: &AssetPayload, id: &AssetId) -> AssetPayload {
    let mut descriptor = payload.descriptor.clone();
    if let Value::Object(fields) = &mut descriptor {
        fields.insert(
            "id".encode_utf16().collect(),
            Value::String(id.as_utf16().to_vec()),
        );
    }
    AssetPayload {
        descriptor,
        bytes: payload.bytes.clone(),
    }
}
