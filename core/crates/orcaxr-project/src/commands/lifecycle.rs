//! Object/instance lifecycle commands. Child records retain immutable metadata
//! and assets; history charges the browser's canonical UTF-16 length, not the
//! size of the shared native allocations. Selection effects keep browser order.
use super::*;
use crate::selection::SelectionSnapshot;
use crate::{
    assets::AssetError,
    clipboard::{ClipboardData, unreferenced_assets},
};

/// Caller-injected identities for an independent copy. Counts and collisions
/// depend on the destination graph and are checked atomically during execution.
#[derive(Clone)]
pub struct IndependentObjectIds {
    pub object_id: ObjectId,
    pub volume_ids: Vec<VolumeId>,
    pub instance_ids: Vec<InstanceId>,
    pub layer_range_ids: Vec<LayerRangeId>,
}
impl IndependentObjectIds {
    fn new(v: wire::DuplicateObject) -> Result<Self, PreparationError> {
        Ok(Self {
            object_id: id(v.object_id)?,
            volume_ids: ids(v.volume_ids)?,
            instance_ids: ids(v.instance_ids)?,
            layer_range_ids: ids(v.layer_range_ids)?,
        })
    }
    fn all(&self) -> Vec<&[u16]> {
        let mut all = vec![self.object_id.as_utf16()];
        all.extend(self.volume_ids.iter().map(EntityId::as_utf16));
        all.extend(self.instance_ids.iter().map(EntityId::as_utf16));
        all.extend(self.layer_range_ids.iter().map(EntityId::as_utf16));
        all
    }
    fn duplicate<E>(
        &self,
        state: &ProjectState,
        source: &ProjectObject,
        name: Option<&Text>,
        single: bool,
    ) -> Result<ProjectObject, CommandError<E>> {
        for (kind, expected, actual) in [
            ("volume", source.volumes.len(), self.volume_ids.len()),
            (
                "instance",
                if single { 1 } else { source.instances.len() },
                self.instance_ids.len(),
            ),
            (
                "layer-range",
                source.layer_ranges.len(),
                self.layer_range_ids.len(),
            ),
        ] {
            if expected != actual {
                return Err(CommandError::domain(format!(
                    "Expected {expected} {kind} IDs, received {actual}"
                )));
            }
        }
        available_for(state, &self.all(), "operation")?;
        let mut object = source.clone();
        object.id = self.object_id.clone();
        object.name = name
            .cloned()
            .unwrap_or_else(|| text_parts("", source.name.units(), " copy"));
        object.volumes = source
            .volumes
            .iter()
            .zip(&self.volume_ids)
            .map(|(v, id)| {
                let mut v = (**v).clone();
                v.id = id.clone();
                Arc::new(v)
            })
            .collect();
        object.layer_ranges = source
            .layer_ranges
            .iter()
            .zip(&self.layer_range_ids)
            .map(|(v, id)| {
                let mut v = (**v).clone();
                v.id = id.clone();
                Arc::new(v)
            })
            .collect();
        if !single {
            object.instances = source
                .instances
                .iter()
                .zip(&self.instance_ids)
                .map(|(v, id)| {
                    let mut v = (**v).clone();
                    v.id = id.clone();
                    Arc::new(v)
                })
                .collect();
        }
        Ok(object)
    }
}
#[derive(Clone)]
pub(super) struct ObjectSlot {
    plate: PlateId,
    index: usize,
    object: Arc<ProjectObject>,
}
#[derive(Clone)]
pub(super) struct InstanceSlot {
    object: ObjectId,
    index: usize,
    instance: Arc<ProjectInstance>,
}
#[derive(Clone)]
pub(super) enum LifecycleCommand {
    CreateInstance {
        object: ObjectId,
        instance: Arc<ProjectInstance>,
        index: Option<Number>,
        applied: bool,
    },
    Paste {
        template: Arc<ProjectObject>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        name: Option<Text>,
        prepared: Option<ObjectSlot>,
        clipboard: Option<Arc<ClipboardData>>,
        inserted_assets: Vec<AssetId>,
    },
    DeleteObject {
        id: ObjectId,
        removed: Option<ObjectSlot>,
    },
    DeletePlateObjects {
        id: PlateId,
        removed: Option<Arc<[Arc<ProjectObject>]>>,
    },
    DeleteInstance {
        id: InstanceId,
        removed: Option<InstanceSlot>,
    },
    Move {
        id: ObjectId,
        destination: PlateId,
        previous: Option<(PlateId, usize)>,
    },
    Duplicate {
        source: ObjectId,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        name: Option<Text>,
        prepared: Option<ObjectSlot>,
    },
    Convert {
        source: InstanceId,
        ids: IndependentObjectIds,
        name: Option<Text>,
        prepared: Option<ObjectSlot>,
        removed: Option<InstanceSlot>,
    },
}
fn optional_text(v: wire::OptionalText) -> Option<Text> {
    match v {
        wire::OptionalText::Absent(_) => None,
        wire::OptionalText::Value(v) => Some(Text::new(v)),
    }
}
fn trimmed_name(name: Option<Text>, error: &str) -> Result<Option<Text>, PreparationError> {
    name.map(|name| {
        let units = name.units();
        let start = units
            .iter()
            .position(|u| !crate::ids::ecmascript_whitespace(*u))
            .ok_or_else(|| PreparationError::Domain(Text::from_utf8(error)))?;
        let end = units
            .iter()
            .rposition(|u| !crate::ids::ecmascript_whitespace(*u))
            .expect("nonblank")
            + 1;
        Ok(Text::new(units[start..end].to_vec()))
    })
    .transpose()
}
impl LifecycleCommand {
    pub(super) fn paste(
        template: Arc<ProjectObject>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        name: Option<Text>,
        clipboard: Option<Arc<ClipboardData>>,
    ) -> Result<Self, PreparationError> {
        Ok(Self::Paste {
            template,
            ids,
            destination,
            name: trimmed_name(name, "Paste object name cannot be empty")?,
            prepared: None,
            clipboard,
            inserted_assets: Vec::new(),
        })
    }
    pub(super) fn duplicate(v: wire::DuplicateObjectEdit) -> Result<Self, PreparationError> {
        let source = id(v.source_object_id)?;
        let ids = IndependentObjectIds::new(v.ids)?;
        let destination = match v.destination_plate_id {
            wire::OptionalPlate::Absent(_) => None,
            wire::OptionalPlate::Value(v) => Some(id(v)?),
        };
        let name = trimmed_name(
            optional_text(v.name),
            "Duplicate object name cannot be empty",
        )?;
        Ok(Self::Duplicate {
            source,
            ids,
            destination,
            name,
            prepared: None,
        })
    }
    pub(super) fn convert(v: wire::ConvertInstanceToObject) -> Result<Self, PreparationError> {
        let source = id(v.instance_id)?;
        let ids = IndependentObjectIds {
            object_id: id(v.ids.object_id)?,
            volume_ids: ids(v.ids.volume_ids)?,
            instance_ids: vec![id(v.ids.instance_id)?],
            layer_range_ids: ids(v.ids.layer_range_ids)?,
        };
        Ok(Self::Convert {
            source,
            ids,
            name: optional_text(v.name),
            prepared: None,
            removed: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(match self {
            Self::CreateInstance { .. } => "Create instance",
            Self::Paste { .. } => "Paste model",
            Self::DeleteObject { .. } => "Delete object",
            Self::DeletePlateObjects { .. } => "Delete all models",
            Self::DeleteInstance { .. } => "Delete instance",
            Self::Move { .. } => "Move object to plate",
            Self::Duplicate { .. } => "Duplicate object",
            Self::Convert { .. } => "Set as individual object",
        })
    }
    pub(super) fn reason(&self) -> &'static str {
        match self {
            Self::CreateInstance { .. } => "create-instance",
            Self::Paste { .. } => "paste-object",
            Self::DeleteObject { .. } => "delete-object",
            Self::DeletePlateObjects { .. } => "delete-plate-objects",
            Self::DeleteInstance { .. } => "delete-instance",
            Self::Move { .. } => "move-object-to-plate",
            Self::Duplicate { .. } => "duplicate-object",
            Self::Convert { .. } => "convert-instance-to-object",
        }
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        if let Self::Move {
            id, destination, ..
        } = self
        {
            let (p, _) = move_indices(state, id, destination)?;
            return Ok(&state.plates[p].id == destination);
        }
        // Empty plate deletion still enters history, but publishes no project.
        Ok(false)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        match self {
            Self::CreateInstance {
                object,
                instance,
                index,
                applied,
            } => {
                let (p, o) = object_index(&state, object)?;
                available_for(&state, &[instance.id.as_utf16()], "operation")?;
                let len = state.plates[p].objects[o].instances.len();
                let position = index.map_or(len as f64, Number::get);
                if position.fract() != 0.0 || position < 0.0 || position > len as f64 {
                    let mut number = Vec::new();
                    Value::Number(position)
                        .write_canonical(&mut number)
                        .expect("finite index");
                    return Err(CommandError::domain(format!(
                        "Instance insertion index {} is outside [0, {len}]",
                        String::from_utf8(number).expect("numeric ASCII")
                    )));
                }
                *applied = true;
                insert_instance(
                    object_at_mut(&mut state, p, o),
                    position as usize,
                    instance.clone(),
                );
                context.replace(state, reason, PROJECT)?;
                context.set_selection(&[SelectionRef::Instance(instance.id.clone())], None)?;
            }
            Self::Paste {
                template,
                ids,
                destination,
                name,
                prepared,
                clipboard,
                inserted_assets,
            } => {
                let dest = destination
                    .as_ref()
                    .unwrap_or(&state.active_plate_id)
                    .clone();
                let p = destination_index(&state, &dest)?;
                let added = if let Some(captured) = clipboard {
                    prepare_clipboard_assets(&mut state, context, captured)?
                } else {
                    Vec::new()
                };
                let object = match prepared {
                    Some(v) => {
                        available_for(&state, &object_ids(&v.object), "operation")?;
                        v.object.clone()
                    }
                    None => Arc::new(ids.duplicate(&state, template, name.as_ref(), false)?),
                };
                let index = state.plates[p].objects.len();
                *prepared = Some(ObjectSlot {
                    plate: dest.clone(),
                    index,
                    object: object.clone(),
                });
                insert_object(&mut state, p, index, object.clone());
                if let Some(captured) = clipboard {
                    merge_clipboard_assets(context, captured)?;
                }
                context.replace(state, reason, PROJECT)?;
                *inserted_assets = added;
                context.set_selection(&[object_selection(&object)], None)?;
            }
            Self::DeleteObject { id, removed } => {
                let (p, o) = object_index(&state, id)?;
                let before = context.selection();
                let object = state.plates[p].objects[o].clone();
                let plate_id = state.plates[p].id.clone();
                *removed = Some(ObjectSlot {
                    plate: plate_id.clone(),
                    index: o,
                    object: object.clone(),
                });
                let mut objects = state.plates[p].objects.to_vec();
                objects.remove(o);
                let fallback = objects
                    .get(o.min(objects.len().saturating_sub(1)))
                    .map(|o| object_selection(o))
                    .unwrap_or(SelectionRef::Plate(plate_id));
                plate_at_mut(&mut state, p).objects = objects.into();
                context.replace(state, reason, PROJECT)?;
                repair_selection(context, &before, |r| belongs(r, &object), fallback)?;
            }
            Self::DeletePlateObjects { id, removed } => {
                let plate = plate_mut(&mut state, id)?;
                if plate.objects.is_empty() {
                    return Ok(());
                }
                *removed = Some(plate.objects.clone());
                plate.objects = Arc::from([]);
                context.set_selection(&[SelectionRef::Plate(id.clone())], None)?;
                context.replace(state, reason, PROJECT)?;
            }
            Self::DeleteInstance { id, removed } => {
                let (p, o, i) = instance_index(&state, id)?;
                let object = &state.plates[p].objects[o];
                if object.instances.len() <= 1 {
                    return Err(CommandError::domain(
                        "Cannot delete the last instance; delete the object instead",
                    ));
                }
                let before = context.selection();
                *removed = Some(InstanceSlot {
                    object: object.id.clone(),
                    index: i,
                    instance: object.instances[i].clone(),
                });
                let mut instances = object.instances.to_vec();
                instances.remove(i);
                let fallback =
                    SelectionRef::Instance(instances[i.min(instances.len() - 1)].id.clone());
                object_at_mut(&mut state, p, o).instances = instances.into();
                context.replace(state, reason, PROJECT)?;
                repair_selection(
                    context,
                    &before,
                    |r| r == &SelectionRef::Instance(id.clone()),
                    fallback,
                )?;
            }
            Self::Move {
                id,
                destination,
                previous,
            } => {
                let (p, d) = move_indices(&state, id, destination)?;
                let o = state.plates[p]
                    .objects
                    .iter()
                    .position(|o| &o.id == id)
                    .expect("source exists");
                *previous = Some((state.plates[p].id.clone(), o));
                let object = remove_object(&mut state, p, o);
                let end = state.plates[d].objects.len();
                insert_object(&mut state, d, end, object);
                context.replace(state, reason, PROJECT)?;
            }
            Self::Duplicate {
                source,
                ids,
                destination,
                name,
                prepared,
            } => {
                let (p, o) = object_index(&state, source)?;
                let dest = destination.as_ref().unwrap_or(&state.plates[p].id);
                let d = destination_index(&state, dest)?;
                let object = match prepared {
                    Some(v) => {
                        available_for(&state, &object_ids(&v.object), "operation")?;
                        v.object.clone()
                    }
                    None => Arc::new(ids.duplicate(
                        &state,
                        &state.plates[p].objects[o],
                        name.as_ref(),
                        false,
                    )?),
                };
                let index = if p == d {
                    o + 1
                } else {
                    state.plates[d].objects.len()
                };
                *prepared = Some(ObjectSlot {
                    plate: dest.clone(),
                    index,
                    object: object.clone(),
                });
                insert_object(&mut state, d, index, object.clone());
                context.replace(state, reason, PROJECT)?;
                context.set_selection(&[object_selection(&object)], None)?;
            }
            Self::Convert {
                source,
                ids,
                name,
                prepared,
                removed,
            } => {
                let (p, o, i) = instance_index(&state, source)?;
                let original = &state.plates[p].objects[o];
                if original.instances.len() <= 1 {
                    return Err(CommandError::domain(
                        "Cannot convert sole instance to individual object",
                    ));
                }
                let instance = original.instances[i].clone();
                *removed = Some(InstanceSlot {
                    object: original.id.clone(),
                    index: i,
                    instance: instance.clone(),
                });
                let object = match prepared {
                    Some(v) => {
                        available_for(&state, &object_ids(&v.object), "operation")?;
                        v.object.clone()
                    }
                    None => {
                        let mut object = ids.duplicate(
                            &state,
                            original,
                            name.as_ref().or(instance.name.as_ref()),
                            true,
                        )?;
                        // The browser intentionally retains only these instance fields;
                        // object/volume metadata and transform extras remain intact.
                        object.instances = Arc::from([Arc::new(ProjectInstance {
                            id: ids.instance_ids[0].clone(),
                            name: instance.name.clone(),
                            transform: instance.transform.clone(),
                            printable: instance.printable,
                            extension_data: None,
                            extra: ExtraFields::default(),
                        })]);
                        Arc::new(object)
                    }
                };
                *prepared = Some(ObjectSlot {
                    plate: state.plates[p].id.clone(),
                    index: o + 1,
                    object: object.clone(),
                });
                let mut instances = original.instances.to_vec();
                instances.remove(i);
                object_at_mut(&mut state, p, o).instances = instances.into();
                insert_object(&mut state, p, o + 1, object.clone());
                context.replace(state, reason, PROJECT)?;
                context.set_selection(
                    &[SelectionRef::Instance(object.instances[0].id.clone())],
                    None,
                )?;
            }
        }
        Ok(())
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        match self {
            Self::CreateInstance {
                object,
                instance,
                applied,
                ..
            } => {
                if !applied {
                    return Err(unapplied("CreateInstanceCommand"));
                }
                let (p, o) = object_index(&state, object)?;
                let object = object_at_mut(&mut state, p, o);
                let index = object
                    .instances
                    .iter()
                    .position(|v| v.id == instance.id)
                    .ok_or_else(|| {
                        CommandError::Domain(text_parts(
                            "Instance ",
                            instance.id.as_utf16(),
                            " is already absent",
                        ))
                    })?;
                let mut instances = object.instances.to_vec();
                instances.remove(index);
                object.instances = instances.into();
            }
            Self::Paste {
                prepared,
                inserted_assets,
                ..
            } => {
                let v = prepared
                    .as_ref()
                    .ok_or_else(|| unapplied("PasteObjectCommand"))?;
                let p = destination_index(&state, &v.plate)?;
                if let Some(o) = state.plates[p]
                    .objects
                    .iter()
                    .position(|o| o.id == v.object.id)
                {
                    remove_object(&mut state, p, o);
                }
                let removing = unreferenced_assets(&state, inserted_assets);
                if !removing.is_empty() {
                    state.source_assets = state
                        .source_assets
                        .iter()
                        .filter(|d| !removing.contains(&d.id))
                        .cloned()
                        .collect();
                    for id in removing {
                        context.assets_mut().remove(&id);
                    }
                }
            }
            Self::DeleteObject { id, removed } => {
                let v = removed
                    .as_ref()
                    .ok_or_else(|| unapplied("DeleteObjectCommand"))?;
                if find_object(&state, id).is_some() {
                    return Err(CommandError::Domain(text_parts(
                        "Object ",
                        id.as_utf16(),
                        " already exists",
                    )));
                }
                let p = plate_index(&state, &v.plate)?;
                insert_object(&mut state, p, v.index, v.object.clone());
            }
            Self::DeletePlateObjects { id, removed } => {
                let Some(objects) = removed else {
                    return Ok(());
                };
                plate_mut(&mut state, id)?.objects = objects.clone();
            }
            Self::DeleteInstance { id, removed } => {
                let v = removed
                    .as_ref()
                    .ok_or_else(|| unapplied("DeleteInstanceCommand"))?;
                if find_instance(&state, id).is_some() {
                    return Err(CommandError::Domain(text_parts(
                        "Instance ",
                        id.as_utf16(),
                        " already exists",
                    )));
                }
                let (p, o) = object_index(&state, &v.object)?;
                insert_instance(object_at_mut(&mut state, p, o), v.index, v.instance.clone());
            }
            Self::Move {
                id,
                destination,
                previous,
            } => {
                let (source, index) = previous
                    .as_ref()
                    .ok_or_else(|| unapplied("MoveObjectToPlateCommand"))?;
                let p = state.plates.iter().position(|p| &p.id == source);
                let d = state.plates.iter().position(|p| &p.id == destination);
                let (Some(p), Some(d)) = (p, d) else {
                    return Err(CommandError::domain(
                        "Object source or destination plate is missing",
                    ));
                };
                let o = state.plates[d]
                    .objects
                    .iter()
                    .position(|o| &o.id == id)
                    .ok_or_else(|| {
                        CommandError::Domain(text_parts(
                            "Object ",
                            id.as_utf16(),
                            " is missing from destination",
                        ))
                    })?;
                let object = remove_object(&mut state, d, o);
                insert_object(&mut state, p, *index, object);
            }
            Self::Duplicate { prepared, .. } => {
                let v = prepared
                    .as_ref()
                    .ok_or_else(|| unapplied("DuplicateObjectCommand"))?;
                let p = destination_index(&state, &v.plate)?;
                let o = state.plates[p]
                    .objects
                    .iter()
                    .position(|o| o.id == v.object.id)
                    .ok_or_else(|| {
                        CommandError::Domain(text_parts(
                            "Duplicated object ",
                            v.object.id.as_utf16(),
                            " is missing",
                        ))
                    })?;
                remove_object(&mut state, p, o);
            }
            Self::Convert {
                source,
                prepared,
                removed,
                ..
            } => {
                let v = prepared
                    .as_ref()
                    .ok_or_else(|| unapplied("ConvertInstanceToIndependentObjectCommand"))?;
                let removed = removed
                    .as_ref()
                    .ok_or_else(|| unapplied("ConvertInstanceToIndependentObjectCommand"))?;
                let p = state
                    .plates
                    .iter()
                    .position(|p| p.id == v.plate)
                    .ok_or_else(|| {
                        CommandError::Domain(text_parts("Plate ", v.plate.as_utf16(), " not found"))
                    })?;
                if let Some(o) = state.plates[p]
                    .objects
                    .iter()
                    .position(|o| o.id == v.object.id)
                {
                    remove_object(&mut state, p, o);
                }
                if let Some(o) = state.plates[p]
                    .objects
                    .iter()
                    .position(|o| o.id == removed.object)
                {
                    insert_instance(
                        object_at_mut(&mut state, p, o),
                        removed.index,
                        removed.instance.clone(),
                    );
                }
                context.replace(state, reason, PROJECT)?;
                return context.set_selection(&[SelectionRef::Instance(source.clone())], None);
            }
        }
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        match self {
            Self::Paste {
                prepared,
                clipboard,
                ..
            } => {
                let base = prepared
                    .as_ref()
                    .map_or(Ok(1), |v| canonical_length(&v.object))?;
                if let Some(captured) = clipboard {
                    let metadata = canonical_length(&captured.descriptors)?;
                    base.checked_add(captured.assets().byte_length())
                        .and_then(|v| v.checked_add(metadata))
                        .ok_or_else(|| std::io::Error::other("clipboard history budget overflow"))
                } else {
                    Ok(base)
                }
            }
            Self::CreateInstance { instance, .. } => canonical_length(instance),
            Self::DeleteObject {
                removed: Some(v), ..
            }
            | Self::Duplicate {
                prepared: Some(v), ..
            }
            | Self::Convert {
                prepared: Some(v), ..
            } => canonical_length(&v.object),
            Self::DeleteInstance {
                removed: Some(v), ..
            } => canonical_length(&v.instance),
            Self::DeletePlateObjects {
                removed: Some(v), ..
            } => canonical_length(v),
            _ => Ok(1),
        }
    }
}
fn prepare_clipboard_assets<P: TimestampPolicy>(
    state: &mut ProjectState,
    context: &CommandContext<'_, P>,
    captured: &ClipboardData,
) -> Result<Vec<AssetId>, CommandError<P::Error>> {
    if !context.assets().owns_selection(captured.assets()) {
        return Err(CommandError::domain("Invalid or foreign asset capture."));
    }
    let wanted: BTreeSet<_> = captured.descriptors().iter().map(|d| &d.id).collect();
    let mut current = std::collections::BTreeMap::new();
    for descriptor in state.source_assets.iter() {
        if wanted.contains(&descriptor.id) {
            current.entry(&descriptor.id).or_insert(descriptor);
        }
    }
    let mut declarations = Vec::new();
    let mut added = Vec::new();
    for (descriptor, lease) in captured
        .descriptors()
        .iter()
        .zip(captured.assets().leases())
    {
        let current = current.get(&descriptor.id);
        if current.is_some() != context.assets().has(&descriptor.id) {
            return Err(CommandError::Domain(text_parts(
                "Asset ",
                descriptor.id.as_utf16(),
                " is not declared consistently in the canonical bundle",
            )));
        }
        if let Some(current) = current {
            if !current
                .matches_value(lease.descriptor())
                .map_err(|_| CommandError::Encoding)?
            {
                return Err(CommandError::Domain(text_parts(
                    "Asset ",
                    descriptor.id.as_utf16(),
                    " metadata does not match its canonical declaration",
                )));
            }
        } else {
            declarations.push(descriptor.clone());
            added.push(descriptor.id.clone());
        }
    }
    if !added.is_empty() {
        let mut all = state.source_assets.to_vec();
        all.extend(declarations);
        state.source_assets = all.into();
    }
    Ok(added)
}
fn merge_clipboard_assets<P: TimestampPolicy>(
    context: &mut CommandContext<'_, P>,
    captured: &ClipboardData,
) -> Result<(), CommandError<P::Error>> {
    match context.assets_mut().merge_selection(captured.assets()) {
        Ok(_) => Ok(()),
        Err(AssetError::ImmutableConflict) => {
            for lease in captured.assets().leases() {
                if context.assets().peek(lease.id()).is_some_and(|existing| {
                    existing.descriptor() != lease.descriptor() || existing.bytes() != lease.bytes()
                }) {
                    return Err(CommandError::Domain(text_parts(
                        "Immutable asset ",
                        lease.id().as_utf16(),
                        " cannot be replaced",
                    )));
                }
            }
            Err(CommandError::Asset(AssetError::ImmutableConflict))
        }
        Err(e) => Err(CommandError::Asset(e)),
    }
}
fn plate_index<E>(state: &ProjectState, id: &PlateId) -> Result<usize, CommandError<E>> {
    state
        .plates
        .iter()
        .position(|p| &p.id == id)
        .ok_or_else(|| unknown(id))
}
fn destination_index<E>(state: &ProjectState, id: &PlateId) -> Result<usize, CommandError<E>> {
    state
        .plates
        .iter()
        .position(|p| &p.id == id)
        .ok_or_else(|| {
            CommandError::Domain(text_parts("Unknown destination plate ", id.as_utf16(), ""))
        })
}
fn object_index<E>(state: &ProjectState, id: &ObjectId) -> Result<(usize, usize), CommandError<E>> {
    state
        .plates
        .iter()
        .enumerate()
        .find_map(|(p, plate)| {
            plate
                .objects
                .iter()
                .position(|o| &o.id == id)
                .map(|o| (p, o))
        })
        .ok_or_else(|| CommandError::Domain(text_parts("Unknown object ", id.as_utf16(), "")))
}
fn instance_index<E>(
    state: &ProjectState,
    id: &InstanceId,
) -> Result<(usize, usize, usize), CommandError<E>> {
    state
        .plates
        .iter()
        .enumerate()
        .find_map(|(p, plate)| {
            plate.objects.iter().enumerate().find_map(|(o, object)| {
                object
                    .instances
                    .iter()
                    .position(|i| &i.id == id)
                    .map(|i| (p, o, i))
            })
        })
        .ok_or_else(|| CommandError::Domain(text_parts("Unknown instance ", id.as_utf16(), "")))
}
fn move_indices<E>(
    state: &ProjectState,
    id: &ObjectId,
    destination: &PlateId,
) -> Result<(usize, usize), CommandError<E>> {
    let p = state
        .plates
        .iter()
        .position(|p| p.objects.iter().any(|o| &o.id == id));
    let d = state.plates.iter().position(|p| &p.id == destination);
    match (p, d) {
        (Some(p), Some(d)) => Ok((p, d)),
        _ => Err(CommandError::domain(
            "Object source or destination plate is missing",
        )),
    }
}
fn plate_at_mut(state: &mut ProjectState, p: usize) -> &mut ProjectPlate {
    Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[p])
}
fn object_at_mut(state: &mut ProjectState, p: usize, o: usize) -> &mut ProjectObject {
    Arc::make_mut(&mut Arc::make_mut(&mut plate_at_mut(state, p).objects)[o])
}
fn remove_object(state: &mut ProjectState, p: usize, o: usize) -> Arc<ProjectObject> {
    let plate = plate_at_mut(state, p);
    let mut objects = plate.objects.to_vec();
    let object = objects.remove(o);
    plate.objects = objects.into();
    object
}
fn insert_object(state: &mut ProjectState, p: usize, o: usize, object: Arc<ProjectObject>) {
    let plate = plate_at_mut(state, p);
    let mut objects = plate.objects.to_vec();
    objects.insert(o.min(objects.len()), object);
    plate.objects = objects.into();
}
fn insert_instance(object: &mut ProjectObject, i: usize, instance: Arc<ProjectInstance>) {
    let mut instances = object.instances.to_vec();
    instances.insert(i.min(instances.len()), instance);
    object.instances = instances.into();
}
fn object_ids(object: &ProjectObject) -> Vec<&[u16]> {
    let mut ids = vec![object.id.as_utf16()];
    ids.extend(object.volumes.iter().map(|v| v.id.as_utf16()));
    ids.extend(object.instances.iter().map(|v| v.id.as_utf16()));
    ids.extend(object.layer_ranges.iter().map(|v| v.id.as_utf16()));
    ids
}
fn object_selection(object: &ProjectObject) -> SelectionRef {
    object
        .instances
        .first()
        .map(|i| SelectionRef::Instance(i.id.clone()))
        .unwrap_or_else(|| SelectionRef::Object(object.id.clone()))
}
fn belongs(r: &SelectionRef, object: &ProjectObject) -> bool {
    match r {
        SelectionRef::Object(id) => id == &object.id,
        SelectionRef::Volume(id) => object.volumes.iter().any(|v| &v.id == id),
        SelectionRef::Instance(id) => object.instances.iter().any(|i| &i.id == id),
        SelectionRef::LayerRange(id) => object.layer_ranges.iter().any(|r| &r.id == id),
        _ => false,
    }
}
fn repair_selection<P: TimestampPolicy>(
    context: &mut CommandContext<'_, P>,
    before: &SelectionSnapshot,
    removed: impl Fn(&SelectionRef) -> bool,
    fallback: SelectionRef,
) -> Result<(), CommandError<P::Error>> {
    let primary_removed = before
        .primary()
        .map(&removed)
        .unwrap_or_else(|| before.refs().iter().any(&removed));
    context.prune_selection();
    if primary_removed {
        let mut refs = context.selection().refs().to_vec();
        if !refs.contains(&fallback) {
            refs.push(fallback.clone());
        }
        context.set_selection(&refs, Some(fallback))?;
    }
    Ok(())
}
