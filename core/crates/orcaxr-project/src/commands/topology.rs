//! Commands that replace a volume's immutable mesh (`ReplaceVolumeMeshCommand`,
//! `MeshBooleanCommand`). Both are guarded by the topology a staged mesh
//! operation started from, reset every triangle-indexed annotation channel and
//! keep only the payloads that something still references. Removed payloads
//! stay as shared leases, so undo restores their records without copying.
use super::*;
use crate::assets::AssetLease;
use crate::mesh::validate_indexed;
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;
use std::io::{self, Write};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

pub(super) fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
pub(super) fn safe_integer(n: f64) -> bool {
    n.is_finite() && n.fract() == 0.0 && n.abs() <= MAX_SAFE
}
pub(super) fn trimmed_empty(units: &[u16]) -> bool {
    units.iter().all(|&c| crate::ids::ecmascript_whitespace(c))
}
pub(super) fn prepared(message: &str) -> PreparationError {
    PreparationError::Domain(Text::from_utf8(message))
}
pub(super) fn prepared_parts(prefix: &str, units: &[u16], suffix: &str) -> PreparationError {
    PreparationError::Domain(text_parts(prefix, units, suffix))
}
pub(super) fn domain<E>(prefix: &str, units: &[u16], suffix: &str) -> CommandError<E> {
    CommandError::Domain(text_parts(prefix, units, suffix))
}
pub(super) fn stable<K>(units: &[u16]) -> Option<EntityId<K>> {
    crate::ids::is_stable_entity_id(units)
        .then(|| EntityId::try_from_utf16(units.to_vec()).ok())
        .flatten()
}
pub(super) fn string(units: &[u16]) -> Value {
    Value::String(units.to_vec())
}
pub(super) fn object(fields: Vec<(&str, Value)>) -> Value {
    Value::Object(
        fields
            .into_iter()
            .map(|(k, v)| (u(k), v))
            .collect::<BTreeMap<_, _>>(),
    )
}
pub(super) fn length(value: &Value) -> io::Result<u64> {
    let mut count = Length::default();
    value.write_canonical(&mut count)?;
    Ok(count.units)
}
/// A payload's history charge: canonical descriptor plus byte length.
pub(super) fn payload_bytes(lease: &AssetLease) -> io::Result<u64> {
    Ok(length(lease.descriptor())? + lease.bytes().len() as u64)
}

/// `emptyFacetAnnotations(revision)`.
pub(super) fn empty_annotations<E>(
    revision: f64,
) -> Result<Arc<FacetAnnotations>, CommandError<E>> {
    let empty = Value::Array(Vec::new());
    FacetAnnotations::from_value(object(vec![
        ("topologyRevision", Value::Number(revision)),
        ("color", empty.clone()),
        ("support", empty.clone()),
        ("seam", empty.clone()),
        ("fuzzySkin", empty.clone()),
        ("brim", empty),
    ]))
    .map(Arc::new)
    .map_err(|_| CommandError::Encoding)
}

/// `validateReplacementMesh`: the replacement's triangle count.
fn replacement_triangles(asset: &StagedAsset) -> Result<f64, PreparationError> {
    if trimmed_empty(asset.descriptor().digest.units()) {
        return Err(prepared("Replacement asset digest is required"));
    }
    let counts = validate_indexed(asset.lease()).map_err(|m| prepared(&m))?;
    if counts.vertices == 0 || counts.triangles == 0 {
        return Err(prepared(
            "Replacement mesh must contain at least one vertex and one triangle",
        ));
    }
    Ok(counts.triangles as f64)
}

/// `requireCanonicalMeshAsset`: declared once, stored with the same metadata,
/// and a decodable indexed mesh.
pub(super) fn canonical_mesh<P: TimestampPolicy>(
    context: &CommandContext<'_, P>,
    state: &ProjectState,
    id: &AssetId,
) -> Result<(Arc<SourceAssetDescriptor>, AssetLease), CommandError<P::Error>> {
    let mut declared = state.source_assets.iter().filter(|d| d.id == *id);
    let (Some(descriptor), None) = (declared.next(), declared.next()) else {
        return Err(domain(
            "Asset ",
            id.as_utf16(),
            " is not declared exactly once in canonical state",
        ));
    };
    let Some(lease) = context.assets().peek(id) else {
        return Err(domain(
            "Asset ",
            id.as_utf16(),
            " is missing from the canonical repository",
        ));
    };
    if !descriptor
        .matches_value(lease.descriptor())
        .map_err(|_| CommandError::Encoding)?
    {
        return Err(domain(
            "Asset ",
            id.as_utf16(),
            " metadata differs between canonical state and repository",
        ));
    }
    validate_indexed(&lease).map_err(|m| CommandError::Domain(Text::from_utf8(&m)))?;
    Ok((descriptor.clone(), lease))
}

