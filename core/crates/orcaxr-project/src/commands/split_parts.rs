//! `SplitVolumeToPartsCommand`: commit an engine-prepared, lossless split of one
//! volume into parts of the same object. Every part gets a fresh stable volume
//! ID, its own (or a shared) immutable mesh, reset annotations and the staged
//! transform; the source mesh goes when nothing else references it. Payloads
//! are leases, so redo and undo share records instead of copying bytes.
use super::topology::{
    canonical_mesh, domain, empty_annotations, length, locate_volume, payload_bytes, position,
    prepared, prepared_parts, put, references, safe_integer, stable, string, trimmed_empty, u,
    with_object,
};
use super::*;
use crate::assets::AssetLease;
use crate::mesh::validate_indexed;
use orcaxr_contracts::canonical::Value;
use std::collections::{HashMap, HashSet};
use std::io::{self, Write};

const CORE_FACET_ATTRIBUTES_KEY: &str =
    "https://orcaxr.martinez.fyi/3mf/project/1/core-facet-attributes";

/// `VolumeSplitGuard` as received (`MeshTopologyReplacementGuard` plus the
/// source volume's canonical JSON).
#[derive(Clone)]
pub struct VolumeSplitGuard {
    pub volume_id: Vec<u16>,
    pub asset_id: Vec<u16>,
    pub asset_digest: Vec<u16>,
    pub topology_revision: f64,
    pub triangle_count: f64,
    pub volume_fingerprint: Vec<u16>,
}

/// `PreparedVolumeSplitPart` as received.
#[derive(Clone)]
pub struct SplitPart {
    pub volume_id: Vec<u16>,
    pub asset: StagedAsset,
    pub transform: Transform,
    pub source_triangles: Vec<f64>,
}

#[derive(Clone)]
struct Part {
    volume: VolumeId,
    asset: AssetId,
    transform: Transform,
    source_triangles: Vec<f64>,
    triangles: f64,
}

#[derive(Clone)]
struct Previous {
    object: ObjectId,
    index: usize,
    original: Arc<ProjectVolume>,
    generated: Vec<Arc<ProjectVolume>>,
    owned: Vec<StagedAsset>,
    old_index: usize,
    removed_old: Option<(Arc<SourceAssetDescriptor>, AssetLease)>,
}

#[derive(Clone)]
pub(super) struct SplitVolumeToParts {
    guard: VolumeSplitGuard,
    volume: VolumeId,
    asset: AssetId,
    parts: Vec<Part>,
    assets: Vec<StagedAsset>,
    previous: Option<Arc<Previous>>,
}

/// `String(n)` for a finite number (what a template literal prints).
fn js_number(n: f64) -> String {
    let mut out = Vec::new();
    Value::Number(n)
        .write_canonical(&mut out)
        .expect("finite numbers encode");
    String::from_utf8(out).expect("ASCII")
}
/// `assertTransform` for a typed transform: dimensions and finiteness hold by
/// construction; zero scale and a zero rotation are refused.
fn assert_transform(transform: &Transform, label: &str) -> Result<(), PreparationError> {
    if transform.scale.iter().any(|v| v.get().abs() < 1e-12) {
        return Err(prepared(&format!(
            "{label} transform scale cannot contain zero"
        )));
    }
    let norm = transform
        .rotation
        .iter()
        .fold(0.0, |sum, v| sum + v.get() * v.get());
    if norm < 1e-12 {
        return Err(prepared(&format!(
            "{label} transform rotation cannot be zero"
        )));
    }
    Ok(())
}
fn same_payload(left: &AssetLease, right: &AssetLease) -> bool {
    left.descriptor() == right.descriptor() && left.bytes() == right.bytes()
}

/// Compares a canonical UTF-8 stream with expected UTF-16 text, without
/// materializing the stream (a painted volume's JSON can be large).
struct Matches<'a> {
    expected: &'a [u16],
    at: usize,
    pending: Vec<u8>,
    equal: bool,
}
impl Write for Matches<'_> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.pending.extend_from_slice(bytes);
        let valid = match std::str::from_utf8(&self.pending) {
            Ok(text) => text.len(),
            Err(error) => error.valid_up_to(),
        };
        let text = std::str::from_utf8(&self.pending[..valid]).expect("valid prefix");
        for unit in text.encode_utf16() {
            if self.expected.get(self.at) != Some(&unit) {
                self.equal = false;
            }
            self.at += 1;
        }
        self.pending.drain(..valid);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
