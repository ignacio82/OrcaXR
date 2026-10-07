//! Filament assignment, remap, enablement and printer sync
//! (`filaments/commands.ts`). These are whole-state snapshot commands: each
//! builds and graph-validates its next state for the no-op check and again on
//! apply, and undo restores the exact previous state. The browser's checks,
//! messages and JavaScript object semantics (spread, truthiness, `trim`) are
//! reproduced; printer sync draws each adopted tool's ID once, so apply and
//! redo agree.
use super::*;
use crate::facets::{Channel, FacetChannel, PaintValue, ValidationOptions};
use std::collections::{BTreeMap, HashMap};

#[derive(Clone)]
pub(super) enum Target {
    Object(ObjectId),
    Volume(ObjectId, VolumeId),
    LayerRange(ObjectId, LayerRangeId),
}
#[derive(Clone)]
pub(super) struct Assignment {
    target: Target,
    filament: Option<FilamentId>,
}
#[derive(Clone)]
pub(super) struct Slot {
    tool: u64,
    color: Vec<u16>,
    material: Vec<u16>,
    sub_type: Option<Vec<u16>>,
    vendor: Option<Vec<u16>>,
}
#[derive(Clone)]
pub(super) enum Op {
    Assign {
        assignments: Vec<Assignment>,
        reason: &'static str,
        class: &'static str,
    },
    Remap {
        sources: Vec<FilamentId>,
        destination: FilamentId,
    },
    Enabled {
        filament: FilamentId,
        enabled: bool,
        reason: Vec<u16>,
    },
    Sync {
        slots: Vec<Slot>,
        ids: Option<Vec<PhysicalFilamentId>>,
        consumed: usize,
        adopted: Vec<(u64, PhysicalFilamentId)>,
    },
    Mixed(super::mixed::MixedOp),
}
#[derive(Clone)]
pub(super) struct FilamentCommand {
    op: Op,
    label: Text,
    previous: Option<ValidatedProject>,
    next: Option<ValidatedProject>,
}

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn concat(parts: &[&[u16]]) -> Text {
    Text::new(parts.concat())
}
fn domain<E>(parts: &[&[u16]]) -> CommandError<E> {
    CommandError::Domain(concat(parts))
}
fn optional_filament(value: wire::OptionalId) -> Result<Option<FilamentId>, PreparationError> {
    match value {
        wire::OptionalId::Absent(_) => Ok(None),
        wire::OptionalId::Value(units) => id(units).map(Some),
    }
}
fn optional_text(value: wire::OptionalText) -> Option<Vec<u16>> {
    match value {
        wire::OptionalText::Absent(_) => None,
        wire::OptionalText::Value(units) => Some(units),
    }
}
/// `String.prototype.trim`.
fn trim(units: &[u16]) -> &[u16] {
    let start = units
        .iter()
        .position(|u| !crate::ids::ecmascript_whitespace(*u))
        .unwrap_or(units.len());
    let end = units
        .iter()
        .rposition(|u| !crate::ids::ecmascript_whitespace(*u))
        .map_or(start, |i| i + 1);
    &units[start..end.max(start)]
}
/// JavaScript truthiness of a JSON value (`undefined` is `None`).
fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => *n != 0.0 && !n.is_nan(),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}
/// `{ ...value }` of a JSON value: own keys of an object, indices of an array
/// or of a string's UTF-16 code units, and nothing for scalars.
fn spread(value: Option<&Value>) -> BTreeMap<Vec<u16>, Value> {
    let index = |i: usize| u(&i.to_string());
    match value {
        Some(Value::Object(fields)) => fields.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .enumerate()
            .map(|(i, v)| (index(i), v.clone()))
            .collect(),
        Some(Value::String(units)) => units
            .iter()
            .enumerate()
            .map(|(i, unit)| (index(i), Value::String(vec![*unit])))
            .collect(),
        _ => BTreeMap::new(),
    }
}
fn fields(object: &Option<JsonObject>) -> BTreeMap<Vec<u16>, Value> {
    match object.as_ref().map(JsonObject::value) {
        Some(Value::Object(fields)) => fields.clone(),
        _ => BTreeMap::new(),
    }
}
fn json_object<E>(fields: BTreeMap<Vec<u16>, Value>) -> Result<JsonObject, CommandError<E>> {
    JsonObject::new(Value::Object(fields)).map_err(|_| non_serializable())
}
fn number<E>(value: f64) -> Result<Number, CommandError<E>> {
    Number::new(value).map_err(|_| non_serializable())
}
/// `#RRGGBB`, exactly (`/^#[0-9a-fA-F]{6}$/`).
fn hex_colour(units: &[u16]) -> bool {
    units.len() == 7
        && units[0] == u16::from(b'#')
        && units[1..]
            .iter()
            .all(|u| char::from_u32(u32::from(*u)).is_some_and(|c| c.is_ascii_hexdigit()))
}