/// `assertReplacementAvailable`: a fresh ID and a digest nothing holds yet.
fn assert_available<P: TimestampPolicy>(
    context: &CommandContext<'_, P>,
    state: &ProjectState,
    replacement: &StagedAsset,
) -> Result<(), CommandError<P::Error>> {
    let id = replacement.id();
    if state.source_assets.iter().any(|d| d.id == *id) || context.assets().has(id) {
        return Err(domain(
            "Replacement asset ",
            id.as_utf16(),
            " collides with an existing immutable asset",
        ));
    }
    let digest = replacement.descriptor().digest.units();
    if let Some(existing) = state
        .source_assets
        .iter()
        .find(|d| d.digest.units() == digest)
    {
        return Err(domain(
            "Replacement asset digest already exists as ",
            existing.id.as_utf16(),
            "; remap before committing",
        ));
    }
    if let Some(existing) = context.assets().find_id_by_digest(digest) {
        return Err(domain(
            "Replacement asset digest collides with repository asset ",
            existing.as_utf16(),
            "",
        ));
    }
    Ok(())
}

/// `projectReferencesAsset`.
pub(super) fn references(state: &ProjectState, id: &AssetId) -> bool {
    state
        .plates
        .iter()
        .flat_map(|p| p.objects.iter())
        .flat_map(|o| o.volumes.iter())
        .any(|v| v.source.asset_id == *id)
        || state.thumbnails.iter().any(|t| t.asset_id == *id)
        || state.extension_blobs.iter().any(|b| b.asset_id == *id)
}
pub(super) fn put<P: TimestampPolicy>(
    context: &mut CommandContext<'_, P>,
    lease: &AssetLease,
) -> Result<(), CommandError<P::Error>> {
    context
        .assets_mut()
        .put_lease(lease)
        .map(|_| ())
        .map_err(|_| {
            domain(
                "Immutable asset ",
                lease.id().as_utf16(),
                " cannot be replaced",
            )
        })
}
fn push_descriptor(state: &mut ProjectState, descriptor: Arc<SourceAssetDescriptor>) {
    let mut assets = state.source_assets.to_vec();
    assets.push(descriptor);
    state.source_assets = assets.into();
}
fn insert_descriptor(
    state: &mut ProjectState,
    index: usize,
    descriptor: Arc<SourceAssetDescriptor>,
) {
    let mut assets = state.source_assets.to_vec();
    // `splice` clamps an index past the end.
    assets.insert(index.min(assets.len()), descriptor);
    state.source_assets = assets.into();
}
fn remove_descriptor(state: &mut ProjectState, index: usize) {
    let mut assets = state.source_assets.to_vec();
    assets.remove(index);
    state.source_assets = assets.into();
}
pub(super) fn position(state: &ProjectState, id: &AssetId) -> Option<usize> {
    state.source_assets.iter().position(|d| d.id == *id)
}
/// The volume `id` in plate/object order, as the browser's `findVolume`.
pub(super) fn locate_volume(state: &ProjectState, id: &VolumeId) -> Option<(usize, usize, usize)> {
    state.plates.iter().enumerate().find_map(|(p, plate)| {
        plate.objects.iter().enumerate().find_map(|(o, object)| {
            object
                .volumes
                .iter()
                .position(|v| v.id == *id)
                .map(|v| (p, o, v))
        })
    })
}
/// The instance `id` in plate/object order, as the browser's `findInstance`.
fn locate_instance(state: &ProjectState, id: &InstanceId) -> Option<(usize, usize, usize)> {
    state.plates.iter().enumerate().find_map(|(p, plate)| {
        plate.objects.iter().enumerate().find_map(|(o, object)| {
            object
                .instances
                .iter()
                .position(|i| i.id == *id)
                .map(|i| (p, o, i))
        })
    })
}
/// Edit one object of a cloned state in place (copy-on-write).
pub(super) fn with_object<R>(
    state: &mut ProjectState,
    p: usize,
    o: usize,
    edit: impl FnOnce(&mut ProjectObject) -> R,
) -> R {
    let mut plates = state.plates.to_vec();
    let plate = Arc::make_mut(&mut plates[p]);
    let mut objects = plate.objects.to_vec();
    let result = edit(Arc::make_mut(&mut objects[o]));
    plate.objects = objects.into();
    state.plates = plates.into();
    result
}
fn with_volume<R>(
    object: &mut ProjectObject,
    v: usize,
    edit: impl FnOnce(&mut ProjectVolume) -> R,
) -> R {
    let mut volumes = object.volumes.to_vec();
    let result = edit(Arc::make_mut(&mut volumes[v]));
    object.volumes = volumes.into();
    result
}

