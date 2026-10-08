//! Prepared project commands. The shared decoder bounds untrusted messages before
//! stable-ID/constructor validation; execution belongs to the owned command bus.
//! No UI, callbacks, random IDs or session ownership is inferred here.
mod asset_commands;
mod brim_ears;
mod drawn_parts;
mod duplicate;
mod facet_stroke;
mod filaments;
mod layer_events;
mod layer_heights;
mod layer_ranges;
mod lifecycle;
mod mixed;
mod objects;
mod project_plate;
mod settings_overrides;
mod split_objects;
mod split_parts;
pub mod staged;
mod topology;
mod transforms;
mod volume_roles;
use crate::{
    history::*, ids::*, model::*, selection::SelectionRef, store::DirtyCategory, validation::*,
};
pub use asset_commands::StagedAsset;
pub use drawn_parts::{PartPlacement, Recipe};
use duplicate::*;
pub use facet_stroke::FacetRefinement;
pub use lifecycle::IndependentObjectIds;
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};
pub use split_objects::SeparatedObject;
pub use split_parts::{SplitPart, VolumeSplitGuard};
use std::{collections::BTreeSet, fmt, sync::Arc};
pub use topology::{BooleanGuard, BooleanOp, TopologyGuard};

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
    Filament(Box<filaments::FilamentCommand>),
    RemoveMixed(Box<mixed::RemoveMixed>),
    ProjectSettings(Box<settings_overrides::ProjectSettings>),
    ScopedSettings(Box<settings_overrides::Scoped>),
    VolumeRole(Box<volume_roles::ConvertVolumeRole>),
    FacetStroke(Box<facet_stroke::FacetStroke>),
    RenameProject(Box<project_plate::RenameProject>),
    WipeTower(Box<project_plate::PlateWipeTower>),
    ReconcileAutoPairs(Box<project_plate::ReconcileAutoPairs>),
    SeparateObjectVolumes(Box<split_objects::SeparateObjectVolumes>),
    AddObject(Box<asset_commands::AddObject>),
    AddVolume(Box<asset_commands::AddVolume>),
    ReplaceMesh(Box<topology::ReplaceVolumeMesh>),
    MeshBoolean(Box<topology::MeshBoolean>),
    SplitParts(Box<split_parts::SplitVolumeToParts>),
    AddDrawn(Box<drawn_parts::AddDrawnPart>),
    Recut(Box<drawn_parts::RecutPart>),
    /// `ReplaceProjectCommand`: a whole next state, validated on every apply.
    ReplaceProject {
        next: Arc<ProjectState>,
        previous: Option<ValidatedProject>,
    },
}
/// `ImportProjectCommand`: the project and its asset repository are replaced as
/// one history entry. The first apply crosses the validating payload boundary;
/// redo restores the exact repository version it produced.
#[derive(Clone)]
struct Import {
    next: ImportNext,
    /// Consumed by the first apply.
    source: Option<ImportSource>,
    next_version: Option<crate::assets::AssetSnapshot>,
    previous: Option<(ValidatedProject, crate::assets::AssetSnapshot)>,
    next_bytes: u64,
}
/// A committed preview arrives validated; staged work carries the state and
/// validates it on the first apply, against the assets it installs, as the
/// browser's command does. Redo replays the project that apply produced.
#[derive(Clone)]
enum ImportNext {
    Validated(ValidatedProject),
    State(Arc<ProjectState>),
}
impl ImportNext {
    fn state(&self) -> &ProjectState {
        match self {
            Self::Validated(project) => project.state(),
            Self::State(state) => state,
        }
    }
}
#[derive(Clone)]
enum ImportSource {
    Payloads(Arc<[crate::assets::AssetPayload]>),
    /// Staged records, adopted without another copy.
    Leases(Arc<[crate::assets::AssetLease]>),
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
                next: ImportNext::Validated(next),
                source: Some(ImportSource::Payloads(payloads.into())),
                next_version: None,
                previous: None,
                next_bytes,
            })),
        }
    }
    /// A staged import: the whole next project and every asset it declares,
    /// in the order the repository restores them (`ImportProjectCommand`).
    pub fn import_staged(label: Text, state: ProjectState, assets: &[StagedAsset]) -> Self {
        let leases: Vec<_> = assets.iter().map(|a| a.lease().clone()).collect();
        let next_bytes = leases.iter().map(|l| l.bytes().len() as u64).sum();
        Self {
            label,
            kind: Kind::Import(Box::new(Import {
                next: ImportNext::State(Arc::new(state)),
                source: Some(ImportSource::Leases(leases.into())),
                next_version: None,
                previous: None,
                next_bytes,
            })),
        }
    }
}
/// `assertProjectBundle`: every declared source asset is supplied with
/// identical metadata (the last supply of an ID counts, as in a map), and no
/// supplied asset is undeclared; then no ID is supplied twice. Messages are
/// the browser's.
fn check_import_bundle<E>(
    state: &ProjectState,
    supplied: &[&Value],
) -> Result<(), CommandError<E>> {
    let id = |descriptor: &Value| match descriptor {
        Value::Object(fields) => match fields.get(&"id".encode_utf16().collect::<Vec<_>>()) {
            Some(Value::String(units)) => Some(units.clone()),
            _ => None,
        },
        _ => None,
    };
    let ids: Vec<Option<Vec<u16>>> = supplied.iter().map(|d| id(d)).collect();
    for declared in state.source_assets.iter() {
        let units = declared.id.as_utf16();
        let Some(index) = ids.iter().rposition(|i| i.as_deref() == Some(units)) else {
            return Err(CommandError::Domain(text_parts(
                "Project bundle is missing source asset ",
                units,
                "",
            )));
        };
        if !declared
            .matches_value(supplied[index])
            .map_err(|_| CommandError::Encoding)?
        {
            return Err(CommandError::Domain(text_parts(
                "Project bundle metadata differs for source asset ",
                units,
                "",
            )));
        }
    }
    for units in ids.iter().flatten() {
        if !state
            .source_assets
            .iter()
            .any(|d| d.id.as_utf16() == units.as_slice())
        {
            return Err(CommandError::Domain(text_parts(
                "Project bundle contains undeclared asset ",
                units,
                "",
            )));
        }
    }
    // The repository restore's own first refusal, in its words.
    for (index, units) in ids.iter().enumerate() {
        if let Some(units) = units
            && ids[..index]
                .iter()
                .any(|seen| seen.as_deref() == Some(units.as_slice()))
        {
            return Err(CommandError::Domain(text_parts(
                "Asset snapshot contains duplicate ID ",
                units,
                "",
            )));
        }
    }
    Ok(())
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
/// `commitFacetRefinement`: its checks against the live snapshot refuse
/// without publishing; `None` when the refined result changes nothing.
pub fn prepare_facet_refinement(
    snapshot: &crate::store::ProjectSnapshot,
    request: FacetRefinement,
) -> Result<Option<PreparedCommand>, PreparationError> {
    Ok(request
        .prepare(snapshot)?
        .map(|(stroke, label)| PreparedCommand {
            label,
            kind: Kind::FacetStroke(Box::new(stroke)),
        }))
}
/// `commitPreparedVolumeSplitToObjects` for one single-volume object: its checks
/// against the live `state` (refusing without publishing anything), then the
/// component split and the promotion of its parts as one transaction. The
/// promotion fingerprints its source after the split has committed.
pub fn prepare_split_to_objects(
    state: &ProjectState,
    guard: VolumeSplitGuard,
    parts: Vec<SplitPart>,
    identities: Vec<SeparatedObject>,
) -> Result<PreparedBatch, PreparationError> {
    split_to_objects_checks(state, &guard.volume_id, &checks_of(&parts))?;
    Ok(SplitToObjects::new(guard, parts, identities)?.batch())
}
fn checks_of(parts: &[SplitPart]) -> Vec<(Vec<u16>, usize)> {
    parts
        .iter()
        .map(|part| (part.volume_id.clone(), part.source_triangles.len()))
        .collect()
}
/// The live-state checks `commitPreparedVolumeSplitToObjects` makes before
/// opening its transaction.
fn split_to_objects_checks(
    state: &ProjectState,
    volume: &[u16],
    parts: &[(Vec<u16>, usize)],
) -> Result<(), PreparationError> {
    let source = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .find(|object| object.volumes.iter().any(|v| v.id.as_utf16() == volume));
    let Some(source) = source else {
        return Err(PreparationError::Domain(text_parts(
            "Unknown split-to-objects source volume ",
            volume,
            "",
        )));
    };
    if source.volumes.len() != 1 {
        return Err(PreparationError::Domain(Text::from_utf8(
            "Prepared component split-to-objects requires an object with exactly one volume",
        )));
    }
    if let Some((id, _)) = parts.iter().find(|(_, triangles)| *triangles < 3) {
        return Err(PreparationError::Domain(text_parts(
            "Split-to-objects component for ",
            id,
            " has fewer than three facets; refusing the pinned lossy discard",
        )));
    }
    Ok(())
}
/// A validated single-volume split to objects, waiting for the live state its
/// checks run against (staged work executes it later).
#[derive(Clone)]
pub struct SplitToObjects {
    volume: Vec<u16>,
    checks: Vec<(Vec<u16>, usize)>,
    split: PreparedCommand,
    part: VolumeId,
    identities: Vec<SeparatedObject>,
}
impl SplitToObjects {
    pub fn new(
        guard: VolumeSplitGuard,
        parts: Vec<SplitPart>,
        identities: Vec<SeparatedObject>,
    ) -> Result<Self, PreparationError> {
        let volume = guard.volume_id.clone();
        let checks = checks_of(&parts);
        let first = parts.first().map(|part| part.volume_id.clone());
        let split = PreparedCommand::split_volume_to_parts(guard, parts)?;
        // Construction proved the first part's ID stable.
        let part = id(first.expect("a split has parts")).expect("stable part ID");
        Ok(Self {
            volume,
            checks,
            split,
            part,
            identities,
        })
    }
    /// The checks against `state`, then the transaction to execute.
    pub fn prepare(self, state: &ProjectState) -> Result<PreparedBatch, PreparationError> {
        split_to_objects_checks(state, &self.volume, &self.checks)?;
        Ok(self.batch())
    }
    fn batch(self) -> PreparedBatch {
        let separate =
            split_objects::SeparateObjectVolumes::after_split(self.part, self.identities);
        PreparedBatch {
            label: Text::from_utf8("Split to objects"),
            commands: vec![
                self.split,
                PreparedCommand {
                    label: separate.label(),
                    kind: Kind::SeparateObjectVolumes(Box::new(separate)),
                },
            ],
        }
    }
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
        wire::Command::RenameProject(v) => {
            let command = project_plate::RenameProject::new(v)?;
            (command.label(), Kind::RenameProject(Box::new(command)))
        }
        wire::Command::SetPlateWipeTower(v) => {
            let command = project_plate::PlateWipeTower::new(v)?;
            (command.label(), Kind::WipeTower(Box::new(command)))
        }
        wire::Command::SeparateObjectVolumes(v) => {
            let command = split_objects::SeparateObjectVolumes::new(v)?;
            (
                command.label(),
                Kind::SeparateObjectVolumes(Box::new(command)),
            )
        }
        wire::Command::ReconcileAutoPairs(v) => {
            let command = project_plate::ReconcileAutoPairs::new(v)?;
            (command.label(), Kind::ReconcileAutoPairs(Box::new(command)))
        }
        wire::Command::FacetStroke(v) => {
            let command = facet_stroke::FacetStroke::new(v)?;
            (command.label(), Kind::FacetStroke(Box::new(command)))
        }
        wire::Command::ConvertVolumeRole(v) => {
            let command = volume_roles::ConvertVolumeRole::new(v)?;
            (command.label(), Kind::VolumeRole(Box::new(command)))
        }
        wire::Command::SetProjectSettingsOverrides(v) => (
            Text::from_utf8("Update project setting overrides"),
            Kind::ProjectSettings(Box::new(settings_overrides::ProjectSettings::new(v)?)),
        ),
        wire::Command::SetScopedOverrides(v) => {
            let command = settings_overrides::Scoped::new(v)?;
            (command.label(), Kind::ScopedSettings(Box::new(command)))
        }
        wire::Command::AddMixedFilament(v) => {
            let (op, label) = mixed::MixedOp::add(v)?;
            filament(filaments::FilamentCommand::mixed(op, Some(label)))
        }
        wire::Command::EditMixedFilament(v) => filament(filaments::FilamentCommand::mixed(
            mixed::MixedOp::edit(v)?,
            None,
        )),
        wire::Command::DuplicateMixedFilament(v) => filament(filaments::FilamentCommand::mixed(
            mixed::MixedOp::duplicate(v)?,
            None,
        )),
        wire::Command::SetMixedFilamentEnabled(v) => filament(filaments::FilamentCommand::mixed(
            mixed::MixedOp::enabled(v)?,
            None,
        )),
        wire::Command::TombstoneMixedFilament(v) => filament(filaments::FilamentCommand::mixed(
            mixed::MixedOp::tombstone(v)?,
            None,
        )),
        wire::Command::RemoveMixedFilament(v) => (
            Text::from_utf8("Remove mixed filament"),
            Kind::RemoveMixed(Box::new(mixed::RemoveMixed::new(v)?)),
        ),
        wire::Command::RecreateModelColors(v) => filament(filaments::FilamentCommand::recreate(v)?),
        wire::Command::SetFilamentAssignments(v) => {
            filament(filaments::FilamentCommand::assignments(v)?)
        }
        wire::Command::SetObjectFilament(v) => filament(filaments::FilamentCommand::object(v)?),
        wire::Command::SetVolumeFilament(v) => filament(filaments::FilamentCommand::volume(v)?),
        wire::Command::SetLayerRangeFilament(v) => {
            filament(filaments::FilamentCommand::layer_range(v)?)
        }
        wire::Command::RemapFilaments(v) => filament(filaments::FilamentCommand::remap(v)?),
        wire::Command::SetFilamentEnabled(v) => filament(filaments::FilamentCommand::enabled(v)?),
        wire::Command::SyncPhysicalFilaments(v) => filament(filaments::FilamentCommand::sync(v)?),
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
fn filament(c: filaments::FilamentCommand) -> (Text, Kind) {
    (c.label(), Kind::Filament(Box::new(c)))
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
/// Every entity ID in the project (`collectProjectIds`).
pub(super) fn ids_in_use(state: &ProjectState) -> std::collections::HashSet<&[u16]> {
    let mut ids = std::collections::HashSet::new();
    ids.insert(state.id.as_utf16());
    for plate in state.plates.iter() {
        ids.insert(plate.id.as_utf16());
        for object in plate.objects.iter() {
            ids.insert(object.id.as_utf16());
            ids.extend(object.volumes.iter().map(|v| v.id.as_utf16()));
            ids.extend(object.instances.iter().map(|v| v.id.as_utf16()));
            ids.extend(object.layer_ranges.iter().map(|v| v.id.as_utf16()));
        }
    }
    ids.extend(state.filaments.physical.iter().map(|v| v.id.as_utf16()));
    ids.extend(state.filaments.mixed.iter().map(|v| v.id.as_utf16()));
    ids.extend(state.source_assets.iter().map(|v| v.id.as_utf16()));
    ids.extend(state.custom_gcode.iter().map(|v| v.id.as_utf16()));
    ids.extend(state.thumbnails.iter().map(|v| v.id.as_utf16()));
    ids.extend(state.extension_blobs.iter().map(|v| v.id.as_utf16()));
    ids
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

    /// `AddObjectCommand`: a complete object record appended to a plate.
    pub fn add_object(plate: PlateId, object: Arc<ProjectObject>) -> Self {
        let (command, label) =
            asset_commands::AddObject::new(plate, object, None).expect("no payload to reference");
        Self {
            label,
            kind: Kind::AddObject(Box::new(command)),
        }
    }
    /// `AddObjectWithAssetCommand`: the object must reference the payload.
    pub fn add_object_with_asset(
        plate: PlateId,
        object: Arc<ProjectObject>,
        asset: StagedAsset,
    ) -> Result<Self, PreparationError> {
        let (command, label) = asset_commands::AddObject::new(plate, object, Some(asset))?;
        Ok(Self {
            label,
            kind: Kind::AddObject(Box::new(command)),
        })
    }
    /// `AddVolumeCommand`: a volume record and the payload it references.
    pub fn add_volume(object: ObjectId, volume: Arc<ProjectVolume>, asset: StagedAsset) -> Self {
        let (command, label) = asset_commands::AddVolume::new(object, volume, asset);
        Self {
            label,
            kind: Kind::AddVolume(Box::new(command)),
        }
    }
    /// `ReplaceVolumeMeshCommand`.
    pub fn replace_volume_mesh(
        guard: TopologyGuard,
        replacement: StagedAsset,
    ) -> Result<Self, PreparationError> {
        let command = topology::ReplaceVolumeMesh::new(guard, replacement)?;
        Ok(Self {
            label: Text::from_utf8("Replace mesh topology"),
            kind: Kind::ReplaceMesh(Box::new(command)),
        })
    }
    /// `MeshBooleanCommand`.
    pub fn mesh_boolean(
        guard: BooleanGuard,
        replacement: StagedAsset,
        op: BooleanOp,
    ) -> Result<Self, PreparationError> {
        let (command, label) = topology::MeshBoolean::new(guard, replacement, op)?;
        Ok(Self {
            label,
            kind: Kind::MeshBoolean(Box::new(command)),
        })
    }
    /// `AddSvgPartCommand` (an SVG recipe) or `AddEmbossTextCommand`.
    pub fn add_drawn_part(
        placement: PartPlacement,
        asset: StagedAsset,
        triangles: f64,
        recipe: Recipe,
        name: Option<Text>,
    ) -> Result<Self, PreparationError> {
        let (command, label) =
            drawn_parts::AddDrawnPart::new(placement, asset, triangles, recipe, name)?;
        Ok(Self {
            label,
            kind: Kind::AddDrawn(Box::new(command)),
        })
    }
    /// `EditSvgPartCommand` (an SVG recipe) or `EditEmbossTextCommand`.
    pub fn recut_part(
        volume: VolumeId,
        asset: StagedAsset,
        triangles: f64,
        recipe: Recipe,
    ) -> Result<Self, PreparationError> {
        let (command, label) = drawn_parts::RecutPart::new(volume, asset, triangles, recipe)?;
        Ok(Self {
            label,
            kind: Kind::Recut(Box::new(command)),
        })
    }
    /// `ReplaceProjectCommand`: the whole project becomes `next`.
    pub fn replace_project(next: ProjectState, label: Option<Text>) -> Self {
        Self {
            label: label.unwrap_or_else(|| Text::from_utf8("Replace project")),
            kind: Kind::ReplaceProject {
                next: Arc::new(next),
                previous: None,
            },
        }
    }
    /// `SplitVolumeToPartsCommand`.
    pub fn split_volume_to_parts(
        guard: VolumeSplitGuard,
        parts: Vec<SplitPart>,
    ) -> Result<Self, PreparationError> {
        let command = split_parts::SplitVolumeToParts::new(guard, parts)?;
        Ok(Self {
            label: Text::from_utf8("Split volume to parts"),
            kind: Kind::SplitParts(Box::new(command)),
        })
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
            Kind::Filament(ref c) => c.reason(),
            Kind::RemoveMixed(_) => "remove-mixed-filament",
            Kind::ProjectSettings(_) => "set-project-settings-overrides",
            Kind::ScopedSettings(_) => "set-scoped-overrides",
            Kind::VolumeRole(_) => "convert-volume-role",
            Kind::FacetStroke(_) => "facet-annotation-stroke",
            Kind::RenameProject(_) => "rename-project",
            Kind::WipeTower(_) => "set-plate-wipe-tower",
            Kind::ReconcileAutoPairs(_) => "reconcile-full-spectrum-auto-pairs",
            Kind::SeparateObjectVolumes(_) => "separate-object-volumes",
            Kind::AddObject(ref c) if c.has_asset() => "add-object-with-asset",
            Kind::AddObject(_) => "add-object",
            Kind::AddVolume(_) => "add-volume",
            Kind::ReplaceMesh(_) => "replace-volume-mesh",
            Kind::MeshBoolean(_) => "mesh-boolean",
            Kind::SplitParts(_) => "split-volume-to-parts",
            Kind::ReplaceProject { .. } => "replace-project",
            Kind::AddDrawn(ref c) => c.reason(),
            Kind::Recut(ref c) => c.reason(),
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
    fn is_noop(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        // Snapshot commands build and validate their next state here.
        if let Kind::Filament(c) = &mut self.kind {
            return c.is_noop(context);
        }
        let snapshot = context.snapshot();
        let state = snapshot.state();
        Ok(match &self.kind {
            Kind::Lifecycle(c) => c.is_noop(state)?,
            Kind::Object(c) => c.is_noop(state)?,
            Kind::Transform(c) => c.is_noop(state)?,
            Kind::LayerRange(c) => c.is_noop(state)?,
            Kind::LayerEvent(c) => c.is_noop(state)?,
            Kind::VolumeRole(c) => c.is_noop(state)?,
            Kind::WipeTower(c) => c.is_noop(state)?,
            Kind::ProjectSettings(c) => return c.is_noop(context),
            Kind::FacetStroke(c) => return c.is_noop(context),
            Kind::ReconcileAutoPairs(c) => return c.is_noop(context),
            Kind::ScopedSettings(c) => return c.is_noop(context),
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
            Kind::Filament(c) => c.apply(context, reason)?,
            Kind::RemoveMixed(c) => c.apply(context, reason)?,
            Kind::ProjectSettings(c) => c.apply(context, reason)?,
            Kind::ScopedSettings(c) => c.apply(context, reason)?,
            Kind::VolumeRole(c) => c.apply(context, reason)?,
            Kind::FacetStroke(c) => c.apply(context, reason)?,
            Kind::RenameProject(c) => c.apply(context, reason)?,
            Kind::WipeTower(c) => c.apply(context, reason)?,
            Kind::ReconcileAutoPairs(c) => c.apply(context, reason)?,
            Kind::SeparateObjectVolumes(c) => c.apply(context, reason)?,
            Kind::AddObject(c) => c.apply(context, reason)?,
            Kind::AddVolume(c) => c.apply(context, reason)?,
            Kind::ReplaceMesh(c) => c.apply(context, reason)?,
            Kind::MeshBoolean(c) => c.apply(context, reason)?,
            Kind::SplitParts(c) => c.apply(context, reason)?,
            Kind::AddDrawn(c) => c.apply(context, reason)?,
            Kind::ReplaceProject { next, previous } => {
                *previous = Some(before.project().clone());
                context.replace((**next).clone(), reason, PROJECT)?;
                context.prune_selection();
            }
            Kind::Recut(c) => c.apply(context, reason)?,
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
                        let source = import
                            .source
                            .as_ref()
                            .ok_or_else(|| unapplied("ImportProjectCommand"))?;
                        // The project and its payloads must agree before
                        // anything changes (`assertProjectBundle`).
                        let supplied: Vec<&Value> = match source {
                            ImportSource::Payloads(payloads) => {
                                payloads.iter().map(|p| &p.descriptor).collect()
                            }
                            ImportSource::Leases(leases) => {
                                leases.iter().map(|l| l.descriptor()).collect()
                            }
                        };
                        check_import_bundle(import.next.state(), &supplied)?;
                        match source {
                            ImportSource::Payloads(payloads) => context
                                .assets_mut()
                                .restore(payloads)
                                .map_err(restore_error)?,
                            ImportSource::Leases(leases) => context
                                .assets_mut()
                                .restore_leases(leases)
                                .map_err(restore_error)?,
                        }
                        import.next_version = Some(context.assets().capture_internal());
                        import.source = None;
                    }
                }
                match &import.next {
                    ImportNext::Validated(project) => {
                        context.replace_validated(project.clone(), reason, PROJECT)?
                    }
                    ImportNext::State(state) => {
                        let state = (**state).clone();
                        context.replace(state, reason, PROJECT)?;
                        import.next = ImportNext::Validated(context.snapshot().project().clone());
                    }
                }
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
            Kind::Filament(c) => return c.revert(context, reason),
            Kind::RemoveMixed(c) => return c.revert(context, reason),
            Kind::ProjectSettings(c) => return c.revert(context, reason),
            Kind::ScopedSettings(c) => return c.revert(context, reason),
            Kind::VolumeRole(c) => return c.revert(context, reason),
            Kind::FacetStroke(c) => return c.revert(context, reason),
            Kind::RenameProject(c) => return c.revert(context, reason),
            Kind::WipeTower(c) => return c.revert(context, reason),
            Kind::ReconcileAutoPairs(c) => return c.revert(context, reason),
            Kind::SeparateObjectVolumes(c) => return c.revert(context, reason),
            Kind::AddObject(c) => return c.revert(context, reason),
            Kind::AddVolume(c) => return c.revert(context, reason),
            Kind::ReplaceMesh(c) => return c.revert(context, reason),
            Kind::MeshBoolean(c) => return c.revert(context, reason),
            Kind::SplitParts(c) => return c.revert(context, reason),
            // These browser commands publish `<type>:undo`, not `revert:<type>`.
            Kind::AddDrawn(c) => return c.revert(context),
            Kind::ReplaceProject { previous, .. } => {
                let previous = previous.clone().ok_or_else(|| {
                    CommandError::domain("ReplaceProjectCommand has not been applied")
                })?;
                context.replace_validated(previous, reason, PROJECT)?;
                context.prune_selection();
                return Ok(());
            }
            Kind::Recut(c) => return c.revert(context),
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
            Kind::Filament(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::RemoveMixed(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::ProjectSettings(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::ScopedSettings(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::VolumeRole(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::FacetStroke(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::WipeTower(_) => Ok(128),
            Kind::ReconcileAutoPairs(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::SeparateObjectVolumes(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::AddObject(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::AddVolume(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::ReplaceMesh(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::MeshBoolean(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::SplitParts(c) => c.estimate().map_err(|_| CommandError::Encoding),
            Kind::ReplaceProject { next, previous } => {
                let previous = match previous {
                    Some(p) => canonical_length(p.state()).map_err(|_| CommandError::Encoding)?,
                    None => 0,
                };
                Ok(canonical_length(next.as_ref()).map_err(|_| CommandError::Encoding)? + previous)
            }
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