enum Found {
    Physical(usize),
    Mixed(usize),
}
/// `requireFilament`: physical definitions first, then mixed.
fn require<E>(state: &ProjectState, id: &[u16]) -> Result<(Found, bool), CommandError<E>> {
    if let Some(i) = state
        .filaments
        .physical
        .iter()
        .position(|f| f.id.as_utf16() == id)
    {
        return Ok((Found::Physical(i), state.filaments.physical[i].enabled));
    }
    if let Some(i) = state
        .filaments
        .mixed
        .iter()
        .position(|f| f.id.as_utf16() == id)
    {
        return Ok((Found::Mixed(i), state.filaments.mixed[i].enabled));
    }
    Err(domain(&[&u("Unknown filament "), id]))
}
fn require_enabled<E>(state: &ProjectState, id: &[u16]) -> Result<(), CommandError<E>> {
    if !require(state, id)?.1 {
        return Err(domain(&[
            &u("Destination filament "),
            id,
            &u(" is disabled"),
        ]));
    }
    Ok(())
}
/// `findVolume` / `findLayerRange`: the first match in plate order.
fn find_volume(state: &ProjectState, id: &VolumeId) -> Option<(usize, usize, usize)> {
    state.plates.iter().enumerate().find_map(|(p, plate)| {
        plate.objects.iter().enumerate().find_map(|(o, object)| {
            object
                .volumes
                .iter()
                .position(|v| &v.id == id)
                .map(|v| (p, o, v))
        })
    })
}
fn find_range(state: &ProjectState, id: &LayerRangeId) -> Option<(usize, usize, usize)> {
    state.plates.iter().enumerate().find_map(|(p, plate)| {
        plate.objects.iter().enumerate().find_map(|(o, object)| {
            object
                .layer_ranges
                .iter()
                .position(|r| &r.id == id)
                .map(|r| (p, o, r))
        })
    })
}
fn edit_volume(object: &mut ProjectObject, v: usize, edit: impl FnOnce(&mut ProjectVolume)) {
    let mut volumes = object.volumes.to_vec();
    edit(Arc::make_mut(&mut volumes[v]));
    object.volumes = volumes.into();
}
fn edit_range(object: &mut ProjectObject, r: usize, edit: impl FnOnce(&mut LayerRange)) {
    let mut ranges = object.layer_ranges.to_vec();
    edit(Arc::make_mut(&mut ranges[r]));
    object.layer_ranges = ranges.into();
}
/// Every object of every plate, edited in place through copy-on-write lists.
fn each_object<E>(
    state: &mut ProjectState,
    mut edit: impl FnMut(&mut ProjectObject) -> Result<(), CommandError<E>>,
) -> Result<(), CommandError<E>> {
    let mut plates = state.plates.to_vec();
    for plate in plates.iter_mut() {
        let plate = Arc::make_mut(plate);
        let mut objects = plate.objects.to_vec();
        for object in objects.iter_mut() {
            edit(Arc::make_mut(object))?;
        }
        plate.objects = objects.into();
    }
    state.plates = plates.into();
    Ok(())
}

