//! Prepared project commands. The shared decoder bounds untrusted messages before
//! stable-ID/constructor validation; execution belongs to the owned command bus.
//! No UI, callbacks, random IDs or session ownership is inferred here.
mod brim_ears;
mod duplicate;
mod layer_events;
mod layer_heights;
mod layer_ranges;
mod lifecycle;
mod objects;
pub mod staged;
mod transforms;
use crate::{
    history::*, ids::*, model::*, selection::SelectionRef, store::DirtyCategory, validation::*,
};
use duplicate::*;
pub use lifecycle::IndependentObjectIds;
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};
use std::{collections::BTreeSet, fmt, sync::Arc};

#[derive(Clone)]
pub enum PreparationError {
    InvalidIntent,
    Domain(Text),
}
impl PreparationError {
    pub fn user_message(&self) -> Text {
        match self {
            Self::InvalidIntent => Text::from_utf8("Invalid project command intent"),
            Self::Domain(t) => t.clone(),
        }
    }
}
impl fmt::Debug for PreparationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::InvalidIntent => "InvalidProjectIntent",
            Self::Domain(_) => "CommandPreparationError",
        })
    }
}
impl fmt::Display for PreparationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}
impl std::error::Error for PreparationError {}

#[derive(Clone)]
pub struct PreparedCommand {
    label: Text,
    kind: Kind,
}
#[derive(Clone)]
enum Kind {
    Lifecycle(Box<lifecycle::LifecycleCommand>),
    Object(objects::ObjectCommand),
    Transform(transforms::TransformCommand),
    Add {
        plate: Arc<ProjectPlate>,
        activate: bool,
        previous: Option<PlateId>,
    },
    Duplicate(Box<Duplicate>),
    Delete {
        id: PlateId,
        previous: Option<ValidatedProject>,
    },
    Activate {
        id: PlateId,
        previous: Option<PlateId>,
    },
    Rename {
        id: PlateId,
        name: Text,
        previous: Option<Text>,
    },
    Printable {
        id: PlateId,
        printable: bool,
        previous: Option<bool>,
    },
    Reorder {
        ids: Arc<[PlateId]>,
        previous: Option<Arc<[PlateId]>>,
    },
    Import(Box<Import>),
    LayerRange(Box<layer_ranges::LayerRangeCommand>),
    LayerEvent(Box<layer_events::LayerEventCommand>),
    BrimEar(Box<brim_ears::BrimEarCommand>),
    LayerHeight(Box<layer_heights::LayerHeightCommand>),
}
/// `ImportProjectCommand`: the project and its asset repository are replaced as
/// one history entry. The first apply crosses the validating payload boundary;
/// redo restores the exact repository version it produced.
#[derive(Clone)]
struct Import {
    next: ValidatedProject,
    payloads: Option<Arc<[crate::assets::AssetPayload]>>,
    next_version: Option<crate::assets::AssetSnapshot>,
    previous: Option<(ValidatedProject, crate::assets::AssetSnapshot)>,
    next_bytes: u64,
}
impl PreparedCommand {
    /// A committed import, labelled `Import <filename>` by the caller.
    pub(crate) fn import(
        label: Text,
        next: ValidatedProject,
        payloads: Vec<crate::assets::AssetPayload>,
    ) -> Self {
        let next_bytes = payloads.iter().map(|p| p.bytes.len() as u64).sum();
        Self {
            label,
            kind: Kind::Import(Box::new(Import {
                next,
                payloads: Some(payloads.into()),
                next_version: None,
                previous: None,
                next_bytes,
            })),
        }
    }
}
pub struct PreparedBatch {
    pub label: Text,
    pub commands: Vec<PreparedCommand>,
}
pub fn prepare_intent(json: &str) -> Result<PreparedCommand, PreparationError> {
    let intent = wire::decode_intent(json).map_err(|_| PreparationError::InvalidIntent)?;
    prepare_decoded(intent.command)
}
pub fn prepare_batch(json: &str) -> Result<PreparedBatch, PreparationError> {
    let batch = wire::decode_batch(json).map_err(|_| PreparationError::InvalidIntent)?;
    prepare_decoded_batch(batch)
}
pub(crate) fn prepare_decoded_batch(batch: wire::Batch) -> Result<PreparedBatch, PreparationError> {
    if blank(&batch.label) {
        return Err(PreparationError::InvalidIntent);
    }
    Ok(PreparedBatch {
        label: Text::new(batch.label),
        commands: batch
            .commands
            .into_iter()
            .map(prepare_decoded)
            .collect::<Result<_, _>>()?,
    })
}
fn id<K>(units: Vec<u16>) -> Result<EntityId<K>, PreparationError> {
    EntityId::try_from_utf16(units).map_err(|_| PreparationError::InvalidIntent)
}
fn ids<K>(units: Vec<Vec<u16>>) -> Result<Vec<EntityId<K>>, PreparationError> {
    units.into_iter().map(id).collect()
}
fn blank(units: &[u16]) -> bool {
    units.iter().all(|u| crate::ids::ecmascript_whitespace(*u))
}
fn text_parts(prefix: &str, units: &[u16], suffix: &str) -> Text {
    Text::new(
        prefix
            .encode_utf16()
            .chain(units.iter().copied())
            .chain(suffix.encode_utf16())
            .collect::<Vec<_>>(),
    )
}
pub(crate) fn prepare_decoded(command: wire::Command) -> Result<PreparedCommand, PreparationError> {
    let (label, kind) = match command {
        wire::Command::DeleteObject(v) => {
            lifecycle_command(lifecycle::LifecycleCommand::DeleteObject {
                id: id(v.object_id)?,
                removed: None,
            })
        }
        wire::Command::DeletePlateObjects(v) => {
            lifecycle_command(lifecycle::LifecycleCommand::DeletePlateObjects {
                id: id(v.plate_id)?,
                removed: None,
            })
        }
        wire::Command::DeleteInstance(v) => {
            lifecycle_command(lifecycle::LifecycleCommand::DeleteInstance {
                id: id(v.instance_id)?,
                removed: None,
            })
        }
        wire::Command::MoveObjectToPlate(v) => {
            lifecycle_command(lifecycle::LifecycleCommand::Move {
                id: id(v.object_id)?,
                destination: id(v.destination_plate_id)?,
                previous: None,
            })
        }
        wire::Command::DuplicateObject(v) => {
            lifecycle_command(lifecycle::LifecycleCommand::duplicate(v)?)
        }
        wire::Command::ConvertInstanceToObject(v) => {
            lifecycle_command(lifecycle::LifecycleCommand::convert(v)?)
        }
        wire::Command::AddLayerRange(v) => layer_range(layer_ranges::LayerRangeCommand::add(
            id(v.object_id)?,
            id(v.layer_range_id)?,
            v.min_z_mm,
            v.max_z_mm,
        )?),
        wire::Command::EditLayerRangeBounds(v) => {
            let value = |o: wire::OptionalFinite| match o {
                wire::OptionalFinite::Absent(_) => None,
                wire::OptionalFinite::Value(v) => Some(v),
            };
            layer_range(layer_ranges::LayerRangeCommand::edit(
                id(v.object_id)?,
                id(v.layer_range_id)?,
                value(v.min_z_mm),
                value(v.max_z_mm),
            ))
        }
        wire::Command::SplitLayerRange(v) => layer_range(layer_ranges::LayerRangeCommand::split(
            id(v.object_id)?,
            id(v.layer_range_id)?,
            v.split_z_mm,
            id(v.upper_range_id)?,
        )),
        wire::Command::MergeLayerRanges(v) => layer_range(layer_ranges::LayerRangeCommand::merge(
            id(v.object_id)?,
            id(v.first_range_id)?,
            id(v.second_range_id)?,
        )?),
        wire::Command::DeleteLayerRange(v) => layer_range(layer_ranges::LayerRangeCommand::delete(
            id(v.object_id)?,
            id(v.layer_range_id)?,
        )),
        wire::Command::AdjustLayerHeightProfile(v) => {
            layer_height(layer_heights::LayerHeightCommand::adjust(v)?)
        }
        wire::Command::SmoothLayerHeightProfile(v) => {
            layer_height(layer_heights::LayerHeightCommand::smooth(v)?)
        }
        wire::Command::AdaptiveLayerHeightProfile(v) => {
            layer_height(layer_heights::LayerHeightCommand::adaptive(v)?)
        }
        wire::Command::ResetLayerHeightProfile(v) => {
            layer_height(layer_heights::LayerHeightCommand::reset(v)?)
        }
        wire::Command::AddBrimEar(v) => brim_ear(brim_ears::BrimEarCommand::add(v)?),
        wire::Command::AddBrimEars(v) => brim_ear(brim_ears::BrimEarCommand::add_many(v)?),
        wire::Command::RemoveBrimEar(v) => brim_ear(brim_ears::BrimEarCommand::remove(v)?),
        wire::Command::ClearBrimEars(v) => brim_ear(brim_ears::BrimEarCommand::clear(v)?),
        wire::Command::AddLayerEvent(v) => layer_event(layer_events::LayerEventCommand::add(v)?),
        wire::Command::EditLayerEvent(v) => layer_event(layer_events::LayerEventCommand::edit(v)?),
        wire::Command::DeleteLayerEvent(v) => {
            layer_event(layer_events::LayerEventCommand::delete(v)?)
        }
        wire::Command::RenameObject(v) => object_command(objects::ObjectCommand::rename(
            objects::Target::Object(id(v.object_id)?),
            v.name,
        )?),
        wire::Command::RenameVolume(v) => object_command(objects::ObjectCommand::rename(
            objects::Target::Volume(id(v.volume_id)?),
            v.name,
        )?),
        wire::Command::RenameInstance(v) => object_command(objects::ObjectCommand::rename(
            objects::Target::Instance(id(v.instance_id)?),
            v.name,
        )?),
        wire::Command::SetInstancePrintable(v) => {
            object_command(objects::ObjectCommand::Printable {
                id: id(v.instance_id)?,
                value: v.printable,
                previous: None,
            })
        }
        wire::Command::SetInstanceTransform(v) => {
            transform_command(transforms::TransformCommand::single(v)?)
        }
        wire::Command::SetInstanceTransforms(v) => {
            transform_command(transforms::TransformCommand::batch(v)?)
        }
        wire::Command::AddPlate(v) => {
            let plate = Arc::new(ProjectPlate {
                id: id(v.plate_id)?,
                name: Text::new(v.name),
                order: Number::new(v.order).map_err(|_| PreparationError::InvalidIntent)?,
                printable: true,
                config: JsonObject::from_value(Value::Object(Default::default()))
                    .expect("empty config"),
                objects: Arc::from([]),
                wipe_tower: None,
                extension_data: None,
                extra: ExtraFields::default(),
            });
            (
                text_parts("Add ", plate.name.units(), ""),
                Kind::Add {
                    plate,
                    activate: v.activate,
                    previous: None,
                },
            )
        }
        wire::Command::DuplicatePlate(v) => (
            Text::from_utf8("Duplicate plate"),
            Kind::Duplicate(Box::new(Duplicate::new(v)?)),
        ),
        wire::Command::DeletePlate(v) => (
            Text::from_utf8("Delete plate"),
            Kind::Delete {
                id: id(v.plate_id)?,
                previous: None,
            },
        ),
        wire::Command::ActivatePlate(v) => (
            Text::from_utf8("Change active plate"),
            Kind::Activate {
                id: id(v.plate_id)?,
                previous: None,
            },
        ),
        wire::Command::RenamePlate(v) => {
            let id = id(v.plate_id)?;
            if blank(&v.name) {
                return Err(PreparationError::Domain(Text::from_utf8(
                    "Plate name cannot be empty",
                )));
            }
            (
                text_parts("Rename plate to ", &v.name, ""),
                Kind::Rename {
                    id,
                    name: Text::new(v.name),
                    previous: None,
                },
            )
        }
        wire::Command::SetPlatePrintable(v) => (
            Text::from_utf8(if v.printable {
                "Include plate in printing"
            } else {
                "Exclude plate from printing"
            }),
            Kind::Printable {
                id: id(v.plate_id)?,
                printable: v.printable,
                previous: None,
            },
        ),
        wire::Command::ReorderPlates(v) => {
            let ids: Vec<PlateId> = ids(v.plate_ids)?;
            if ids.iter().collect::<BTreeSet<_>>().len() != ids.len() {
                return Err(PreparationError::Domain(Text::from_utf8(
                    "Plate order cannot contain duplicate IDs",
                )));
            }
            (
                Text::from_utf8("Reorder plates"),
                Kind::Reorder {
                    ids: ids.into(),
                    previous: None,
                },
            )
        }
    };
    Ok(PreparedCommand { label, kind })
}
fn layer_height(c: layer_heights::LayerHeightCommand) -> (Text, Kind) {
    (c.label(), Kind::LayerHeight(Box::new(c)))
}
fn brim_ear(c: brim_ears::BrimEarCommand) -> (Text, Kind) {
    (c.label(), Kind::BrimEar(Box::new(c)))
}
fn layer_event(c: layer_events::LayerEventCommand) -> (Text, Kind) {
    (c.label(), Kind::LayerEvent(Box::new(c)))
}
fn layer_range(c: layer_ranges::LayerRangeCommand) -> (Text, Kind) {
    (c.label(), Kind::LayerRange(Box::new(c)))
}
fn object_command(c: objects::ObjectCommand) -> (Text, Kind) {
    (c.label(), Kind::Object(c))
}
fn lifecycle_command(c: lifecycle::LifecycleCommand) -> (Text, Kind) {
    (c.label(), Kind::Lifecycle(Box::new(c)))
}
fn transform_command(c: transforms::TransformCommand) -> (Text, Kind) {
    (c.label(), Kind::Transform(c))
}
const PROJECT: &[DirtyCategory] = &[DirtyCategory::ProjectData];
/// Validation's first check: a state canonical JSON cannot encode (a
/// non-finite number) is refused as its single issue, before any graph check.
fn non_serializable<E>() -> CommandError<E> {
    CommandError::domain(
        "Invalid project state (1 errors): Canonical JSON cannot contain non-finite numbers at $",
    )
}
/// The plate and object positions of `id`: the first match in plate order, like
/// the browser's object walks.
fn locate_object(state: &ProjectState, id: &ObjectId) -> Option<(usize, usize)> {
    state.plates.iter().enumerate().find_map(|(p, plate)| {
        plate
            .objects
            .iter()
            .position(|o| &o.id == id)
            .map(|o| (p, o))
    })
}
/// Edit one located object, copying only its plate and object lists.
fn update_object(
    state: &mut ProjectState,
    (p, o): (usize, usize),
    edit: impl FnOnce(&mut ProjectObject),
) {
    let mut plates = state.plates.to_vec();
    let mut plate = plates[p].as_ref().clone();
    let mut objects = plate.objects.to_vec();
    let mut object = objects[o].as_ref().clone();
    edit(&mut object);
    objects[o] = Arc::new(object);
    plate.objects = objects.into();
    plates[p] = Arc::new(plate);
    state.plates = plates.into();
}
impl PreparedCommand {
    /// Capture a complete immutable record. The command bus validates the edited
    /// graph on application. This local API is not a generated wire intent;
    /// untrusted record input must use an explicitly budgeted bulk decoder.
    pub fn create_instance(
        object_id: ObjectId,
        instance: Arc<ProjectInstance>,
        insertion_index: Option<Number>,
    ) -> Self {
        let (label, kind) = lifecycle_command(lifecycle::LifecycleCommand::CreateInstance {
            object: object_id,
            instance,
            index: insertion_index,
            applied: false,
        });
        Self { label, kind }
    }

