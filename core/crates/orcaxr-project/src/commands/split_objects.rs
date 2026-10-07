//! Split to objects (`SeparateObjectVolumesRequestCommand`): promote every model
//! volume of one object into an object of its own without touching mesh bytes.
//! The first apply refuses a project that is no longer the revision the host
//! saw; redo and undo then swap the whole before and after states and
//! selections, refusing either when the project moved underneath them.
use super::*;
use crate::selection::SelectionSnapshot;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::io::{self, Write};

#[derive(Clone)]
struct Identity {
    source: VolumeId,
    object: ObjectId,
    instances: Vec<InstanceId>,
}

/// A selection to restore: its references and primary.
#[derive(Clone)]
struct Selection {
    refs: Vec<SelectionRef>,
    primary: Option<SelectionRef>,
}
impl From<SelectionSnapshot> for Selection {
    fn from(snapshot: SelectionSnapshot) -> Self {
        Self {
            refs: snapshot.refs().to_vec(),
            primary: snapshot.primary().cloned(),
        }
    }
}

#[derive(Clone)]
struct Applied {
    object: ObjectId,
    plate: PlateId,
    source: Arc<ProjectObject>,
    before: ValidatedProject,
    after: ValidatedProject,
    before_selection: Selection,
    after_selection: Selection,
}

/// How the first apply finds its source object.
#[derive(Clone)]
enum Source {
    /// `SeparateObjectVolumesRequestCommand`: the revision the host saw.
    Guarded {
        revision: u64,
        hash: Vec<u16>,
        object: ObjectId,
    },
    /// The second step of a single-volume split to objects: the object that
    /// holds this part once the component split has committed, fingerprinted
    /// there exactly as `commitPreparedVolumeSplitToObjects` does.
    AfterSplit { part: VolumeId },
}

#[derive(Clone)]
pub(super) struct SeparateObjectVolumes {
    source: Source,
    identities: Vec<Identity>,
    applied: Option<Box<Applied>>,
}

impl SeparateObjectVolumes {
    pub(super) fn new(v: wire::SeparateObjectVolumes) -> Result<Self, PreparationError> {
        let identities = v
            .identities
            .into_iter()
            .map(|identity| {
                Ok(Identity {
                    source: id(identity.source_volume_id)?,
                    object: id(identity.object_id)?,
                    instances: ids(identity.instance_ids)?,
                })
            })
            .collect::<Result<Vec<_>, PreparationError>>()?;
        Ok(Self {
            source: Source::Guarded {
                revision: v.guard.source_revision,
                hash: v.guard.source_hash,
                object: id(v.object_id)?,
            },
            identities,
            applied: None,
        })
    }
    /// The promotion step after a component split that produced `part`.
    pub(super) fn after_split(part: VolumeId, identities: Vec<SeparatedObject>) -> Self {
        Self {
            source: Source::AfterSplit { part },
            identities: identities
                .into_iter()
                .map(|identity| Identity {
                    source: identity.source_volume,
                    object: identity.object,
                    instances: identity.instances,
                })
                .collect(),
            applied: None,
        }
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8("Split to objects")
    }

    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        if let Some(applied) = &self.applied {
            if context.snapshot().state() != applied.before.state() {
                return Err(message(
                    "Split-to-objects source ",
                    &applied.object,
                    " changed before redo",
                ));
            }
            context.replace_validated(applied.after.clone(), reason, PROJECT)?;
            return restore(context, &applied.after_selection);
        }
        let snapshot = context.snapshot();
        let state = snapshot.state();
        let (p, o) = match &self.source {
            Source::Guarded {
                revision,
                hash,
                object,
            } => {
                if snapshot.revision() != *revision
                    || !hash.iter().copied().eq(snapshot.hash().encode_utf16())
                {
                    return Err(message("Split-to-objects source ", object, " is stale"));
                }
                let Some(found) = locate_object(state, object) else {
                    return Err(message("Unknown object ", object, ""));
                };
                found
            }
            Source::AfterSplit { part } => {
                let found = state.plates.iter().enumerate().find_map(|(p, plate)| {
                    plate
                        .objects
                        .iter()
                        .position(|o| o.volumes.iter().any(|v| v.id == *part))
                        .map(|o| (p, o))
                });
                let Some(found) = found else {
                    return Err(CommandError::domain(
                        "Prepared split-to-objects output is missing after component commit",
                    ));
                };
                found
            }
        };
        let source = state.plates[p].objects[o].clone();
        validate_source(&source)?;
        validate_identities(state, &source, &self.identities)?;
        let generated = source
            .volumes
            .iter()
            .zip(&self.identities)
            .map(|(volume, identity)| promoted_object(&source, volume, identity))
            .collect::<Result<Vec<_>, _>>()?;
        let mut next = state.clone();
        let mut plates = next.plates.to_vec();
        let plate = Arc::make_mut(&mut plates[p]);
        let mut objects = plate.objects.to_vec();
        objects.splice(o..=o, generated.iter().cloned());
        plate.objects = objects.into();
        next.plates = plates.into();
        let after = context.admit(next)?;