/// `MeshTopologyReplacementGuard` as received; `new` checks it like
/// `assertGuardShape`, so a malformed guard fails with the browser's message.
#[derive(Clone)]
pub struct TopologyGuard {
    pub volume_id: Vec<u16>,
    pub asset_id: Vec<u16>,
    pub asset_digest: Vec<u16>,
    pub topology_revision: f64,
    pub triangle_count: f64,
}
impl TopologyGuard {
    fn value(&self) -> Value {
        object(vec![
            ("volumeId", string(&self.volume_id)),
            ("assetId", string(&self.asset_id)),
            ("assetDigest", string(&self.asset_digest)),
            ("topologyRevision", Value::Number(self.topology_revision)),
            ("triangleCount", Value::Number(self.triangle_count)),
        ])
    }
}
fn guard_number(revision: f64, message: &str) -> Result<(), PreparationError> {
    if !safe_integer(revision) || revision < 0.0 {
        return Err(prepared(message));
    }
    Ok(())
}
fn number<E>(value: f64) -> Result<Number, CommandError<E>> {
    Number::new(value).map_err(|_| non_serializable())
}
/// `source` for the replacement mesh at the next topology revision.
fn replacement_source<E>(
    replacement: &StagedAsset,
    revision: f64,
    triangles: f64,
) -> Result<MeshSourceRef, CommandError<E>> {
    Ok(MeshSourceRef {
        asset_id: replacement.id().clone(),
        topology_revision: number(revision)?,
        triangle_count: number(triangles)?,
        extra: ExtraFields::default(),
    })
}
fn write_index(count: &mut Length, index: Option<usize>) -> io::Result<()> {
    match index {
        Some(index) => count.write_all(index.to_string().as_bytes()),
        None => count.write_all(b"-1"),
    }
}

/// The guarded volume's position and its declared, stored mesh.
type GuardedVolume = (
    (usize, usize, usize),
    Arc<SourceAssetDescriptor>,
    AssetLease,
);

#[derive(Clone)]
struct PreviousTopology {
    source: MeshSourceRef,
    annotations: Arc<FacetAnnotations>,
    old_index: usize,
    removed_old: Option<(Arc<SourceAssetDescriptor>, AssetLease)>,
}

