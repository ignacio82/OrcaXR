//! Variable layer-height profile commands (`objects/layerHeightCommands.ts`):
//! every edit replaces the object's whole profile, and undo restores it or
//! removes it again, so an object that never had a profile never gains a flat
//! one. The adaptive command reads the first volume's mesh from the session.
use super::*;
use crate::layer_heights::{self as profile, Action, Edit, Limits, Parameters, Smoothing};

#[derive(Clone)]
pub(super) enum Op {
    Adjust(Parameters, Edit),
    Smooth(Parameters, Smoothing),
    Adaptive(Limits, f64),
    Reset,
}
#[derive(Clone)]
pub(super) struct LayerHeightCommand {
    object: ObjectId,
    op: Op,
    /// The profile before the last apply (`hadProfile` and `previous`).
    previous: Option<Option<List<Number>>>,
}

fn limits(v: wire::LayerHeightLimits) -> Limits {
    Limits {
        layer_height_mm: v.layer_height_mm,
        min_layer_height_mm: v.min_layer_height_mm,
        max_layer_height_mm: v.max_layer_height_mm,
        first_object_layer_height_mm: v.first_object_layer_height_mm,
        first_object_layer_height_fixed: v.first_object_layer_height_fixed,
    }
}
fn parameters(v: wire::LayerHeightParameters) -> Parameters {
    Parameters {
        limits: limits(v.limits),
        object_height_mm: v.object_height_mm,
    }
}
fn refused<E>(error: profile::ProfileError) -> CommandError<E> {
    CommandError::Domain(Text::from_utf8(&error.0))
}

impl LayerHeightCommand {
    fn new(object: ObjectId, op: Op) -> Self {
        Self {
            object,
            op,
            previous: None,
        }
    }
    pub(super) fn adjust(v: wire::AdjustLayerHeightProfile) -> Result<Self, PreparationError> {
        let action = match v.action {
            wire::LayerHeightAction::Increase => Action::Increase,
            wire::LayerHeightAction::Decrease => Action::Decrease,
            wire::LayerHeightAction::Reduce => Action::Reduce,
            wire::LayerHeightAction::Smooth => Action::Smooth,
        };
        let edit = Edit {
            z_mm: v.z_mm,
            thickness_delta_mm: v.thickness_delta_mm,
            band_width_mm: v.band_width_mm,
            action,
        };
        Ok(Self::new(
            id(v.object_id)?,
            Op::Adjust(parameters(v.parameters), edit),
        ))
    }
    pub(super) fn smooth(v: wire::SmoothLayerHeightProfile) -> Result<Self, PreparationError> {
        let smoothing = Smoothing {
            radius: v.radius,
            keep_min: v.keep_min,
        };
        Ok(Self::new(
            id(v.object_id)?,
            Op::Smooth(parameters(v.parameters), smoothing),
        ))
    }
    pub(super) fn adaptive(v: wire::AdaptiveLayerHeightProfile) -> Result<Self, PreparationError> {
        Ok(Self::new(
            id(v.object_id)?,
            Op::Adaptive(limits(v.limits), v.quality_factor),
        ))
    }
    pub(super) fn reset(v: wire::ResetLayerHeightProfile) -> Result<Self, PreparationError> {
        Ok(Self::new(id(v.object_id)?, Op::Reset))
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(match self.op {
            Op::Adjust(..) => "Edit layer height",
            Op::Smooth(..) => "Smooth layer height",
            Op::Adaptive(..) => "Adaptive layer height",
            Op::Reset => "Reset layer height",
        })
    }
    pub(super) fn reason(&self) -> &'static str {
        match self.op {
            Op::Adjust(..) => "adjust-layer-height-profile",
            Op::Smooth(..) => "smooth-layer-height-profile",
            Op::Adaptive(..) => "adaptive-layer-height-profile",
            Op::Reset => "reset-layer-height-profile",
        }
    }
    fn locate<E>(&self, state: &ProjectState) -> Result<(usize, usize), CommandError<E>> {
        locate_object(state, &self.object).ok_or_else(|| {
            CommandError::Domain(text_parts(
                "Object ",
                self.object.as_utf16(),
                " is not in this project",
            ))
        })
    }
    /// `nextProfile`: the wanted profile, or `None` to clear it.
    fn next_profile<P: TimestampPolicy>(
        &self,
        object: &ProjectObject,
        context: &CommandContext<'_, P>,
    ) -> Result<Option<Vec<f64>>, CommandError<P::Error>> {
        let current = || -> Option<Vec<f64>> {
            object
                .layer_height_profile
                .as_ref()
                .map(|p| p.iter().map(|n| n.get()).collect())
        };
        Ok(match &self.op {
            Op::Adjust(parameters, edit) => {
                let base = match current() {
                    Some(p) => p,
                    None => profile::base_profile(parameters).map_err(refused)?,
                };
                Some(profile::adjust(&base, parameters, edit).map_err(refused)?)
            }
            Op::Smooth(parameters, smoothing) => {
                let base = match current() {
                    Some(p) => p,
                    None => profile::base_profile(parameters).map_err(refused)?,
                };
                Some(profile::smooth(&base, parameters, smoothing).map_err(refused)?)
            }
            Op::Adaptive(limits, quality) => {
                let volume = object.volumes.first().ok_or_else(|| {
                    CommandError::Domain(text_parts(
                        "Object ",
                        object.id.as_utf16(),
                        " has no volumes",
                    ))
                })?;
                let asset_id = &volume.source.asset_id;
                let asset = context.assets().peek(asset_id).ok_or_else(|| {
                    CommandError::Domain(text_parts("Asset ", asset_id.as_utf16(), " not found"))
                })?;
                let mesh = crate::mesh::decode_indexed(&asset)
                    .map_err(|message| CommandError::Domain(Text::from_utf8(&message)))?;
                let (mut min_z, mut max_z) = (f64::INFINITY, f64::NEG_INFINITY);
                for [_, _, z] in &mesh.positions {
                    if *z < min_z {
                        min_z = *z;
                    }
                    if *z > max_z {
                        max_z = *z;
                    }
                }
                // A flat or empty mesh has no height of its own; 20 mm is the
                // editor's default.
                let height = if (max_z - min_z).is_finite() && max_z > min_z {
                    max_z - min_z
                } else {
                    20.0
                };
                let parameters = Parameters {
                    limits: *limits,
                    object_height_mm: height,
                };
                Some(
                    profile::adaptive(&mesh.positions, &mesh.indices, &parameters, *quality)
                        .map_err(refused)?,
                )
            }
            Op::Reset => None,
        })
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let at = self.locate(&state)?;
        let object = state.plates[at.0].objects[at.1].clone();
        self.previous = Some(object.layer_height_profile.clone());
        let next = match self.next_profile(&object, context)? {
            None => None,
            Some(values) => Some(
                values
                    .into_iter()
                    .map(Number::new)
                    .collect::<Result<Vec<_>, _>>()
                    // The browser stores the value and its validation refuses
                    // the whole state before anything else.
                    .map_err(|_| non_serializable())?
                    .into(),
            ),
        };
        update_object(&mut state, at, |object| object.layer_height_profile = next);
        context.replace(state, Text::from_utf8(self.reason()), PROJECT)
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let at = self.locate(&state)?;
        let previous = self.previous.clone().flatten();
        update_object(&mut state, at, |object| {
            object.layer_height_profile = previous
        });
        let reason = format!("{}:undo", self.reason());
        context.replace(state, Text::from_utf8(&reason), PROJECT)
    }
}
