//! Mesh simplification over a live session (`simplifyExchange.ts`): the
//! workspace's Simplify prepared from an acknowledged state and its assets,
//! then staged under a host-drawn asset ID.
//!
//! A preparation decimates one volume's mesh (`mesh::simplify`) and reports
//! its before and after counts, the largest error it accepted and the encoded
//! result's digest; its bytes are the very payload staging installs, paged
//! for the host's preview. A run that removes nothing is unchanged; a volume
//! the workspace cannot simplify refuses with a code and the browser's message.
use crate::assets::{AssetPayload, AssetRepository};
use crate::commands::staged::{CaptureError, CapturedCommand, StagedWork};
use crate::commands::{StagedAsset, TopologyGuard};
use crate::ids::AssetId;
use crate::mesh::simplify::{self, Configuration};
use crate::mesh::{Coordinates, EncodeOptions, Limits, decode_indexed, encode};
use crate::model::{Decode, ProjectState, SourceAssetDescriptor};
use crate::session::LocalGuard;
use orcaxr_contracts::canonical::Value;
use orcaxr_contracts::project_intent_types as wire;

/// One volume's decimation, prepared on the state its session guard captured.
pub struct VolumeSimplify {
    pub(crate) session_guard: Option<LocalGuard>,
    outcome: Result<Outcome, wire::VolumeSimplifyRefusal>,
}

enum Outcome {
    Unchanged(u64),
    Prepared(Box<Prepared>),
}

struct Prepared {
    guard: TopologyGuard,
    /// The result encoded under the source's asset ID.
    preview: AssetPayload,
    digest: Vec<u16>,
    before: u64,
    after: u64,
    vertices: u64,
    max_error: f64,
    stopped_on_error: bool,
}

/// Why a prepared decimation does not stage or page.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error {
    /// The run was refused or unchanged, the asset ID is not stable, or the
    /// page is outside the mesh.
    Invalid,
    /// The work is over its input budget.
    Limit,
}

/// The largest mesh page one call returns.
pub const MAX_PAGE: u64 = 16 * 1024 * 1024;

fn refusal(
    code: wire::VolumeSimplifyRefusalCode,
    message: Vec<u16>,
) -> wire::VolumeSimplifyRefusal {
    wire::VolumeSimplifyRefusal { code, message }
}
fn text(prefix: &str, id: &[u16], suffix: &str) -> Vec<u16> {
    prefix
        .encode_utf16()
        .chain(id.iter().copied())
        .chain(suffix.encode_utf16())
        .collect()
}

/// `prepareVolumeSimplify`: the workspace's checks in its order, then the
/// decimation and its encoding. `cancelled` is polled as the run goes.
pub fn prepare(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::VolumeSimplifyRequest,
    cancelled: impl FnMut() -> bool,
) -> Option<VolumeSimplify> {
    let outcome = match prepared(state, assets, request, cancelled) {
        Ok(Some(outcome)) => Ok(outcome),
        Ok(None) => return None,
        Err(refusal) => Err(refusal),
    };
    Some(VolumeSimplify {
        session_guard: None,
        outcome,
    })
}

fn prepared(
    state: &ProjectState,
    assets: &AssetRepository,
    request: &wire::VolumeSimplifyRequest,
    cancelled: impl FnMut() -> bool,
) -> Result<Option<Outcome>, wire::VolumeSimplifyRefusal> {
    use wire::VolumeSimplifyRefusalCode as Code;
    let id = &request.volume_id;
    let volume = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .flat_map(|object| object.volumes.iter())
        .find(|volume| volume.id.as_utf16() == id.as_slice())
        .ok_or_else(|| refusal(Code::UnknownVolume, text("Unknown volume ", id, "")))?;
    let lease = assets.peek(&volume.source.asset_id).ok_or_else(|| {
        refusal(
            Code::MissingAsset,
            text("Volume ", id, " has no stored mesh asset"),
        )
    })?;
    // A repository record's descriptor is already validated.
    let descriptor = SourceAssetDescriptor::from_value(lease.descriptor().clone())
        .expect("a stored descriptor decodes");
    let guard = TopologyGuard {
        volume_id: id.clone(),
        asset_id: volume.source.asset_id.as_utf16().to_vec(),
        asset_digest: descriptor.digest.units().to_vec(),
        topology_revision: volume.source.topology_revision.get(),
        triangle_count: volume.source.triangle_count.get(),
    };
    let mesh = decode_indexed(&lease)
        .map_err(|message| refusal(Code::InvalidMesh, message.encode_utf16().collect()))?;
    let triangles: Vec<[u32; 3]> = mesh
        .indices
        .chunks_exact(3)
        .map(|t| [t[0], t[1], t[2]])
        .collect();
    let configuration = Configuration {
        use_count: request.use_count,
        decimate_ratio: request.decimate_ratio,
        max_error: request.max_error,
    };
    let result = match simplify::simplify(&mesh.positions, &triangles, configuration, cancelled) {
        Ok(result) => result,
        Err(None) => return Ok(None),
        Err(Some((code, message))) => {
            return Err(refusal(
                match code {
                    simplify::Refusal::DegenerateMesh => Code::DegenerateMesh,
                    simplify::Refusal::InvalidConfiguration => Code::InvalidConfiguration,
                },
                message.encode_utf16().collect(),
            ));
        }
    };
    if result.triangles.len() >= result.source_triangles {
        return Ok(Some(Outcome::Unchanged(result.source_triangles as u64)));
    }
    // `encodeIndexedMeshAsset`'s coordinate checks, in its order.
    let positions: Vec<f64> = result.vertices.iter().flatten().copied().collect();
    for &coordinate in &positions {
        let message = if !coordinate.is_finite() {
            "Mesh positions must be finite"
        } else if !(coordinate as f32).is_finite() {
            "Mesh positions must fit finite float32"
        } else {
            continue;
        };
        return Err(refusal(Code::InvalidMesh, message.encode_utf16().collect()));
    }
    let indices: Vec<u32> = result.triangles.iter().flatten().copied().collect();
    let preview = encode(
        EncodeOptions {
            id: lease.id().clone(),
            source_filename: descriptor.source_filename.clone(),
            provenance: None,
            metadata_bytes: usize::MAX,
        },
        Coordinates::Float64(&positions),
        Some(&indices),
        Limits {
            asset_bytes: usize::MAX,
            vertices: usize::MAX,
            indices: usize::MAX,
        },
        || false,
    )
    .map_err(|_| {
        refusal(
            Code::InvalidMesh,
            "Mesh payload is too large".encode_utf16().collect(),
        )
    })?;
    let digest = match &preview.descriptor {
        Value::Object(fields) => match fields.get(&"digest".encode_utf16().collect::<Vec<_>>()) {
            Some(Value::String(units)) => units.clone(),
            _ => unreachable!("an encoded descriptor has a digest"),
        },
        _ => unreachable!("an encoded descriptor is an object"),
    };
    Ok(Some(Outcome::Prepared(Box::new(Prepared {
        guard,
        preview,
        digest,
        before: result.source_triangles as u64,
        after: result.triangles.len() as u64,
        vertices: result.vertices.len() as u64,
        max_error: result.max_applied_error,
        stopped_on_error: result.stopped_on_error,
    }))))
}