impl FilamentCommand {
    fn new(op: Op, label: Text) -> Self {
        Self {
            op,
            label,
            previous: None,
            next: None,
        }
    }
    fn assign(
        assignments: Vec<Assignment>,
        reason: &'static str,
        class: &'static str,
        label: Text,
    ) -> Result<Self, PreparationError> {
        // `assignmentTargetKey`, compared as the browser's strings.
        let key = |a: &Assignment| -> Vec<u16> {
            match &a.target {
                Target::Object(o) => [&u("object:")[..], o.as_utf16()].concat(),
                Target::Volume(o, v) => {
                    [&u("volume:")[..], o.as_utf16(), &u(":"), v.as_utf16()].concat()
                }
                Target::LayerRange(o, r) => {
                    [&u("layer-range:")[..], o.as_utf16(), &u(":"), r.as_utf16()].concat()
                }
            }
        };
        let keys: Vec<Vec<u16>> = assignments.iter().map(key).collect();
        if keys.iter().collect::<std::collections::BTreeSet<_>>().len() != keys.len() {
            return Err(PreparationError::Domain(Text::from_utf8(
                "Batch contains duplicate filament assignment targets",
            )));
        }
        Ok(Self::new(
            Op::Assign {
                assignments,
                reason,
                class,
            },
            label,
        ))
    }
    pub(super) fn assignments(v: wire::SetFilamentAssignments) -> Result<Self, PreparationError> {
        let assignments = v
            .assignments
            .into_iter()
            .map(|a| {
                let target = match a.target {
                    wire::AssignmentTarget::Object(t) => Target::Object(id(t.object_id)?),
                    wire::AssignmentTarget::Volume(t) => {
                        Target::Volume(id(t.object_id)?, id(t.volume_id)?)
                    }
                    wire::AssignmentTarget::LayerRange(t) => {
                        Target::LayerRange(id(t.object_id)?, id(t.layer_range_id)?)
                    }
                };
                Ok(Assignment {
                    target,
                    filament: optional_filament(a.filament_id)?,
                })
            })
            .collect::<Result<Vec<_>, PreparationError>>()?;
        let label = if assignments.len() == 1 {
            Text::from_utf8("Assign filament")
        } else {
            Text::from_utf8(&format!("Assign {} scopes", assignments.len()))
        };
        Self::assign(
            assignments,
            "set-filament-assignments",
            "SetFilamentAssignmentsCommand",
            label,
        )
    }
    pub(super) fn object(v: wire::SetObjectFilament) -> Result<Self, PreparationError> {
        let filament = optional_filament(v.filament_id)?;
        let label = if filament.is_some() {
            "Assign object filament"
        } else {
            "Clear object filament"
        };
        let target = Target::Object(id(v.object_id)?);
        Self::assign(
            vec![Assignment { target, filament }],
            "set-object-filament",
            "SetObjectFilamentCommand",
            Text::from_utf8(label),
        )
    }
    pub(super) fn volume(v: wire::SetVolumeFilament) -> Result<Self, PreparationError> {
        let target = Target::Volume(id(v.object_id)?, id(v.volume_id)?);
        let filament = optional_filament(v.filament_id)?;
        let label = if filament.is_some() {
            "Assign volume filament"
        } else {
            "Inherit object filament"
        };
        Self::assign(
            vec![Assignment { target, filament }],
            "set-volume-filament",
            "SetVolumeFilamentCommand",
            Text::from_utf8(label),
        )
    }
    pub(super) fn layer_range(v: wire::SetLayerRangeFilament) -> Result<Self, PreparationError> {
        let target = Target::LayerRange(id(v.object_id)?, id(v.layer_range_id)?);
        let filament = optional_filament(v.filament_id)?;
        let label = if filament.is_some() {
            "Assign layer-range filament"
        } else {
            "Inherit object filament"
        };
        Self::assign(
            vec![Assignment { target, filament }],
            "set-layer-range-filament",
            "SetLayerRangeFilamentCommand",
            Text::from_utf8(label),
        )
    }
    pub(super) fn remap(v: wire::RemapFilaments) -> Result<Self, PreparationError> {
        let sources: Vec<FilamentId> = ids(v.source_ids)?;
        let destination: FilamentId = id(v.destination_id)?;
        let refuse = |m: &str| Err(PreparationError::Domain(Text::from_utf8(m)));
        if sources.is_empty() {
            return refuse("Filament remap requires at least one source");
        }
        if sources
            .iter()
            .collect::<std::collections::BTreeSet<_>>()
            .len()
            != sources.len()
        {
            return refuse("Filament remap sources must be unique");
        }
        if sources.contains(&destination) {
            return refuse("Filament remap cannot map a source to itself");
        }
        let label = if sources.len() == 1 {
            Text::from_utf8("Remap filament")
        } else {
            Text::from_utf8(&format!("Remap {} filaments", sources.len()))
        };
        Ok(Self::new(
            Op::Remap {
                sources,
                destination,
            },
            label,
        ))
    }
    pub(super) fn enabled(v: wire::SetFilamentEnabled) -> Result<Self, PreparationError> {
        let label = if v.enabled {
            "Enable filament"
        } else {
            "Disable filament"
        };
        Ok(Self::new(
            Op::Enabled {
                filament: id(v.filament_id)?,
                enabled: v.enabled,
                reason: optional_text(v.reason).unwrap_or_else(|| u("user")),
            },
            Text::from_utf8(label),
        ))
    }
    pub(super) fn sync(v: wire::SyncPhysicalFilaments) -> Result<Self, PreparationError> {
        let ids = match v.new_filament_ids {
            wire::OptionalIds::Absent(_) => None,
            wire::OptionalIds::Value(list) => Some(ids(list)?),
        };
        let mut slots = Vec::with_capacity(v.slots.len());
        for slot in v.slots {
            let ordinal = u(&(slot.tool_id + 1).to_string());
            if !hex_colour(&slot.color) {
                return Err(PreparationError::Domain(concat(&[
                    &u("Printer slot "),
                    &ordinal,
                    &u(" reported an unusable colour "),
                    &slot.color,
                ])));
            }
            if trim(&slot.material).is_empty() {
                return Err(PreparationError::Domain(concat(&[
                    &u("Printer slot "),
                    &ordinal,
                    &u(" reported no material"),
                ])));
            }
            slots.push(Slot {
                tool: slot.tool_id,
                color: slot.color,
                material: slot.material,
                sub_type: optional_text(slot.sub_type),
                vendor: optional_text(slot.vendor),
            });
        }
        Ok(Self::new(
            Op::Sync {
                slots,
                ids,
                consumed: 0,
                adopted: Vec::new(),
            },
            Text::from_utf8("Sync filaments from printer"),
        ))
    }
    /// A mixed-filament recipe command (`mixedCommands.ts`).
    pub(super) fn mixed(op: super::mixed::MixedOp, add_label: Option<Text>) -> Self {
        let label = op
            .label()
            .or(add_label)
            .expect("an add carries its own label");
        Self::new(Op::Mixed(op), label)
    }
    pub(super) fn label(&self) -> Text {
        self.label.clone()
    }
    pub(super) fn reason(&self) -> &'static str {
        match &self.op {
            Op::Assign { reason, .. } => reason,
            Op::Remap { .. } => "remap-filaments",
            Op::Enabled { .. } => "set-filament-enabled",
            Op::Sync { .. } => "sync-physical-filaments-from-printer",
            Op::Mixed(op) => op.reason(),
        }
    }
    fn class(&self) -> &'static str {
        match &self.op {
            Op::Assign { class, .. } => class,
            Op::Remap { .. } => "RemapFilamentsCommand",
            Op::Enabled { .. } => "SetFilamentEnabledCommand",
            Op::Sync { .. } => "SyncPhysicalFilamentsFromPrinterCommand",
            Op::Mixed(op) => op.class(),
        }
    }

    fn mutate<E>(&mut self, state: &mut ProjectState) -> Result<(), CommandError<E>> {
        match &mut self.op {
            Op::Assign { assignments, .. } => assign(state, assignments),
            Op::Remap {
                sources,
                destination,
            } => remap(state, sources, destination),
            Op::Enabled {
                filament,
                enabled,
                reason,
            } => set_enabled(state, filament, *enabled, reason),
            Op::Sync {
                slots,
                ids,
                consumed,
                adopted,
            } => sync(state, slots, ids.as_deref(), consumed, adopted),
            Op::Mixed(op) => op.mutate(state),
        }
    }
    /// `buildNext`: mutate a copy and validate it like `assertValidProjectState`.
    fn build_next<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<ValidatedProject, CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        self.mutate(&mut state)?;
        context.admit(state)
    }
    pub(super) fn is_noop<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        let current = context.snapshot();
        let next = self.build_next(context)?;
        Ok(next.state() == current.state())
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let current = context.snapshot();
        let next = self.build_next(context)?;
        self.previous = Some(current.project().clone());
        self.next = Some(next.clone());
        context.replace_validated(next, reason, PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self
            .previous
            .clone()
            .ok_or_else(|| unapplied(self.class()))?;
        context.replace_validated(previous, reason, PROJECT)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        let previous = match &self.previous {
            Some(p) => duplicate::canonical_length(p.state())?,
            None => 0,
        };
        let next = match &self.next {
            Some(n) => duplicate::canonical_length(n.state())?,
            None => 1,
        };
        Ok(previous + next)
    }
}