    /// Capture the full clipboard template, retaining shared paint/config data.
    /// Asset bytes are not imported by this command. They and their declarations
    /// must already belong to the destination bundle (or its owning transaction).
    pub fn paste_object(
        template: Arc<ProjectObject>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
        name: Option<Text>,
    ) -> Result<Self, PreparationError> {
        let (label, kind) = lifecycle_command(lifecycle::LifecycleCommand::paste(
            template,
            ids,
            destination,
            name,
            None,
        )?);
        Ok(Self { label, kind })
    }

    pub fn paste_clipboard(
        clipboard: Arc<crate::clipboard::ClipboardData>,
        ids: IndependentObjectIds,
        destination: Option<PlateId>,
    ) -> Result<Self, PreparationError> {
        let (label, kind) = lifecycle_command(lifecycle::LifecycleCommand::paste(
            clipboard.object().clone(),
            ids,
            destination,
            None,
            Some(clipboard),
        )?);
        Ok(Self { label, kind })
    }

    fn reason(&self) -> &'static str {
        match self.kind {
            Kind::Lifecycle(ref c) => c.reason(),
            Kind::Object(ref c) => c.reason(),
            Kind::Transform(ref c) => c.reason(),
            Kind::Add { .. } => "add-plate",
            Kind::Duplicate(_) => "duplicate-plate",
            Kind::Delete { .. } => "delete-plate",
            Kind::Activate { .. } => "set-active-plate",
            Kind::Rename { .. } => "rename-plate",
            Kind::Printable { .. } => "set-plate-printable",
            Kind::Reorder { .. } => "reorder-plates",
            Kind::Import(_) => "import-project",
            Kind::LayerRange(ref c) => c.reason(),
            Kind::LayerEvent(ref c) => c.reason(),
            Kind::BrimEar(ref c) => c.reason(),
            Kind::LayerHeight(ref c) => c.reason(),
        }
    }
}
impl<P: TimestampPolicy> ProjectCommand<P> for PreparedCommand {
    fn label(&self) -> &Text {
        &self.label
    }
    fn dirty_categories(&self) -> &[DirtyCategory] {
        PROJECT
    }
    fn is_noop(&self, context: &CommandContext<'_, P>) -> Result<bool, CommandError<P::Error>> {
        let snapshot = context.snapshot();
        let state = snapshot.state();
        Ok(match &self.kind {
            Kind::Lifecycle(c) => c.is_noop(state)?,
            Kind::Object(c) => c.is_noop(state)?,
            Kind::Transform(c) => c.is_noop(state)?,
            Kind::LayerRange(c) => c.is_noop(state)?,
            Kind::LayerEvent(c) => c.is_noop(state)?,
            Kind::Activate { id, .. } => &state.active_plate_id == id,
            Kind::Rename { id, name, .. } => &plate(state, id)?.name == name,
            Kind::Printable { id, printable, .. } => plate(state, id)?.printable == *printable,
            Kind::Reorder { ids, .. } => {
                permutation(state, ids)?;
                ordered(state).iter().map(|p| &p.id).eq(ids.iter())
            }
            _ => false,
        })
    }
    fn apply(&mut self, context: &mut CommandContext<'_, P>) -> Result<(), CommandError<P::Error>> {
        let reason = Text::from_utf8(self.reason());
        let before = context.snapshot();
        let mut state = before.state().clone();
        match &mut self.kind {
            Kind::Lifecycle(c) => c.apply(context, reason)?,
            Kind::Object(c) => {
                c.apply(&mut state)?;
                context.replace(state, reason, PROJECT)?;
            }
            Kind::Transform(c) => c.apply(context, reason)?,
            Kind::LayerRange(c) => c.apply(context, reason)?,
            Kind::LayerEvent(c) => c.apply(context, reason)?,
            Kind::BrimEar(c) => c.apply(context)?,
            Kind::LayerHeight(c) => c.apply(context)?,
            Kind::Add {
                plate,
                activate,
                previous,
            } => {
                capacity(&state)?;
                if state.plates.iter().any(|p| p.id == plate.id) {
                    return Err(CommandError::Domain(text_parts(
                        "Plate ",
                        plate.id.as_utf16(),
                        " already exists",
                    )));
                }
                *previous = Some(state.active_plate_id.clone());
                let mut plates = state.plates.to_vec();
                plates.push(plate.clone());
                sort(&mut plates);
                state.plates = plates.into();
                if *activate {
                    state.active_plate_id = plate.id.clone();
                }
                context.replace(state, reason, PROJECT)?;
                if *activate {
                    select(context, &plate.id)?;
                }
            }
            Kind::Duplicate(command) => command.apply(context, reason)?,
            Kind::Delete { id, previous } => {
                if state.plates.len() <= 1 {
                    return Err(CommandError::domain("Cannot delete the last plate"));
                }
                let mut plates = ordered(&state);
                let index = plates
                    .iter()
                    .position(|p| &p.id == id)
                    .ok_or_else(|| unknown(id))?;
                *previous = Some(before.project().clone());
                plates.remove(index);
                renumber(&mut plates);
                if &state.active_plate_id == id {
                    state.active_plate_id = plates[index.min(plates.len() - 1)].id.clone();
                }
                state.plates = plates.into();
                state.custom_gcode = state
                    .custom_gcode
                    .iter()
                    .filter(|v| v.plate_id.as_ref() != Some(id))
                    .cloned()
                    .collect();
                state.thumbnails = state
                    .thumbnails
                    .iter()
                    .filter(|v| v.plate_id.as_ref() != Some(id))
                    .cloned()
                    .collect();
                let active = state.active_plate_id.clone();
                context.replace(state, reason, PROJECT)?;
                context.prune_selection();
                if context.selection().refs().is_empty() {
                    select(context, &active)?;
                }
            }
            Kind::Activate { id, previous } => {
                plate(&state, id)?;
                *previous = Some(state.active_plate_id.clone());
                state.active_plate_id = id.clone();
                context.replace(state, reason, PROJECT)?;
                select(context, id)?;
            }
            Kind::Rename { id, name, previous } => {
                let plate = plate_mut(&mut state, id)?;
                *previous = Some(plate.name.clone());
                plate.name = name.clone();
                context.replace(state, reason, PROJECT)?;
            }
            Kind::Printable {
                id,
                printable,
                previous,
            } => {
                let plate = plate_mut(&mut state, id)?;
                *previous = Some(plate.printable);
                plate.printable = *printable;
                context.replace(state, reason, PROJECT)?;
            }
            Kind::Reorder { ids, previous } => {
                permutation(&state, ids)?;
                *previous = Some(ordered(&state).iter().map(|p| p.id.clone()).collect());
                reorder(&mut state, ids)?;
                context.replace(state, reason, PROJECT)?;
            }
            Kind::Import(import) => {
                let restore_error =
                    |e: crate::assets::AssetError| CommandError::domain(e.to_string());
                import.previous = Some((
                    before.project().clone(),
                    context.assets().capture_internal(),
                ));
                match &import.next_version {
                    Some(version) => context
                        .assets_mut()
                        .restore_internal(version)
                        .map_err(restore_error)?,
                    None => {
                        let payloads = import
                            .payloads
                            .as_deref()
                            .ok_or_else(|| unapplied("ImportProjectCommand"))?;
                        context
                            .assets_mut()
                            .restore(payloads)
                            .map_err(restore_error)?;
                        import.next_version = Some(context.assets().capture_internal());
                        import.payloads = None;
                    }
                }
                context.replace_validated(import.next.clone(), reason, PROJECT)?;
                context.clear_selection();
            }
        }
        Ok(())
    }
    fn revert(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let reason = Text::from_utf8(&format!("revert:{}", self.reason()));
        let mut state = context.snapshot().state().clone();
        match &self.kind {
            Kind::Lifecycle(c) => return c.revert(context, reason),
            Kind::LayerEvent(c) => return c.revert(context, reason),
            Kind::BrimEar(c) => return c.revert(context),
            Kind::LayerHeight(c) => return c.revert(context),
            Kind::LayerRange(_) => {
                let Kind::LayerRange(c) = &mut self.kind else {
                    unreachable!()
                };
                return c.revert(context, reason);
            }
            Kind::Object(c) => c.revert(&mut state)?,
            Kind::Transform(c) => c.revert(&mut state)?,
            Kind::Add {
                plate, previous, ..
            } => {
                state.active_plate_id = previous
                    .clone()
                    .ok_or_else(|| unapplied("AddPlateCommand"))?;
                state.plates = state
                    .plates
                    .iter()
                    .filter(|p| p.id != plate.id)
                    .cloned()
                    .collect();
            }
            Kind::Duplicate(command) => return command.revert(context, reason),
            Kind::Delete { previous, .. } => {
                context.replace_validated(
                    previous
                        .clone()
                        .ok_or_else(|| unapplied("DeletePlateCommand"))?,
                    reason,
                    PROJECT,
                )?;
                context.prune_selection();
                return Ok(());
            }
            Kind::Activate { previous, .. } => {
                state.active_plate_id = previous
                    .clone()
                    .ok_or_else(|| unapplied("SetActivePlateCommand"))?
            }
            Kind::Rename { id, previous, .. } => {
                let name = previous
                    .clone()
                    .ok_or_else(|| unapplied("RenamePlateCommand"))?;
                plate_mut(&mut state, id)?.name = name;
            }
            Kind::Printable { id, previous, .. } => {
                let printable = previous.ok_or_else(|| unapplied("SetPlatePrintableCommand"))?;
                plate_mut(&mut state, id)?.printable = printable;
            }
            Kind::Reorder { previous, .. } => reorder(
                &mut state,
                previous
                    .as_ref()
                    .ok_or_else(|| unapplied("ReorderPlatesCommand"))?,
            )?,
            Kind::Import(import) => {
                let (project, assets) = import
                    .previous
                    .clone()
                    .ok_or_else(|| unapplied("ImportProjectCommand"))?;
                context
                    .assets_mut()
                    .restore_internal(&assets)
                    .map_err(|e| CommandError::domain(e.to_string()))?;
                return context.replace_validated(project, reason, PROJECT);
            }
        }
        context.replace(state, reason, PROJECT)
    }
    fn estimate_bytes(&self) -> Result<u64, CommandError<P::Error>> {
        match &self.kind {
            Kind::Lifecycle(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::Transform(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::Duplicate(command) => command.estimate().map_err(|_| CommandError::Encoding),
            Kind::LayerRange(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::LayerEvent(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::Delete {
                previous: Some(p), ..
            } => canonical_length(p.state()).map_err(|_| CommandError::Encoding),
            // Canonical state units plus new payload bytes plus the previous
            // project's declared asset bytes, like the browser's estimate.
            Kind::Import(import) => {
                let state =
                    canonical_length(import.next.state()).map_err(|_| CommandError::Encoding)?;
                let previous: u64 = import.previous.as_ref().map_or(0, |(p, _)| {
                    p.state()
                        .source_assets
                        .iter()
                        .map(|a| a.byte_length.get() as u64)
                        .sum()
                });
                Ok((state + import.next_bytes + previous).max(1))
            }
            _ => Ok(1),
        }
    }
    fn coalesce_key(&self) -> Option<&Text> {
        match &self.kind {
            Kind::Transform(c) => Some(c.key()),
            _ => None,
        }
    }
    fn merge_with(&self, next: &Self) -> Result<Option<Self>, CommandError<P::Error>> {
        Ok(match (&self.kind, &next.kind) {
            (Kind::Transform(a), Kind::Transform(b)) => a.merge(b).map(|c| Self {
                label: c.label(),
                kind: Kind::Transform(c),
            }),
            _ => None,
        })
    }
}
fn unapplied<E>(name: &str) -> CommandError<E> {
    CommandError::domain(format!("{name} has not been applied"))
}
fn unknown<E>(id: &PlateId) -> CommandError<E> {
    CommandError::Domain(text_parts("Unknown plate ", id.as_utf16(), ""))
}
fn plate<'a, E>(
    state: &'a ProjectState,
    id: &PlateId,
) -> Result<&'a ProjectPlate, CommandError<E>> {
    find_plate(state, id).ok_or_else(|| unknown(id))
}
fn plate_mut<'a, E>(
    state: &'a mut ProjectState,
    id: &PlateId,
) -> Result<&'a mut ProjectPlate, CommandError<E>> {
    let index = state
        .plates
        .iter()
        .position(|p| &p.id == id)
        .ok_or_else(|| unknown(id))?;
    Ok(Arc::make_mut(&mut Arc::make_mut(&mut state.plates)[index]))
}
fn capacity<E>(state: &ProjectState) -> Result<(), CommandError<E>> {
    if state.plates.len() >= 36 {
        Err(CommandError::domain(
            "A project cannot contain more than 36 plates",
        ))
    } else {
        Ok(())
    }
}
fn sort(plates: &mut [Arc<ProjectPlate>]) {
    plates.sort_by(|a, b| {
        a.order
            .get()
            .partial_cmp(&b.order.get())
            .expect("finite orders")
    });
}
fn ordered(state: &ProjectState) -> Vec<Arc<ProjectPlate>> {
    let mut plates = state.plates.to_vec();
    sort(&mut plates);
    plates
}
fn renumber(plates: &mut [Arc<ProjectPlate>]) {
    for (index, plate) in plates.iter_mut().enumerate() {
        let order = Number::new(index as f64).expect("bounded plate index");
        if plate.order != order {
            Arc::make_mut(plate).order = order;
        }
    }
}
fn permutation<E>(state: &ProjectState, ids: &[PlateId]) -> Result<(), CommandError<E>> {
    if ids.len() != state.plates.len() || ids.iter().any(|id| find_plate(state, id).is_none()) {
        Err(CommandError::domain(
            "Plate order must contain every project plate exactly once",
        ))
    } else {
        Ok(())
    }
}
fn reorder<E>(state: &mut ProjectState, ids: &[PlateId]) -> Result<(), CommandError<E>> {
    permutation(state, ids)?;
    let mut plates = ids
        .iter()
        .map(|id| {
            state
                .plates
                .iter()
                .find(|p| &p.id == id)
                .expect("permutation checked")
                .clone()
        })
        .collect::<Vec<_>>();
    renumber(&mut plates);
    state.plates = plates.into();
    Ok(())
}
fn select<P: TimestampPolicy>(
    context: &mut CommandContext<'_, P>,
    id: &PlateId,
) -> Result<(), CommandError<P::Error>> {
    context.set_selection(&[SelectionRef::Plate(id.clone())], None)
}