fn canonical_text_is(value: &impl Encode, expected: &[u16]) -> io::Result<bool> {
    let mut matches = Matches {
        expected,
        at: 0,
        pending: Vec::new(),
        equal: true,
    };
    value.write_json(&mut matches)?;
    Ok(matches.equal && matches.pending.is_empty() && matches.at == expected.len())
}

impl VolumeSplitGuard {
    fn value(&self) -> Value {
        super::topology::object(vec![
            ("volumeId", string(&self.volume_id)),
            ("assetId", string(&self.asset_id)),
            ("assetDigest", string(&self.asset_digest)),
            ("topologyRevision", Value::Number(self.topology_revision)),
            ("triangleCount", Value::Number(self.triangle_count)),
            ("volumeFingerprint", string(&self.volume_fingerprint)),
        ])
    }
}

impl SplitVolumeToParts {
    pub(super) fn new(
        guard: VolumeSplitGuard,
        parts: Vec<SplitPart>,
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
            return Err(prepared("Volume split guard asset digest is required"));
        }
        if guard.volume_fingerprint.is_empty() {
            return Err(prepared("Volume split guard fingerprint is required"));
        }
        if !safe_integer(guard.topology_revision) || guard.topology_revision < 0.0 {
            return Err(prepared(
                "Volume split guard topology revision must be a non-negative safe integer",
            ));
        }
        if !safe_integer(guard.triangle_count) || guard.triangle_count < 1.0 {
            return Err(prepared(
                "Volume split guard triangle count must be a positive safe integer",
            ));
        }
        if parts.len() < 2 {
            return Err(prepared(
                "Split to parts requires at least two prepared components",
            ));
        }
        let mut volume_ids: HashSet<Vec<u16>> = HashSet::new();
        let mut assets: Vec<StagedAsset> = Vec::new();
        let mut owners: HashMap<Vec<u16>, AssetId> = HashMap::new();
        let mut seen: HashSet<u64> = HashSet::new();
        let mut normalized = Vec::with_capacity(parts.len());
        for (index, part) in parts.into_iter().enumerate() {
            let number = index + 1;
            let Some(id) = stable(&part.volume_id) else {
                return Err(prepared_parts(
                    "Prepared split volume ID ",
                    &part.volume_id,
                    " is not stable",
                ));
            };
            if part.volume_id == guard.volume_id {
                return Err(prepared(
                    "Pinned split-to-parts semantics require fresh IDs for every generated volume",
                ));
            }
            if !volume_ids.insert(part.volume_id.clone()) {
                return Err(prepared_parts(
                    "Prepared split volume ID ",
                    &part.volume_id,
                    " is duplicated",
                ));
            }
            assert_transform(&part.transform, &format!("Prepared split part {number}"))?;
            let staged = &part.asset;
            if *staged.id() == asset {
                return Err(prepared_parts(
                    "Prepared split asset ",
                    staged.id().as_utf16(),
                    " collides with the source asset",
                ));
            }
            if trimmed_empty(staged.descriptor().digest.units()) {
                return Err(prepared("Prepared split asset digest is required"));
            }
            let counts = validate_indexed(staged.lease()).map_err(|m| prepared(&m))?;
            if counts.vertices == 0 || counts.triangles == 0 {
                return Err(prepared(&format!(
                    "Prepared split part {number} must contain a non-empty mesh"
                )));
            }
            if counts.triangles != part.source_triangles.len() {
                return Err(prepared(&format!(
                    "Prepared split part {number} has {} triangles but maps {}",
                    counts.triangles,
                    part.source_triangles.len()
                )));
            }
            for &triangle in &part.source_triangles {
                if !safe_integer(triangle) || triangle < 0.0 || triangle >= guard.triangle_count {
                    return Err(prepared(&format!(
                        "Prepared split source triangle {} is outside the guarded topology",
                        js_number(triangle)
                    )));
                }
                if !seen.insert(triangle as u64) {
                    return Err(prepared(&format!(
                        "Prepared split source triangle {} appears in multiple parts",
                        js_number(triangle)
                    )));
                }
            }
            let existing = assets.iter().find(|a| a.id() == staged.id());
            if let Some(existing) = existing
                && !same_payload(existing.lease(), staged.lease())
            {
                return Err(prepared_parts(
                    "Prepared split asset ID ",
                    staged.id().as_utf16(),
                    " has conflicting immutable payloads",
                ));
            }
            let digest = staged.descriptor().digest.units().to_vec();
            if let Some(owner) = owners.get(&digest)
                && owner != staged.id()
            {
                let mut message = u("Prepared split digest ");
                message.extend_from_slice(&digest);
                message.extend(" is assigned to both ".encode_utf16());
                message.extend_from_slice(owner.as_utf16());
                message.extend(" and ".encode_utf16());
                message.extend_from_slice(staged.id().as_utf16());
                return Err(PreparationError::Domain(Text::new(message)));
            }
            if existing.is_none() {
                assets.push(staged.clone());
            }
            owners.insert(digest, staged.id().clone());
            normalized.push(Part {
                volume: id,
                asset: staged.id().clone(),
                transform: part.transform,
                source_triangles: part.source_triangles,
                triangles: counts.triangles as f64,
            });
        }
        if seen.len() as f64 != guard.triangle_count {
            return Err(prepared(&format!(
                "Prepared split maps {} of {} source triangles; lossy splits are not representable",
                seen.len(),
                js_number(guard.triangle_count)
            )));
        }
        for staged in &assets {
            if volume_ids.contains(staged.id().as_utf16()) {
                return Err(prepared_parts(
                    "Injected stable ID ",
                    staged.id().as_utf16(),
                    " is reused by a split volume and asset",
                ));
            }
        }
        Ok(Self {
            guard,
            volume,
            asset,
            parts: normalized,
            assets,
            previous: None,
        })
    }
}