fn assign<E>(state: &mut ProjectState, assignments: &[Assignment]) -> Result<(), CommandError<E>> {
    let mut destinations: Vec<&FilamentId> = Vec::new();
    for filament in assignments.iter().filter_map(|a| a.filament.as_ref()) {
        if !destinations.contains(&filament) {
            destinations.push(filament);
        }
    }
    for filament in destinations {
        require_enabled(state, filament.as_utf16())?;
    }
    for assignment in assignments {
        let filament = assignment.filament.clone();
        match &assignment.target {
            Target::Object(object_id) => {
                let at = locate_object(state, object_id)
                    .ok_or_else(|| domain(&[&u("Unknown object "), object_id.as_utf16()]))?;
                update_object(state, at, |object| object.filament_id = filament);
            }
            Target::Volume(object_id, volume_id) => {
                let (p, o, v) = find_volume(state, volume_id)
                    .ok_or_else(|| domain(&[&u("Unknown volume "), volume_id.as_utf16()]))?;
                if &state.plates[p].objects[o].id != object_id {
                    return Err(domain(&[
                        &u("Volume "),
                        volume_id.as_utf16(),
                        &u(" is not owned by object "),
                        object_id.as_utf16(),
                    ]));
                }
                update_object(state, (p, o), |object| {
                    edit_volume(object, v, |volume| volume.filament_id = filament)
                });
            }
            Target::LayerRange(object_id, range_id) => {
                let (p, o, r) = find_range(state, range_id)
                    .ok_or_else(|| domain(&[&u("Unknown layer range "), range_id.as_utf16()]))?;
                if &state.plates[p].objects[o].id != object_id {
                    return Err(domain(&[
                        &u("Layer range "),
                        range_id.as_utf16(),
                        &u(" is not owned by object "),
                        object_id.as_utf16(),
                    ]));
                }
                update_object(state, (p, o), |object| {
                    edit_range(object, r, |range| range.filament_id = filament)
                });
            }
        }
    }
    Ok(())
}

