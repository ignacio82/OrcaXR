//! Volume role conversion (`objects/semanticVolumeCommands.ts`): a part becomes
//! a negative volume, modifier, support blocker or enforcer (or back), refused
//! with the browser's reasons when it would leave no model part, strand facet
//! paint or keep a filament the role cannot carry. Volumes stay in upstream
//! Orca's role order. The decision itself is public
//! ([`inspect_volume_role_conversion`]), so hosts explain a blocked choice
//! before anything is submitted, in the same words the command refuses with.
use super::*;

/// `ORCA_VOLUME_ROLE_ORDER`: Snapmaker Orca v2.3.4's `ModelVolumeType` order.
pub const ORDER: [VolumeRole; 5] = [
    VolumeRole::Model,
    VolumeRole::NegativeVolume,
    VolumeRole::ParameterModifier,
    VolumeRole::SupportBlocker,
    VolumeRole::SupportEnforcer,
];
pub(super) fn rank(role: VolumeRole) -> usize {
    ORDER
        .iter()
        .position(|r| *r == role)
        .expect("every role is ordered")
}
pub(super) fn noun(role: VolumeRole) -> &'static str {
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

/// Why a conversion is refused (`VolumeRoleConversionBlockCode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VolumeRoleBlock {
    UnknownVolume,
    UnsupportedRole,
    LastModelVolume,
    FacetAnnotations,
    FilamentAssignment,
}
impl VolumeRoleBlock {
    /// The browser's code.
    pub fn code(self) -> &'static str {
        match self {
            Self::UnknownVolume => "unknown-volume",
            Self::UnsupportedRole => "unsupported-role",
            Self::LastModelVolume => "last-model-volume",
            Self::FacetAnnotations => "facet-annotations",
            Self::FilamentAssignment => "filament-assignment",
        }
    }
}

/// `VolumeRoleConversionDecision`: allowed (a no-op when the volume already
/// has the role), or refused with the browser's code and words.
#[derive(Debug, Clone, PartialEq)]
pub enum VolumeRoleDecision {
    Allowed { noop: bool },
    Blocked { code: VolumeRoleBlock, reason: Text },
}

/// `inspectVolumeRoleConversion(state, volumeId, nextRole)` for any role
/// text: a role Snapmaker Orca lacks is refused before the volume is looked
/// up, as in the browser.
pub fn inspect_volume_role_conversion(
    state: &ProjectState,
    volume_id: &[u16],
    role: &[u16],
) -> VolumeRoleDecision {
    match ORDER
        .iter()
        .find(|r| r.as_str().encode_utf16().eq(role.iter().copied()))
    {
        Some(role) => decide(state, volume_id, *role),
        None => {
            // `JSON.stringify(nextRole)`.
            let quoted = crate::js_math::convert::json_stringify(&Value::String(role.to_vec()));
            VolumeRoleDecision::Blocked {
                code: VolumeRoleBlock::UnsupportedRole,
                reason: text_parts(
                    "Volume role ",
                    &quoted,
                    " is not supported by Snapmaker Orca v2.3.4",
                ),
            }
        }
    }
}

/// [`inspect_volume_role_conversion`] for a supported role.
pub fn decide(state: &ProjectState, volume_id: &[u16], role: VolumeRole) -> VolumeRoleDecision {
    let blocked = |code, reason: &str| VolumeRoleDecision::Blocked {
        code,
        reason: Text::from_utf8(reason),
    };
    let Some((object, volume)) = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .find_map(|object| {
            object
                .volumes
                .iter()
                .find(|v| v.id.as_utf16() == volume_id)
                .map(|volume| (object, volume))
        })
    else {
        return VolumeRoleDecision::Blocked {
            code: VolumeRoleBlock::UnknownVolume,
            reason: text_parts("Unknown volume ", volume_id, ""),
        };
    };
    if volume.role == role {
        return VolumeRoleDecision::Allowed { noop: true };
    }
    let models = object
        .volumes
        .iter()
        .filter(|v| v.role == VolumeRole::Model)
        .count();
    if volume.role == VolumeRole::Model && role != VolumeRole::Model && models == 1 {
        return blocked(
            VolumeRoleBlock::LastModelVolume,
            "The last model part on an object cannot be converted to a non-model role",
        );
    }
    if role != VolumeRole::Model && painted(volume) {
        return blocked(
            VolumeRoleBlock::FacetAnnotations,
            "Clear facet paint annotations before converting this model part to a non-model role",
        );
    }
    let local_filament = matches!(role, VolumeRole::Model | VolumeRole::ParameterModifier);
    if !local_filament && volume.filament_id.is_some() {
        return blocked(
            VolumeRoleBlock::FilamentAssignment,
            &format!(
                "Clear the local filament assignment before converting this volume to {}",
                role.as_str()
            ),
        );
    }
    VolumeRoleDecision::Allowed { noop: false }
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
        match decide(state, self.volume.as_utf16(), self.role) {
            VolumeRoleDecision::Allowed { noop } => Ok(noop),
            VolumeRoleDecision::Blocked { reason, .. } => Err(CommandError::Domain(reason)),
        }
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