        let before_selection = context.selection();
        let after_selection = remap_selection(&before_selection, &source, &generated);
        let before_selection = Selection::from(before_selection);
        context.replace_validated(after.clone(), reason, PROJECT)?;
        restore(context, &after_selection)?;
        self.applied = Some(Box::new(Applied {
            object: source.id.clone(),
            plate: state.plates[p].id.clone(),
            source,
            before: snapshot.project().clone(),
            after,
            before_selection,
            after_selection,
        }));
        Ok(())
    }

    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let Some(applied) = &self.applied else {
            return Err(CommandError::domain(
                "SeparateObjectVolumesRequestCommand has not been applied",
            ));
        };
        if context.snapshot().state() != applied.after.state() {
            return Err(message(
                "Generated split objects for ",
                &applied.object,
                " changed before undo",
            ));
        }
        context.replace_validated(applied.before.clone(), reason, PROJECT)?;
        restore(context, &applied.before_selection)
    }

    /// The browser charges the canonical guard (whose fingerprint is the source
    /// object's canonical JSON, escaped as a string), the identities, and both
    /// whole states.
    pub(super) fn estimate(&self) -> io::Result<u64> {
        let Some(applied) = &self.applied else {
            return Ok(1);
        };
        let mut count = Length::default();
        count.write_all(b"{\"objectFingerprint\":\"")?;
        count.nested_string = true;
        applied.source.write_json(&mut count)?;
        count.nested_string = false;
        count.write_all(b"\",\"objectId\":")?;
        applied.object.write_json(&mut count)?;
        count.write_all(b",\"plateId\":")?;
        applied.plate.write_json(&mut count)?;
        count.write_all(b"}[")?;
        for (index, identity) in self.identities.iter().enumerate() {
            if index > 0 {
                count.write_all(b",")?;
            }
            count.write_all(b"{\"instanceIds\":[")?;
            for (i, instance) in identity.instances.iter().enumerate() {
                if i > 0 {
                    count.write_all(b",")?;
                }
                instance.write_json(&mut count)?;
            }
            count.write_all(b"],\"objectId\":")?;
            identity.object.write_json(&mut count)?;
            count.write_all(b",\"sourceVolumeId\":")?;
            identity.source.write_json(&mut count)?;
            count.write_all(b"}")?;
        }
        count.write_all(b"]")?;
        let states = canonical_length(applied.before.state())?
            .checked_add(canonical_length(applied.after.state())?)
            .ok_or_else(|| io::Error::other("canonical length overflow"))?;
        count
            .units
            .checked_add(states)
            .ok_or_else(|| io::Error::other("canonical length overflow"))
    }
}

fn message<E>(prefix: &str, object: &ObjectId, suffix: &str) -> CommandError<E> {
    CommandError::Domain(text_parts(prefix, object.as_utf16(), suffix))
}
/// One promoted volume's caller-chosen identities (`SeparatedObjectIdentity`).
#[derive(Clone)]
pub struct SeparatedObject {
    pub source_volume: VolumeId,
    pub object: ObjectId,
    pub instances: Vec<InstanceId>,
}
fn restore<P: TimestampPolicy>(
    context: &mut CommandContext<'_, P>,
    selection: &Selection,
) -> Result<(), CommandError<P::Error>> {
    context.set_selection(&selection.refs, selection.primary.clone())
}