fn remap<E>(
    state: &mut ProjectState,
    sources: &[FilamentId],
    destination: &FilamentId,
) -> Result<(), CommandError<E>> {
    require_enabled(state, destination.as_utf16())?;
    for source in sources {
        require(state, source.as_utf16())?;
    }
    let is_source = |id: &[u16]| sources.iter().any(|s| s.as_utf16() == id);
    let destination_is_physical = state
        .filaments
        .physical
        .iter()
        .any(|f| f.id.as_utf16() == destination.as_utf16());
    let remaps_recipe_component = state.filaments.mixed.iter().any(|f| {
        f.components
            .iter()
            .any(|c| is_source(c.filament_id.as_utf16()))
    });
    if !destination_is_physical && remaps_recipe_component {
        return Err(CommandError::domain(
            "Mixed-filament recipe components can only be remapped to a physical filament in Snapmaker v2.3.4",
        ));
    }
    let replace = |id: &Option<FilamentId>| match id {
        Some(id) if is_source(id.as_utf16()) => Some(destination.clone()),
        other => other.clone(),
    };
    let mut plates = state.plates.to_vec();
    for plate in plates.iter_mut() {
        let plate = Arc::make_mut(plate);
        if let Some(tower) = &mut plate.wipe_tower
            && tower.filament_id.is_some()
        {
            let next = replace(&tower.filament_id);
            Arc::make_mut(tower).filament_id = next;
        }
        let mut objects = plate.objects.to_vec();
        for object in objects.iter_mut() {
            let object = Arc::make_mut(object);
            object.filament_id = replace(&object.filament_id);
            let mut volumes = object.volumes.to_vec();
            for volume in volumes.iter_mut() {
                let volume = Arc::make_mut(volume);
                volume.filament_id = replace(&volume.filament_id);
                remap_paint(volume, &is_source, destination)?;
            }
            object.volumes = volumes.into();
            let mut ranges = object.layer_ranges.to_vec();
            for range in ranges.iter_mut() {
                let next = replace(&range.filament_id);
                if next != range.filament_id {
                    Arc::make_mut(range).filament_id = next;
                }
            }
            object.layer_ranges = ranges.into();
        }
        plate.objects = objects.into();
    }
    state.plates = plates.into();
    let mut mixed = state.filaments.mixed.to_vec();
    for filament in mixed.iter_mut() {
        if filament
            .components
            .iter()
            .any(|c| is_source(c.filament_id.as_utf16()))
        {
            remap_components(Arc::make_mut(filament), &is_source, destination)?;
        }
    }
    let mut filaments = state.filaments.clone();
    filaments.mixed = mixed.into();
    state.filaments = filaments;
    Ok(())
}