/// `ReplaceVolumeMeshCommand`: one volume's mesh and annotation channels.
#[derive(Clone)]
pub(super) struct ReplaceVolumeMesh {
    guard: TopologyGuard,
    volume: VolumeId,
    asset: AssetId,
    replacement: StagedAsset,
    triangles: f64,
    previous: Option<Arc<PreviousTopology>>,
}
impl ReplaceVolumeMesh {
    pub(super) fn new(
        guard: TopologyGuard,
        replacement: StagedAsset,
    ) -> Result<Self, PreparationError> {
        let Some(volume) = stable(&guard.volume_id) else {
            return Err(prepared_parts(
                "Volume ID ",
                &guard.volume_id,
                " is not stable",
            ));
        };
        let Some(asset) = stable(&guard.asset_id) else {
            return Err(prepared_parts(
                "Asset ID ",
                &guard.asset_id,
                " is not stable",
            ));
        };
        if trimmed_empty(&guard.asset_digest) {
            return Err(prepared("Topology guard asset digest is required"));
        }
        guard_number(
            guard.topology_revision,
            "Topology guard revision must be a non-negative safe integer",
        )?;
        if guard.topology_revision >= MAX_SAFE {
            return Err(prepared(
                "Topology guard revision cannot be incremented safely",
            ));
        }
        guard_number(
            guard.triangle_count,
            "Topology guard triangle count must be a non-negative safe integer",
        )?;
        let triangles = replacement_triangles(&replacement)?;
        if *replacement.id() == asset {
            return Err(prepared_parts(
                "Replacement asset ",
                asset.as_utf16(),
                " collides with the current mesh asset",
            ));
        }
        Ok(Self {
            guard,
            volume,
            asset,
            replacement,
            triangles,
            previous: None,
        })
    }

    /// `requireGuardedVolume`.
    fn guarded<P: TimestampPolicy>(
        &self,
        context: &CommandContext<'_, P>,
        state: &ProjectState,
    ) -> Result<GuardedVolume, CommandError<P::Error>> {
        let id = &self.guard.volume_id;
        let Some((p, o, v)) = locate_volume(state, &self.volume) else {
            return Err(domain("Stale topology guard: volume ", id, " is missing"));
        };
        let source = &state.plates[p].objects[o].volumes[v].source;
        if source.asset_id != self.asset {
            return Err(domain(
                "Stale topology guard: volume ",
                id,
                " changed mesh asset",
            ));
        }
        if source.topology_revision.get() != self.guard.topology_revision {
            return Err(domain(
                "Stale topology guard: volume ",
                id,
                " changed topology revision",
            ));
        }
        if source.triangle_count.get() != self.guard.triangle_count {
            return Err(domain(
                "Stale topology guard: volume ",
                id,
                " changed triangle count",
            ));
        }
        let (descriptor, lease) = canonical_mesh(context, state, &self.asset)?;
        if descriptor.digest.units() != self.guard.asset_digest.as_slice() {
            return Err(domain(
                "Stale topology guard: volume ",
                id,
                " changed asset digest",
            ));
        }
        if descriptor.mesh.as_ref().map(|m| m.triangle_count.get())
            != Some(self.guard.triangle_count)
        {
            return Err(domain(
                "Stale topology guard: volume ",
                id,
                " asset topology changed",
            ));
        }
        Ok(((p, o, v), descriptor, lease))
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let ((p, o, v), descriptor, lease) = self.guarded(context, &state)?;
        assert_available(context, &state, &self.replacement)?;
        let old_index = position(&state, &self.asset).expect("declared exactly once");
        let next = self.guard.topology_revision + 1.0;
        let volume = &state.plates[p].objects[o].volumes[v];
        let (source, annotations) = (volume.source.clone(), volume.annotations.clone());
        let replaced = replacement_source(&self.replacement, next, self.triangles)?;
        let empty = empty_annotations(next)?;
        with_object(&mut state, p, o, |object| {
            with_volume(object, v, |volume| {
                volume.source = replaced;
                volume.annotations = empty;
            })
        });
        push_descriptor(&mut state, self.replacement.descriptor().clone());
        let remove_old = !references(&state, &self.asset);
        if remove_old {
            remove_descriptor(&mut state, old_index);
        }
        put(context, self.replacement.lease())?;
        context.replace(state, reason, PROJECT)?;
        if remove_old {
            context.assets_mut().remove(&self.asset);
        }
        self.previous = Some(Arc::new(PreviousTopology {
            source,
            annotations,
            old_index,
            removed_old: remove_old.then_some((descriptor, lease)),
        }));
        Ok(())
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let Some(previous) = &self.previous else {
            return Err(CommandError::domain(
                "ReplaceVolumeMeshCommand has not been applied",
            ));
        };
        let mut state = context.snapshot().state().clone();
        let id = &self.guard.volume_id;
        let replacement = self.replacement.id();
        let Some((p, o, v)) = locate_volume(&state, &self.volume) else {
            return Err(domain("Replacement volume ", id, " is missing during undo"));
        };
        let next = self.guard.topology_revision + 1.0;
        let volume = &state.plates[p].objects[o].volumes[v];
        if volume.source.asset_id != *replacement
            || volume.source.topology_revision.get() != next
            || volume.source.triangle_count.get() != self.triangles
        {
            return Err(domain(
                "Replacement topology for volume ",
                id,
                " changed before undo",
            ));
        }
        if *volume.annotations != *empty_annotations(next)? {
            return Err(domain(
                "Replacement annotations for volume ",
                id,
                " changed before undo",
            ));
        }
        let (descriptor, _) = canonical_mesh(context, &state, replacement)?;
        if !descriptor
            .matches_value(self.replacement.lease().descriptor())
            .map_err(|_| CommandError::Encoding)?
        {
            return Err(domain(
                "Replacement asset ",
                replacement.as_utf16(),
                " metadata changed before undo",
            ));
        }
        let replacement_index = position(&state, replacement).expect("declared exactly once");
        let (source, annotations) = (previous.source.clone(), previous.annotations.clone());
        with_object(&mut state, p, o, |object| {
            with_volume(object, v, |volume| {
                volume.source = source;
                volume.annotations = annotations;
            })
        });
        if references(&state, replacement) {
            return Err(domain(
                "Replacement asset ",
                replacement.as_utf16(),
                " acquired another canonical reference before undo",
            ));
        }
        remove_descriptor(&mut state, replacement_index);
        match &previous.removed_old {
            Some((descriptor, lease)) => {
                if position(&state, &self.asset).is_some() || context.assets().has(&self.asset) {
                    return Err(domain(
                        "Old asset ",
                        self.asset.as_utf16(),
                        " collides with canonical state during undo",
                    ));
                }
                if previous.old_index > state.source_assets.len() {
                    return Err(domain(
                        "Old asset ",
                        self.asset.as_utf16(),
                        " cannot be restored at its original position",
                    ));
                }
                insert_descriptor(&mut state, previous.old_index, descriptor.clone());
                put(context, lease)?;
            }
            None => {
                canonical_mesh(context, &state, &self.asset)?;
            }
        }
        context.replace(state, reason, PROJECT)?;
        context.assets_mut().remove(replacement);
        Ok(())
    }