impl VolumeSimplify {
    /// `VolumeSimplifyReply`: the run's summary, unchanged, or the refusal.
    pub fn reply(&self) -> wire::VolumeSimplifyReply {
        match &self.outcome {
            Err(refusal) => wire::VolumeSimplifyReply::Refused(refusal.clone()),
            Ok(Outcome::Unchanged(triangles)) => {
                wire::VolumeSimplifyReply::Unchanged(wire::VolumeSimplifyUnchanged {
                    triangle_count: *triangles,
                })
            }
            Ok(Outcome::Prepared(prepared)) => {
                wire::VolumeSimplifyReply::Prepared(wire::VolumeSimplifyPreview {
                    before_triangles: prepared.before,
                    after_triangles: prepared.after,
                    vertex_count: prepared.vertices,
                    max_error: if prepared.max_error.is_finite() {
                        wire::OptionalFinite::Value(prepared.max_error)
                    } else {
                        wire::OptionalFinite::Absent(wire::Empty {})
                    },
                    stopped_on_error: prepared.stopped_on_error,
                    digest: prepared.digest.clone(),
                    byte_length: prepared.preview.bytes.len() as u64,
                })
            }
        }
    }

    fn prepared(&self) -> Result<&Prepared, Error> {
        match &self.outcome {
            Ok(Outcome::Prepared(prepared)) => Ok(prepared),
            _ => Err(Error::Invalid),
        }
    }

    /// Bytes `start..start + count` of the result's canonical indexed-mesh
    /// payload (float32 positions, then uint32 indices), at most [`MAX_PAGE`].
    pub fn mesh(&self, start: u64, count: u64) -> Result<&[u8], Error> {
        let bytes = &self.prepared()?.preview.bytes;
        let end = start.checked_add(count).ok_or(Error::Invalid)?;
        if count > MAX_PAGE || end > bytes.len() as u64 {
            return Err(Error::Invalid);
        }
        Ok(&bytes[start as usize..end as usize])
    }

    /// `stageVolumeSimplifyWire`: the previewed payload under the host's asset
    /// ID, replacing the volume's mesh as one staged edit.
    pub fn work(
        &self,
        request: &wire::VolumeSimplifyStage,
        max_units: u64,
    ) -> Result<StagedWork, Error> {
        let prepared = self.prepared()?;
        let id = AssetId::try_from_utf16(request.asset_id.clone()).map_err(|_| Error::Invalid)?;
        let mut descriptor = prepared.preview.descriptor.clone();
        if let Value::Object(fields) = &mut descriptor {
            fields.insert(
                "id".encode_utf16().collect(),
                Value::String(id.as_utf16().to_vec()),
            );
        }
        let asset = StagedAsset::new(AssetPayload {
            descriptor,
            bytes: prepared.preview.bytes.clone(),
        })
        .map_err(|_| Error::Invalid)?;
        CapturedCommand::replace_volume_mesh(prepared.guard.clone(), asset, max_units)
            .map(StagedWork::single)
            .map_err(|error| match error {
                CaptureError::Limit => Error::Limit,
                _ => Error::Invalid,
            })
    }
}