/// `remapFacetChannelValues` on the colour channel: both halves together, so a
/// split that becomes uniform moves into the whole-facet assignments.
fn remap_paint<E>(
    volume: &mut ProjectVolume,
    is_source: &impl Fn(&[u16]) -> bool,
    destination: &FilamentId,
) -> Result<(), CommandError<E>> {
    let annotations = Arc::make_mut(&mut volume.annotations);
    let mut refinement = annotations
        .refinement
        .as_ref()
        .map(|r| fields(&Some(r.clone())));
    let encoding = refinement
        .as_ref()
        .and_then(|r| r.get(&u("color")))
        .cloned();
    let triangle_count = match &encoding {
        Some(Value::Object(e)) => match e.get(&u("triangleCount")) {
            Some(Value::Number(n)) => *n,
            _ => volume.source.triangle_count.get(),
        },
        _ => volume.source.triangle_count.get(),
    };
    let options = ValidationOptions::new(triangle_count, "");
    let invalid = || CommandError::domain("Facet paint cannot be remapped");
    let channel = FacetChannel::decode(
        Channel::Color,
        annotations.color.value(),
        encoding.as_ref(),
        &options,
    )
    .map_err(|_| invalid())?;
    let remapped = channel
        .remap(
            |value| match value {
                PaintValue::Text(id) if is_source(id) => {
                    PaintValue::text(destination.as_utf16().to_vec())
                }
                other => other.clone(),
            },
            None,
        )
        .map_err(|_| invalid())?;
    let Value::Object(mut result) = remapped.to_value() else {
        unreachable!("channel value is an object")
    };
    let assignments = result.remove(&u("assignments")).expect("assignments");
    annotations.color = Assignments::from_value(assignments).map_err(|_| invalid())?;
    if let Some(refinement_fields) = &mut refinement {
        match result.remove(&u("encoding")) {
            Some(encoding) => {
                refinement_fields.insert(u("color"), encoding);
            }
            None => {
                refinement_fields.remove(&u("color"));
            }
        }
        annotations.refinement = if refinement_fields.is_empty() {
            None
        } else {
            Some(json_object(std::mem::take(refinement_fields))?)
        };
    }
    Ok(())
}

/// `remapMixedComponents`: colliding components merge, in first-seen order,
/// summing weights (and gradient endpoint weights).
fn remap_components<E>(
    filament: &mut MixedFilament,
    is_source: &impl Fn(&[u16]) -> bool,
    destination: &FilamentId,
) -> Result<(), CommandError<E>> {
    let gradient = match &filament.distribution {
        MixedDistribution::Gradient(g) => Some(g.clone()),
        _ => None,
    };
    let mut groups: Vec<(Vec<u16>, f64, f64, f64)> = Vec::new();
    for (index, component) in filament.components.iter().enumerate() {
        let id: Vec<u16> = if is_source(component.filament_id.as_utf16()) {
            destination.as_utf16().to_vec()
        } else {
            component.filament_id.as_utf16().to_vec()
        };
        let weight_at = |weights: &List<Number>| weights.get(index).map_or(0.0, |w| w.get());
        let start = gradient
            .as_ref()
            .map_or(0.0, |g| weight_at(&g.start_weights));
        let end = gradient.as_ref().map_or(0.0, |g| weight_at(&g.end_weights));
        match groups.iter_mut().find(|g| g.0 == id) {
            Some(group) => {
                group.1 += component.weight.get();
                group.2 += start;
                group.3 += end;
            }
            None => groups.push((id, component.weight.get(), start, end)),
        }
    }
    filament.components = groups
        .iter()
        .map(|(id, weight, _, _)| {
            Ok(MixedComponent {
                filament_id: EntityId::try_from_utf16(id.clone())
                    .map_err(|_| non_serializable())?,
                weight: number(*weight)?,
                extra: ExtraFields::default(),
            })
        })
        .collect::<Result<Vec<_>, CommandError<E>>>()?
        .into();
    if let Some(mut gradient) = gradient {
        gradient.start_weights = groups
            .iter()
            .map(|g| number(g.2))
            .collect::<Result<Vec<_>, _>>()?
            .into();
        gradient.end_weights = groups
            .iter()
            .map(|g| number(g.3))
            .collect::<Result<Vec<_>, _>>()?
            .into();
        filament.distribution = MixedDistribution::Gradient(gradient);
    }
    Ok(())
}

