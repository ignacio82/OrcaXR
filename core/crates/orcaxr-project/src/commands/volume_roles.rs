//! Volume role conversion (`objects/semanticVolumeCommands.ts`): a part becomes
//! a negative volume, modifier, support blocker or enforcer (or back), refused
//! with the browser's reasons when it would leave no model part, strand facet
//! paint or keep a filament the role cannot carry. Volumes stay in upstream
//! Orca's role order.
use super::*;

/// `ORCA_VOLUME_ROLE_ORDER`.
const ORDER: [VolumeRole; 5] = [
    VolumeRole::Model,
    VolumeRole::NegativeVolume,
    VolumeRole::ParameterModifier,
    VolumeRole::SupportBlocker,
    VolumeRole::SupportEnforcer,
];
fn rank(role: VolumeRole) -> usize {
    ORDER
        .iter()
        .position(|r| *r == role)
        .expect("every role is ordered")
}
fn noun(role: VolumeRole) -> &'static str {
    match role {
        VolumeRole::Model => "part",
        VolumeRole::NegativeVolume => "negative part",
        VolumeRole::ParameterModifier => "modifier",
        VolumeRole::SupportBlocker => "support blocker",
        VolumeRole::SupportEnforcer => "support enforcer",
    }
}
/// `facetAnnotationsHaveAssignments`.
fn painted(volume: &ProjectVolume) -> bool {
    let a = &volume.annotations;
    let nonempty = |v: &Value| matches!(v, Value::Array(items) if !items.is_empty());
    nonempty(a.color.value())
        || nonempty(a.support.value())
        || nonempty(a.seam.value())
        || nonempty(a.fuzzy_skin.value())
        || nonempty(a.brim.value())
        || matches!(a.refinement.as_ref().map(JsonObject::value), Some(Value::Object(f)) if !f.is_empty())
}

#[derive(Clone)]
pub(super) struct ConvertVolumeRole {
    volume: VolumeId,
    role: VolumeRole,
    object: Option<ObjectId>,
    previous: Option<List<Arc<ProjectVolume>>>,
}
impl ConvertVolumeRole {
    pub(super) fn new(v: wire::ConvertVolumeRole) -> Result<Self, PreparationError> {
        let role = match v.role {
            wire::VolumeRoleName::Model => VolumeRole::Model,
            wire::VolumeRoleName::NegativeVolume => VolumeRole::NegativeVolume,
            wire::VolumeRoleName::ParameterModifier => VolumeRole::ParameterModifier,
            wire::VolumeRoleName::SupportBlocker => VolumeRole::SupportBlocker,
            wire::VolumeRoleName::SupportEnforcer => VolumeRole::SupportEnforcer,
        };
        Ok(Self {
            volume: id(v.volume_id)?,
            role,
            object: None,
            previous: None,
        })
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(&format!("Convert volume to {}", noun(self.role)))
    }
    fn find(&self, state: &ProjectState) -> Option<(usize, usize, usize)> {
        state.plates.iter().enumerate().find_map(|(p, plate)| {
            plate.objects.iter().enumerate().find_map(|(o, object)| {
                object
                    .volumes
                    .iter()
                    .position(|v| v.id == self.volume)
                    .map(|v| (p, o, v))
            })
        })
    }
    /// `inspectVolumeRoleConversion` + `assertConversionAllowed`: `Ok(noop)`.
    fn inspect<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        let (p, o, v) = self.find(state).ok_or_else(|| {
            CommandError::Domain(text_parts("Unknown volume ", self.volume.as_utf16(), ""))
        })?;
        let object = &state.plates[p].objects[o];
        let volume = &object.volumes[v];
        if volume.role == self.role {
            return Ok(true);
        }
        let models = object
            .volumes
            .iter()
            .filter(|v| v.role == VolumeRole::Model)
            .count();
        if volume.role == VolumeRole::Model && self.role != VolumeRole::Model && models == 1 {
            return Err(CommandError::domain(
                "The last model part on an object cannot be converted to a non-model role",
            ));
        }
        if self.role != VolumeRole::Model && painted(volume) {
            return Err(CommandError::domain(
                "Clear facet paint annotations before converting this model part to a non-model role",
            ));
        }
        let local_filament = matches!(self.role, VolumeRole::Model | VolumeRole::ParameterModifier);
        if !local_filament && volume.filament_id.is_some() {
            return Err(CommandError::domain(format!(
                "Clear the local filament assignment before converting this volume to {}",
                self.role.as_str()
            )));
        }
        Ok(false)
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        self.inspect(state)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        self.inspect(&state)?;
        let (p, o, v) = self.find(&state).expect("inspected");
        let role = self.role;
        self.object = Some(state.plates[p].objects[o].id.clone());
        self.previous = Some(state.plates[p].objects[o].volumes.clone());
        update_object(&mut state, (p, o), |object| {
            let mut volumes = object.volumes.to_vec();
            Arc::make_mut(&mut volumes[v]).role = role;
            // A stable sort, like the browser's.
            volumes.sort_by_key(|volume| rank(volume.role));
            object.volumes = volumes.into();
        });
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let (Some(object_id), Some(previous)) = (&self.object, &self.previous) else {
            return Err(CommandError::domain(
                "ConvertVolumeRoleCommand has not been applied",
            ));
        };
        let mut state = context.snapshot().state().clone();
        let at = locate_object(&state, object_id).ok_or_else(|| {
            CommandError::Domain(text_parts("Unknown object ", object_id.as_utf16(), ""))
        })?;
        let previous = previous.clone();
        update_object(&mut state, at, |object| object.volumes = previous);
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        match &self.previous {
            Some(previous) => duplicate::canonical_length(previous),
            None => Ok(1),
        }
    }
}