    pub(super) fn estimate(&self) -> io::Result<u64> {
        let mut total = length(&self.guard.value())? + payload_bytes(self.replacement.lease())?;
        if let Some(previous) = &self.previous {
            let mut count = Length::default();
            count.write_all(b"{\"annotations\":")?;
            previous.annotations.write_json(&mut count)?;
            count.write_all(b",\"source\":")?;
            previous.source.write_json(&mut count)?;
            count.write_all(b"}")?;
            total += count.units;
            if let Some((_, lease)) = &previous.removed_old {
                total += payload_bytes(lease)?;
            }
        }
        Ok(total.max(1))
    }
}

/// `MeshBooleanOp`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BooleanOp {
    Union,
    ANotB,
    Intersection,
}

/// `MeshBooleanGuard` as received; `new` checks it like `assertBooleanGuard`.
#[derive(Clone)]
pub struct BooleanGuard {
    pub target_instance_id: Vec<u16>,
    pub target_volume_id: Vec<u16>,
    pub target_asset_id: Vec<u16>,
    pub target_asset_digest: Vec<u16>,
    pub target_topology_revision: f64,
    pub target_triangle_count: f64,
    pub other_instance_id: Vec<u16>,
}
impl BooleanGuard {
    fn value(&self) -> Value {
        object(vec![
            ("targetInstanceId", string(&self.target_instance_id)),
            ("targetVolumeId", string(&self.target_volume_id)),
            ("targetAssetId", string(&self.target_asset_id)),
            ("targetAssetDigest", string(&self.target_asset_digest)),
            (
                "targetTopologyRevision",
                Value::Number(self.target_topology_revision),
            ),
            (
                "targetTriangleCount",
                Value::Number(self.target_triangle_count),
            ),
            ("otherInstanceId", string(&self.other_instance_id)),
        ])
    }
}