const LIFECYCLE: &str = "orcaxrFilamentLifecycle";

/// `SetFilamentEnabledCommand`: a reversible tombstone that keeps references.
fn set_enabled<E>(
    state: &mut ProjectState,
    id: &FilamentId,
    enabled: bool,
    reason: &[u16],
) -> Result<(), CommandError<E>> {
    let (found, _) = require(state, id.as_utf16())?;
    let edit = |enabled_slot: &mut bool,
                extension: &mut Option<JsonObject>|
     -> Result<(), CommandError<E>> {
        *enabled_slot = enabled;
        if enabled {
            let mut map = fields(extension);
            if map.remove(&u(LIFECYCLE)).is_some() {
                *extension = if map.is_empty() {
                    None
                } else {
                    Some(json_object(map)?)
                };
            }
        } else {
            let mut map = fields(extension);
            let lifecycle = BTreeMap::from([
                (u("state"), Value::String(u("disabled"))),
                (u("reason"), Value::String(reason.to_vec())),
                (
                    u("semantics"),
                    Value::String(u("tombstone-preserve-references")),
                ),
            ]);
            map.insert(u(LIFECYCLE), Value::Object(lifecycle));
            *extension = Some(json_object(map)?);
        }
        Ok(())
    };
    let mut filaments = state.filaments.clone();
    match found {
        Found::Physical(i) => {
            let mut list = filaments.physical.to_vec();
            let filament = Arc::make_mut(&mut list[i]);
            edit(&mut filament.enabled, &mut filament.extension_data)?;
            filaments.physical = list.into();
        }
        Found::Mixed(i) => {
            let mut list = filaments.mixed.to_vec();
            let filament = Arc::make_mut(&mut list[i]);
            edit(&mut filament.enabled, &mut filament.extension_data)?;
            filaments.mixed = list.into();
        }
    }
    state.filaments = filaments;
    Ok(())
}

/// `printerFilamentSlotName`: only when the machine adds a vendor or grade.
fn slot_name(slot: &Slot) -> Option<Vec<u16>> {
    let vendor = slot.vendor.as_deref().map(trim);
    let sub_type = slot.sub_type.as_deref().map(trim);
    fn present(v: Option<&[u16]>) -> Option<&[u16]> {
        v.filter(|v| !v.is_empty())
    }
    if present(vendor).is_none() && present(sub_type).is_none() {
        return None;
    }
    let parts: Vec<&[u16]> = [
        present(vendor),
        present(Some(trim(&slot.material))),
        present(sub_type),
    ]
    .into_iter()
    .flatten()
    .collect();
    Some(parts.join(&u16::from(b' ')))
}