/// `validateSourceObject`, in the browser's order.
fn validate_source<E>(object: &ProjectObject) -> Result<(), CommandError<E>> {
    if object.volumes.len() < 2 {
        return Err(CommandError::domain(
            "Split to objects requires at least two model volumes",
        ));
    }
    if object.volumes.iter().any(|v| v.role != VolumeRole::Model) {
        return Err(CommandError::domain(
            "Split to objects refuses to discard modifier or negative volumes",
        ));
    }
    if object
        .volumes
        .iter()
        .any(|v| v.source.triangle_count.get() < 3.0)
    {
        return Err(CommandError::domain(
            "Split to objects refuses the pinned lossy discard of volumes below three facets",
        ));
    }
    if !object.layer_ranges.is_empty() {
        return Err(CommandError::domain(
            "Split to objects requires an explicit layer-range distribution before promotion",
        ));
    }
    if let Some(extension) = &object.extension_data
        && matches!(extension.value(), Value::Object(fields) if !fields.is_empty())
    {
        return Err(CommandError::domain(
            "Split to objects requires an explicit object-extension distribution before promotion",
        ));
    }
    Ok(())
}

/// `collectStableIds`: unlike `ids_in_use`, source assets and extension blobs
/// are not part of the freshness check.
fn stable_ids(state: &ProjectState) -> HashSet<&[u16]> {
    let mut ids = HashSet::new();
    ids.insert(state.id.as_utf16());
    ids.extend(state.filaments.physical.iter().map(|f| f.id.as_utf16()));
    ids.extend(state.filaments.mixed.iter().map(|f| f.id.as_utf16()));
    for plate in state.plates.iter() {
        ids.insert(plate.id.as_utf16());
        for object in plate.objects.iter() {
            ids.insert(object.id.as_utf16());
            ids.extend(object.volumes.iter().map(|v| v.id.as_utf16()));
            ids.extend(object.instances.iter().map(|i| i.id.as_utf16()));
            ids.extend(object.layer_ranges.iter().map(|r| r.id.as_utf16()));
        }
    }
    ids.extend(state.custom_gcode.iter().map(|c| c.id.as_utf16()));
    ids.extend(state.thumbnails.iter().map(|t| t.id.as_utf16()));
    ids
}

fn validate_identities<E>(
    state: &ProjectState,
    object: &ProjectObject,
    identities: &[Identity],
) -> Result<(), CommandError<E>> {
    if identities.len() != object.volumes.len() {
        return Err(CommandError::domain(
            "Split-to-objects identities must cover every source volume in order",
        ));
    }
    let existing = stable_ids(state);
    let mut generated: HashSet<&[u16]> = HashSet::new();
    for (identity, volume) in identities.iter().zip(object.volumes.iter()) {
        if identity.source != volume.id {
            return Err(CommandError::domain(
                "Split-to-objects volume identities must follow canonical source order",
            ));
        }
        let id = identity.object.as_utf16();
        if existing.contains(id) || !generated.insert(id) {
            return Err(CommandError::Domain(text_parts(
                "Generated split object ID ",
                id,
                " is not fresh and stable",
            )));
        }
        if identity.instances.len() != object.instances.len() {
            return Err(CommandError::Domain(text_parts(
                "Generated split object ",
                id,
                " must clone every source instance",
            )));
        }
        for instance in &identity.instances {
            let id = instance.as_utf16();
            if existing.contains(id) || !generated.insert(id) {
                return Err(CommandError::Domain(text_parts(
                    "Generated split instance ID ",
                    id,
                    " is not fresh and stable",
                )));
            }
        }
    }
    Ok(())
}