#[derive(Clone)]
struct PreviousTarget {
    source: MeshSourceRef,
    annotations: Arc<FacetAnnotations>,
    volume_transform: Transform,
    instance_transform: Transform,
    old_index: Option<usize>,
    removed_old: Option<(Arc<SourceAssetDescriptor>, AssetLease)>,
}
#[derive(Clone)]
enum RemovedOther {
    Object {
        plate: PlateId,
        index: usize,
        object: Arc<ProjectObject>,
        assets: Vec<(usize, Arc<SourceAssetDescriptor>, AssetLease)>,
    },
    Instance {
        object: ObjectId,
        index: usize,
        instance: Arc<ProjectInstance>,
    },
}

/// `MeshBooleanCommand`: the target volume takes the boolean result (both
/// transforms reset, since the result is in bed coordinates) and the other
/// instance goes, with its object when it was the last instance.
#[derive(Clone)]
pub(super) struct MeshBoolean {
    guard: BooleanGuard,
    target_instance: InstanceId,
    target_volume: VolumeId,
    target_asset: AssetId,
    other: InstanceId,
    replacement: StagedAsset,
    triangles: f64,
    applied: Option<Arc<(PreviousTarget, RemovedOther)>>,
}
impl MeshBoolean {
    pub(super) fn new(
        guard: BooleanGuard,
        replacement: StagedAsset,
        op: BooleanOp,
    ) -> Result<(Self, Text), PreparationError> {
        if guard.target_instance_id == guard.other_instance_id {
            return Err(prepared("A mesh boolean needs two different instances"));
        }
        let target_instance = stable(&guard.target_instance_id)
            .ok_or_else(|| prepared("Target instance ID is not stable"))?;
        let target_volume = stable(&guard.target_volume_id)
            .ok_or_else(|| prepared("Target volume ID is not stable"))?;
        let target_asset = stable(&guard.target_asset_id)
            .ok_or_else(|| prepared("Target asset ID is not stable"))?;
        let other = stable(&guard.other_instance_id)
            .ok_or_else(|| prepared("Other instance ID is not stable"))?;
        if trimmed_empty(&guard.target_asset_digest) {
            return Err(prepared("Topology guard asset digest is required"));
        }
        guard_number(
            guard.target_topology_revision,
            "Topology guard revision must be a non-negative safe integer",
        )?;
        guard_number(
            guard.target_triangle_count,
            "Topology guard triangle count must be a non-negative safe integer",
        )?;
        let label = Text::from_utf8(match op {
            BooleanOp::Union => "Union meshes",
            BooleanOp::ANotB => "Subtract mesh",
            BooleanOp::Intersection => "Intersect meshes",
        });
        let triangles = replacement_triangles(&replacement)?;
        if *replacement.id() == target_asset {
            return Err(prepared_parts(
                "Replacement asset ",
                target_asset.as_utf16(),
                " collides with the current mesh asset",
            ));
        }
        Ok((
            Self {
                guard,
                target_instance,
                target_volume,
                target_asset,
                other,
                replacement,
                triangles,
                applied: None,
            },
            label,
        ))
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let volume_id = &self.guard.target_volume_id;
        let Some((tp, to, ti)) = locate_instance(&state, &self.target_instance) else {
            return Err(domain(
                "Target instance ",
                &self.guard.target_instance_id,
                " is missing",
            ));
        };
        let Some(tv) = state.plates[tp].objects[to]
            .volumes
            .iter()
            .position(|v| v.id == self.target_volume)
        else {
            return Err(domain("Target volume ", volume_id, " is missing"));
        };
        let target = &state.plates[tp].objects[to];
        let source = &target.volumes[tv].source;
        if source.asset_id != self.target_asset {
            return Err(domain("Target volume ", volume_id, " changed mesh asset"));
        }
        if source.topology_revision.get() != self.guard.target_topology_revision {
            return Err(domain(
                "Target volume ",
                volume_id,
                " changed topology revision",
            ));
        }
        if source.triangle_count.get() != self.guard.target_triangle_count {
            return Err(domain(
                "Target volume ",
                volume_id,
                " changed triangle count",
            ));
        }
        let (old_descriptor, old_lease) = canonical_mesh(context, &state, &self.target_asset)?;
        if old_descriptor.digest.units() != self.guard.target_asset_digest.as_slice() {
            return Err(domain("Target volume ", volume_id, " changed asset digest"));
        }
        let Some((op, oo, oi)) = locate_instance(&state, &self.other) else {
            return Err(domain(
                "Other instance ",
                &self.guard.other_instance_id,
                " is missing",
            ));
        };
        assert_available(context, &state, &self.replacement)?;
        let target = &state.plates[tp].objects[to];
        let volume = &target.volumes[tv];
        let previous = PreviousTarget {
            source: volume.source.clone(),
            annotations: volume.annotations.clone(),
            volume_transform: volume.transform.clone(),
            instance_transform: target.instances[ti].transform.clone(),
            old_index: None,
            removed_old: None,
        };
        let next = self.guard.target_topology_revision + 1.0;
        let replaced = replacement_source(&self.replacement, next, self.triangles)?;
        let empty = empty_annotations(next)?;
        with_object(&mut state, tp, to, |object| {
            with_volume(object, tv, |volume| {
                volume.source = replaced;
                volume.annotations = empty;
                volume.transform = identity_transform();
            });
            let mut instances = object.instances.to_vec();
            Arc::make_mut(&mut instances[ti]).transform = identity_transform();
            object.instances = instances.into();
        });
        push_descriptor(&mut state, self.replacement.descriptor().clone());

        let other_object = state.plates[op].objects[oo].clone();
        let removed = if other_object.instances.len() <= 1 {
            let mut plates = state.plates.to_vec();
            let plate = Arc::make_mut(&mut plates[op]);
            let mut objects = plate.objects.to_vec();
            objects.remove(oo);
            plate.objects = objects.into();
            let plate_id = plate.id.clone();
            state.plates = plates.into();
            let mut assets = Vec::new();
            for volume in other_object.volumes.iter() {
                let id = &volume.source.asset_id;
                if references(&state, id) || *id == self.target_asset {
                    continue;
                }
                if let Some(index) = position(&state, id) {
                    let (descriptor, lease) = canonical_mesh(context, &state, id)?;
                    assets.push((index, descriptor, lease));
                    remove_descriptor(&mut state, index);
                }
            }
            RemovedOther::Object {
                plate: plate_id,
                index: oo,
                object: other_object,
                assets,
            }
        } else {
            let instance = other_object.instances[oi].clone();
            with_object(&mut state, op, oo, |object| {
                let mut instances = object.instances.to_vec();
                instances.remove(oi);
                object.instances = instances.into();
            });
            RemovedOther::Instance {
                object: other_object.id.clone(),
                index: oi,
                instance,
            }
        };

        let remove_old = !references(&state, &self.target_asset);
        let old_index = position(&state, &self.target_asset);
        if remove_old && let Some(index) = old_index {
            remove_descriptor(&mut state, index);
        }
        put(context, self.replacement.lease())?;
        context.replace(state, reason, PROJECT)?;
        if remove_old {
            context.assets_mut().remove(&self.target_asset);
        }
        if let RemovedOther::Object { assets, .. } = &removed {
            for (_, _, lease) in assets {
                context.assets_mut().remove(lease.id());
            }
        }
        context.set_selection(
            &[SelectionRef::Instance(self.target_instance.clone())],
            None,
        )?;
        self.applied = Some(Arc::new((
            PreviousTarget {
                old_index,
                removed_old: remove_old.then_some((old_descriptor, old_lease)),
                ..previous
            },
            removed,
        )));
        Ok(())
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let Some(applied) = &self.applied else {
            return Err(CommandError::domain(
                "MeshBooleanCommand has not been applied",
            ));
        };
        let (previous, removed) = applied.as_ref();
        let mut state = context.snapshot().state().clone();
        let Some((tp, to, ti)) = locate_instance(&state, &self.target_instance) else {
            return Err(domain(
                "Target instance ",
                &self.guard.target_instance_id,
                " missing on revert",
            ));
        };
        let Some(tv) = state.plates[tp].objects[to]
            .volumes
            .iter()
            .position(|v| v.id == self.target_volume)
        else {
            return Err(domain(
                "Target volume ",
                &self.guard.target_volume_id,
                " missing on revert",
            ));
        };
        with_object(&mut state, tp, to, |object| {
            with_volume(object, tv, |volume| {
                volume.source = previous.source.clone();
                volume.annotations = previous.annotations.clone();
                volume.transform = previous.volume_transform.clone();
            });
            let mut instances = object.instances.to_vec();
            Arc::make_mut(&mut instances[ti]).transform = previous.instance_transform.clone();
            object.instances = instances.into();
        });
        // The exact reverse of apply's descriptor edits.
        if let (Some((descriptor, lease)), Some(index)) =
            (&previous.removed_old, previous.old_index)
        {
            insert_descriptor(&mut state, index, descriptor.clone());
            put(context, lease)?;
        }
        match removed {
            RemovedOther::Object {
                plate,
                index,
                object,
                assets,
            } => {
                let Some(p) = state
                    .plates
                    .iter()
                    .position(|candidate| candidate.id == *plate)
                else {
                    return Err(domain("Plate ", plate.as_utf16(), " missing on revert"));
                };
                let mut plates = state.plates.to_vec();
                let target = Arc::make_mut(&mut plates[p]);
                let mut objects = target.objects.to_vec();
                objects.insert((*index).min(objects.len()), object.clone());
                target.objects = objects.into();
                state.plates = plates.into();
                for (index, descriptor, lease) in assets.iter().rev() {
                    insert_descriptor(&mut state, *index, descriptor.clone());
                    put(context, lease)?;
                }
            }
            RemovedOther::Instance {
                object,
                index,
                instance,
            } => {
                let Some((p, o)) = locate_object(&state, object) else {
                    return Err(domain("Object ", object.as_utf16(), " missing on revert"));
                };
                with_object(&mut state, p, o, |object| {
                    let mut instances = object.instances.to_vec();
                    instances.insert((*index).min(instances.len()), instance.clone());
                    object.instances = instances.into();
                });
            }
        }
        if let Some(index) = position(&state, self.replacement.id()) {
            remove_descriptor(&mut state, index);
        }
        context.replace(state, reason, PROJECT)?;
        context.assets_mut().remove(self.replacement.id());
        context.set_selection(
            &[SelectionRef::Instance(self.target_instance.clone())],
            None,
        )
    }