impl SplitVolumeToParts {
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let id = &self.guard.volume_id;
        // `requireGuardedVolume`
        let Some((p, o, v)) = locate_volume(&state, &self.volume) else {
            return Err(domain(
                "Stale volume split: source volume ",
                id,
                " is missing",
            ));
        };
        let original = state.plates[p].objects[o].volumes[v].clone();
        if original.source.asset_id != self.asset
            || original.source.topology_revision.get() != self.guard.topology_revision
            || original.source.triangle_count.get() != self.guard.triangle_count
        {
            return Err(domain(
                "Stale volume split: source topology for ",
                id,
                " changed",
            ));
        }
        if !canonical_text_is(original.as_ref(), &self.guard.volume_fingerprint)
            .map_err(|_| CommandError::Encoding)?
        {
            return Err(domain(
                "Stale volume split: source metadata or transform for ",
                id,
                " changed",
            ));
        }
        let (descriptor, lease) = canonical_mesh(context, &state, &self.asset)?;
        if descriptor.digest.units() != self.guard.asset_digest.as_slice()
            || descriptor.mesh.as_ref().map(|m| m.triangle_count.get())
                != Some(self.guard.triangle_count)
        {
            return Err(domain(
                "Stale volume split: source asset for ",
                id,
                " changed",
            ));
        }
        // `assertRepresentableMetadata`
        if let Some(Value::Object(fields)) = original.extension_data.as_ref().map(JsonObject::value)
            && fields.contains_key(&u(CORE_FACET_ATTRIBUTES_KEY))
        {
            return Err(CommandError::domain(
                "Split to parts cannot preserve opaque triangle-indexed 3MF extension metadata without an explicit facet map",
            ));
        }
        // `classifyPreparedAssets`
        let existing = ids_in_use(&state);
        for part in &self.parts {
            if existing.contains(part.volume.as_utf16()) {
                return Err(domain(
                    "Injected split ID ",
                    part.volume.as_utf16(),
                    " already exists in the project",
                ));
            }
        }
        let mut owned = Vec::new();
        for staged in &self.assets {
            let id = staged.id();
            let declared = state.source_assets.iter().find(|d| d.id == *id);
            let stored = context.assets().peek(id);
            match (declared, stored) {
                (Some(declared), Some(stored)) => {
                    if !declared
                        .matches_value(staged.lease().descriptor())
                        .map_err(|_| CommandError::Encoding)?
                        || !same_payload(&stored, staged.lease())
                    {
                        return Err(domain(
                            "Prepared split asset ",
                            id.as_utf16(),
                            " collides with a different immutable payload",
                        ));
                    }
                    continue;
                }
                (None, None) => {}
                _ => {
                    return Err(domain(
                        "Prepared split asset ",
                        id.as_utf16(),
                        " is inconsistent between canonical state and repository",
                    ));
                }
            }
            if existing.contains(id.as_utf16()) {
                return Err(domain(
                    "Injected split ID ",
                    id.as_utf16(),
                    " already exists in the project",
                ));
            }
            let digest = staged.descriptor().digest.units();
            if let Some(found) = state
                .source_assets
                .iter()
                .find(|d| d.digest.units() == digest)
            {
                return Err(domain(
                    "Prepared split asset digest already exists as ",
                    found.id.as_utf16(),
                    "; remap before committing",
                ));
            }
            if let Some(found) = context.assets().find_id_by_digest(digest) {
                return Err(domain(
                    "Prepared split asset digest collides with repository asset ",
                    found.as_utf16(),
                    "",
                ));
            }
            owned.push(staged.clone());
        }
        drop(existing);