/// `promotedObject`: object configuration overlaid by the volume's, the volume
/// re-centred, and its offset carried by every instance's linear transform.
fn promoted_object<E>(
    source: &ProjectObject,
    volume: &ProjectVolume,
    identity: &Identity,
) -> Result<Arc<ProjectObject>, CommandError<E>> {
    let offset = volume.transform.translation_mm.map(|n| n.get());
    let mut promoted = volume.clone();
    promoted.transform.translation_mm = [zero(), zero(), zero()];
    promoted.config = empty_object();
    promoted.filament_id = None;
    let mut config = match source.config.value() {
        Value::Object(fields) => fields.clone(),
        _ => BTreeMap::new(),
    };
    if let Value::Object(fields) = volume.config.value() {
        config.extend(fields.iter().map(|(k, v)| (k.clone(), v.clone())));
    }
    let instances = source
        .instances
        .iter()
        .zip(&identity.instances)
        .map(|(instance, id)| {
            let delta = linear_transform(offset, &instance.transform)?;
            let mut copy = (**instance).clone();
            copy.id = id.clone();
            for (axis, delta) in delta.into_iter().enumerate() {
                copy.transform.translation_mm[axis] =
                    Number::new(instance.transform.translation_mm[axis].get() + delta)
                        .map_err(|_| non_serializable())?;
            }
            Ok(Arc::new(copy))
        })
        .collect::<Result<Vec<_>, CommandError<E>>>()?;
    Ok(Arc::new(ProjectObject {
        id: identity.object.clone(),
        name: volume.name.clone(),
        config: JsonObject::new(Value::Object(config)).map_err(|_| non_serializable())?,
        filament_id: volume
            .filament_id
            .clone()
            .or_else(|| source.filament_id.clone()),
        volumes: vec![Arc::new(promoted)].into(),
        instances: instances.into(),
        layer_ranges: Arc::from([]),
        brim_ears: None,
        layer_height_profile: None,
        extension_data: None,
        extra: ExtraFields::default(),
    }))
}
fn zero() -> Number {
    Number::new(0.0).expect("zero is finite")
}
fn empty_object() -> JsonObject {
    JsonObject::new(Value::Object(BTreeMap::new())).expect("empty object")
}

/// `applyLinearTransform`: scale, then rotate by the normalized quaternion.
fn linear_transform<E>(
    point: [f64; 3],
    transform: &Transform,
) -> Result<[f64; 3], CommandError<E>> {
    let scale = transform.scale.map(|n| n.get());
    let quaternion = transform.rotation.map(|n| n.get());
    let length = crate::js_math::hypot(&quaternion);
    if !length.is_finite() || length < 1e-12 {
        return Err(CommandError::domain(
            "Split-to-objects instance rotation must be finite and non-zero",
        ));
    }
    let [x, y, z, w] = quaternion.map(|value| value / length);
    let v = [
        point[0] * scale[0],
        point[1] * scale[1],
        point[2] * scale[2],
    ];
    let uv = [
        y * v[2] - z * v[1],
        z * v[0] - x * v[2],
        x * v[1] - y * v[0],
    ];
    let uuv = [
        y * uv[2] - z * uv[1],
        z * uv[0] - x * uv[2],
        x * uv[1] - y * uv[0],
    ];
    Ok([
        v[0] + 2.0 * (w * uv[0] + uuv[0]),
        v[1] + 2.0 * (w * uv[1] + uuv[1]),
        v[2] + 2.0 * (w * uv[2] + uuv[2]),
    ])
}

/// `remapSeparatedSelection`: the source object becomes every generated
/// object, each source instance every generated copy of it; the primary
/// follows its first replacement.
fn remap_selection(
    before: &SelectionSnapshot,
    source: &ProjectObject,
    generated: &[Arc<ProjectObject>],
) -> Selection {
    let map = |reference: &SelectionRef| -> Vec<SelectionRef> {
        match reference {
            SelectionRef::Object(id) if *id == source.id => generated
                .iter()
                .map(|o| SelectionRef::Object(o.id.clone()))
                .collect(),
            SelectionRef::Instance(id) => match source.instances.iter().position(|i| i.id == *id) {
                Some(index) => generated
                    .iter()
                    .map(|o| SelectionRef::Instance(o.instances[index].id.clone()))
                    .collect(),
                None => vec![reference.clone()],
            },
            _ => vec![reference.clone()],
        }
    };
    let mut seen = BTreeSet::new();
    let refs: Vec<SelectionRef> = before
        .refs()
        .iter()
        .flat_map(map)
        .filter(|reference| seen.insert(reference.clone()))
        .collect();
    let primary = match before.primary() {
        Some(primary) => map(primary).into_iter().next(),
        None => refs.last().cloned(),
    };
    Selection { refs, primary }
}