    /// Retained records at their canonical length, payloads at their bytes.
    pub(super) fn estimate(&self) -> io::Result<u64> {
        let mut total = length(&self.guard.value())? + payload_bytes(self.replacement.lease())?;
        let Some(applied) = &self.applied else {
            return Ok(total.max(1));
        };
        let (previous, removed) = applied.as_ref();
        let mut count = Length::default();
        count.write_all(b"{\"annotations\":")?;
        previous.annotations.write_json(&mut count)?;
        count.write_all(b",\"instanceTransform\":")?;
        previous.instance_transform.write_json(&mut count)?;
        count.write_all(b",\"oldDescriptorIndex\":")?;
        write_index(&mut count, previous.old_index)?;
        count.write_all(b",\"source\":")?;
        previous.source.write_json(&mut count)?;
        count.write_all(b",\"volumeTransform\":")?;
        previous.volume_transform.write_json(&mut count)?;
        count.write_all(b"}")?;
        if let Some((_, lease)) = &previous.removed_old {
            total += payload_bytes(lease)?;
        }
        match removed {
            RemovedOther::Object {
                plate,
                index,
                object,
                assets,
            } => {
                count.write_all(b"{\"kind\":\"object\",\"object\":")?;
                object.write_json(&mut count)?;
                count.write_all(b",\"objectIndex\":")?;
                write_index(&mut count, Some(*index))?;
                count.write_all(b",\"plateId\":")?;
                plate.write_json(&mut count)?;
                count.write_all(b"}")?;
                for (_, _, lease) in assets {
                    total += payload_bytes(lease)?;
                }
            }
            RemovedOther::Instance {
                object,
                index,
                instance,
            } => {
                count.write_all(b"{\"instance\":")?;
                instance.write_json(&mut count)?;
                count.write_all(b",\"instanceIndex\":")?;
                write_index(&mut count, Some(*index))?;
                count.write_all(b",\"kind\":\"instance\",\"objectId\":")?;
                object.write_json(&mut count)?;
                count.write_all(b"}")?;
            }
        }
        total += count.units;
        Ok(total.max(1))
    }
}