        let object = state.plates[p].objects[o].id.clone();
        let old_index = position(&state, &self.asset).expect("declared exactly once");
        let empty = empty_annotations(0.0)?;
        let generated = self
            .parts
            .iter()
            .enumerate()
            .map(|(index, part)| {
                let mut volume = (*original).clone();
                volume.id = part.volume.clone();
                volume.name =
                    Text::new([original.name.units(), &u(&format!("_{}", index + 1))].concat());
                volume.source = MeshSourceRef {
                    asset_id: part.asset.clone(),
                    topology_revision: Number::new(0.0).expect("zero"),
                    triangle_count: Number::new(part.triangles).expect("finite"),
                    extra: ExtraFields::default(),
                };
                volume.transform = part.transform.clone();
                volume.annotations = empty.clone();
                Arc::new(volume)
            })
            .collect::<Vec<_>>();
        with_object(&mut state, p, o, |object| {
            let mut volumes = object.volumes.to_vec();
            volumes.splice(v..=v, generated.iter().cloned());
            object.volumes = volumes.into();
        });
        let remove_old = !references(&state, &self.asset);
        let insert_at = if remove_old { old_index } else { old_index + 1 };
        let mut assets = state.source_assets.to_vec();
        if remove_old {
            assets.remove(old_index);
        }
        assets.splice(
            insert_at..insert_at,
            owned.iter().map(|staged| staged.descriptor().clone()),
        );
        state.source_assets = assets.into();
        for staged in &owned {
            put(context, staged.lease())?;
        }
        context.replace(state, reason, PROJECT)?;
        if remove_old {
            context.assets_mut().remove(&self.asset);
        }
        self.remap_selection(context)?;
        self.previous = Some(Arc::new(Previous {
            object,
            index: v,
            original,
            generated,
            owned,
            old_index,
            removed_old: remove_old.then_some((descriptor, lease)),
        }));
        Ok(())
    }

    /// `remapSplitSelection`: a selected source volume becomes every part, a
    /// primary source the first part.
    fn remap_selection<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let before = context.selection();
        let source = SelectionRef::Volume(self.volume.clone());
        let primary_source = before.primary() == Some(&source);
        if !before.refs().contains(&source) && !primary_source {
            return Ok(());
        }
        let refs = before
            .refs()
            .iter()
            .flat_map(|r| {
                if *r == source {
                    self.parts
                        .iter()
                        .map(|part| SelectionRef::Volume(part.volume.clone()))
                        .collect()
                } else {
                    vec![r.clone()]
                }
            })
            .collect::<Vec<_>>();
        let primary = if primary_source {
            Some(SelectionRef::Volume(self.parts[0].volume.clone()))
        } else {
            before.primary().cloned()
        };
        context.set_selection(&refs, primary)
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let Some(previous) = &self.previous else {
            return Err(CommandError::domain(
                "SplitVolumeToPartsCommand has not been applied",
            ));
        };
        let mut state = context.snapshot().state().clone();
        let Some((p, o)) = locate_object(&state, &previous.object) else {
            return Err(domain(
                "Split object ",
                previous.object.as_utf16(),
                " is missing during undo",
            ));
        };
        let volumes = &state.plates[p].objects[o].volumes;
        let end = (previous.index + previous.generated.len()).min(volumes.len());
        let current = volumes
            .get(previous.index.min(volumes.len())..end)
            .unwrap_or(&[]);
        if current.len() != previous.generated.len()
            || current.iter().zip(&previous.generated).any(|(a, b)| a != b)
        {
            return Err(domain(
                "Generated split parts for volume ",
                &self.guard.volume_id,
                " changed before undo",
            ));
        }
        if locate_volume(&state, &self.volume).is_some() {
            return Err(domain(
                "Original volume ",
                &self.guard.volume_id,
                " already exists before split undo",
            ));
        }
        for staged in &self.assets {
            canonical_mesh(context, &state, staged.id())?;
        }
        with_object(&mut state, p, o, |object| {
            let mut volumes = object.volumes.to_vec();
            volumes.splice(
                previous.index..previous.index + previous.generated.len(),
                [previous.original.clone()],
            );
            object.volumes = volumes.into();
        });
        for staged in &previous.owned {
            let id = staged.id();
            if references(&state, id) {
                return Err(domain(
                    "Split asset ",
                    id.as_utf16(),
                    " acquired another canonical reference before undo",
                ));
            }
            if state.source_assets.iter().filter(|d| d.id == *id).count() != 1 {
                return Err(domain(
                    "Split asset ",
                    id.as_utf16(),
                    " is not declared exactly once during undo",
                ));
            }
        }
        state.source_assets = state
            .source_assets
            .iter()
            .filter(|d| !previous.owned.iter().any(|staged| *staged.id() == d.id))
            .cloned()
            .collect::<Vec<_>>()
            .into();
        match &previous.removed_old {
            Some((descriptor, lease)) => {
                if position(&state, &self.asset).is_some() || context.assets().has(&self.asset) {
                    return Err(domain(
                        "Original asset ",
                        self.asset.as_utf16(),
                        " collides with canonical state during undo",
                    ));
                }
                if previous.old_index > state.source_assets.len() {
                    return Err(domain(
                        "Original asset ",
                        self.asset.as_utf16(),
                        " cannot be restored at its prior position",
                    ));
                }
                let mut assets = state.source_assets.to_vec();
                assets.insert(previous.old_index, descriptor.clone());
                state.source_assets = assets.into();
                put(context, lease)?;
            }
            None => {
                canonical_mesh(context, &state, &self.asset)?;
            }
        }
        context.replace(state, reason, PROJECT)?;
        for staged in &previous.owned {
            context.assets_mut().remove(staged.id());
        }
        Ok(())
    }

    pub(super) fn estimate(&self) -> io::Result<u64> {
        let mut count = Length::default();
        count.write_all(b"[")?;
        for (index, part) in self.parts.iter().enumerate() {
            if index > 0 {
                count.write_all(b",")?;
            }
            count.write_all(b"{\"assetId\":")?;
            part.asset.write_json(&mut count)?;
            count.write_all(b",\"sourceTriangleIndices\":")?;
            Value::Array(
                part.source_triangles
                    .iter()
                    .map(|&t| Value::Number(t))
                    .collect(),
            )
            .write_canonical(&mut count)?;
            count.write_all(b",\"transform\":")?;
            part.transform.write_json(&mut count)?;
            count.write_all(b",\"triangleCount\":")?;
            Value::Number(part.triangles).write_canonical(&mut count)?;
            count.write_all(b",\"volumeId\":")?;
            part.volume.write_json(&mut count)?;
            count.write_all(b"}")?;
        }
        count.write_all(b"]")?;
        let mut total = length(&self.guard.value())? + count.units;
        for staged in &self.assets {
            total += payload_bytes(staged.lease())?;
        }
        if let Some(previous) = &self.previous {
            total += canonical_length(previous.original.as_ref())?;
            let mut generated = Length::default();
            generated.write_all(b"[")?;
            for (index, volume) in previous.generated.iter().enumerate() {
                if index > 0 {
                    generated.write_all(b",")?;
                }
                volume.write_json(&mut generated)?;
            }
            generated.write_all(b"]")?;
            total += generated.units;
            if let Some((_, lease)) = &previous.removed_old {
                total += payload_bytes(lease)?;
            }
        }
        Ok(total.max(1))
    }
}