fn sync<E>(
    state: &mut ProjectState,
    slots: &[Slot],
    ids: Option<&[PhysicalFilamentId]>,
    consumed: &mut usize,
    adopted: &mut Vec<(u64, PhysicalFilamentId)>,
) -> Result<(), CommandError<E>> {
    // Keep the pre-sync colours where model colour recreation can find them.
    let mut before: HashMap<Vec<u16>, (Vec<u16>, Vec<u16>)> = HashMap::new();
    for f in state.filaments.physical.iter() {
        before.insert(
            f.id.as_utf16().to_vec(),
            (f.color.units().to_vec(), f.name.units().to_vec()),
        );
    }
    each_object(state, |object| {
        let object_colour = object
            .filament_id
            .as_ref()
            .and_then(|id| before.get(id.as_utf16()))
            .cloned();
        let mut volumes = object.volumes.to_vec();
        for volume in volumes.iter_mut() {
            let volume = Arc::make_mut(volume);
            let mut extension: Option<BTreeMap<Vec<u16>, Value>> = volume
                .extension_data
                .as_ref()
                .map(|_| fields(&volume.extension_data));
            let material = extension
                .as_ref()
                .and_then(|e| e.get(&u("orcaxr:sourceMaterial")));
            let colour = match material {
                Some(Value::Object(m)) => m.get(&u("color")),
                _ => None,
            };
            if !truthy(colour) {
                let volume_colour = volume
                    .filament_id
                    .as_ref()
                    .and_then(|id| before.get(id.as_utf16()))
                    .cloned();
                if let Some((color, name)) = volume_colour.or_else(|| object_colour.clone()) {
                    extension.get_or_insert_with(BTreeMap::new).insert(
                        u("orcaxr:sourceMaterial"),
                        Value::Object(BTreeMap::from([
                            (u("color"), Value::String(color)),
                            (u("name"), Value::String(name)),
                        ])),
                    );
                }
            }
            let painted = match volume.annotations.color.value() {
                Value::Array(items) => items.clone(),
                _ => Vec::new(),
            };
            if !painted.is_empty() {
                let mut originals = spread(
                    extension
                        .as_ref()
                        .and_then(|e| e.get(&u("orcaxr:originalFilamentColors"))),
                );
                for assignment in &painted {
                    let Some(Value::String(value)) = (match assignment {
                        Value::Object(a) => a.get(&u("value")),
                        _ => None,
                    }) else {
                        continue;
                    };
                    if let Some((color, _)) = before.get(value)
                        && !truthy(originals.get(value))
                    {
                        originals.insert(value.clone(), Value::String(color.clone()));
                    }
                }
                if !originals.is_empty() {
                    extension
                        .get_or_insert_with(BTreeMap::new)
                        .insert(u("orcaxr:originalFilamentColors"), Value::Object(originals));
                }
            }
            volume.extension_data = match extension {
                Some(map) => Some(json_object(map)?),
                None => None,
            };
        }
        object.volumes = volumes.into();
        Ok(())
    })?;

    let mut physical = state.filaments.physical.to_vec();
    let mut by_tool: HashMap<u64, usize> = HashMap::new();
    for (i, f) in physical.iter().enumerate() {
        by_tool.insert(f.tool_id.get().to_bits(), i);
    }
    for slot in slots {
        let name = slot_name(slot);
        let vendor = slot.vendor.as_deref().map(trim).filter(|v| !v.is_empty());
        let filament_type = |config: &ConfigMap| -> Result<ConfigMap, CommandError<E>> {
            let mut map = fields(&Some(config.clone()));
            map.insert(u("filament_type"), Value::String(slot.material.clone()));
            json_object(map)
        };
        match by_tool.get(&(slot.tool as f64).to_bits()) {
            Some(&i) => {
                let filament = Arc::make_mut(&mut physical[i]);
                filament.color = Text::new(slot.color.clone());
                filament.material = Text::new(slot.material.clone());
                filament.config = filament_type(&filament.config)?;
                if let Some(name) = &name {
                    filament.name = Text::new(name.clone());
                }
                if let Some(vendor) = vendor {
                    filament.vendor = Some(Text::new(vendor.to_vec()));
                }
            }
            None => {
                let Some(ids) = ids else { continue };
                let id = match adopted.iter().find(|(tool, _)| *tool == slot.tool) {
                    Some((_, id)) => id.clone(),
                    None => {
                        let id = ids.get(*consumed).cloned().ok_or_else(|| {
                            CommandError::domain("Printer sync needs more new filament IDs")
                        })?;
                        *consumed += 1;
                        adopted.push((slot.tool, id.clone()));
                        id
                    }
                };
                let empty = JsonObject::new(Value::Object(BTreeMap::new())).expect("empty object");
                physical.push(Arc::new(PhysicalFilament {
                    id,
                    name: Text::new(
                        name.clone()
                            .unwrap_or_else(|| u(&format!("Tool {}", slot.tool + 1))),
                    ),
                    tool_id: number(slot.tool as f64)?,
                    preset_id: None,
                    preset_hash: None,
                    material: Text::new(slot.material.clone()),
                    vendor: vendor.map(|v| Text::new(v.to_vec())),
                    color: Text::new(slot.color.clone()),
                    nozzle_diameter_mm: None,
                    config: filament_type(&empty)?,
                    enabled: true,
                    extension_data: None,
                    extra: ExtraFields::default(),
                }));
            }
        }
    }
    // Tools stay in slot order (a stable sort, like the browser's).
    physical.sort_by(|a, b| {
        a.tool_id
            .get()
            .partial_cmp(&b.tool_id.get())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let highest = physical.iter().fold(-1.0, |highest, f| {
        crate::js_math::max(highest, f.tool_id.get())
    });
    let mut printer = state.printer.clone();
    printer.tool_count = number(crate::js_math::max(printer.tool_count.get(), highest + 1.0))?;
    state.printer = printer;
    let mut filaments = state.filaments.clone();
    filaments.physical = physical.into();
    state.filaments = filaments;
    Ok(())
}
