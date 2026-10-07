//! Facet paint strokes sent as intents (`FacetStrokeRequestCommand` in
//! `annotations/FacetAnnotationStrokeCommand.ts`): the first apply prepares the
//! before/after annotations against the current state exactly as the browser's
//! `prepareFacetAnnotationStroke`; later applies and reverts swap them, refusing
//! if the volume's topology or annotations moved underneath.
use super::*;
use crate::facets::{
    Channel, FacetChannel, PaintValue, ValidationOptions,
    stroke::{
        StrokeOperation, TriangleRange, apply_stroke, normalize_assignments, normalize_ranges,
    },
};
use std::collections::BTreeSet;

#[derive(Clone)]
struct Guard {
    revision: u64,
    hash: Vec<u16>,
    volume: VolumeId,
    topology: f64,
    triangles: f64,
}
#[derive(Clone)]
pub(super) struct FacetStroke {
    guard: Guard,
    channel: Channel,
    operation: StrokeOperation,
    label: Text,
    prepared: Option<(Arc<FacetAnnotations>, Arc<FacetAnnotations>)>,
    applied_once: bool,
}
enum Prepared {
    Noop,
    Stroke(Arc<FacetAnnotations>, Arc<FacetAnnotations>),
}

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn stale<E>(reason: &str) -> CommandError<E> {
    CommandError::domain(format!("Facet annotation result is stale ({reason})"))
}
fn invalid<E>(issues: usize) -> CommandError<E> {
    let plural = if issues == 1 { "" } else { "s" };
    CommandError::domain(format!(
        "Invalid facet annotations ({issues} issue{plural})"
    ))
}
fn channel_name(channel: Channel) -> &'static str {
    channel.name()
}
type Fields = std::collections::BTreeMap<Vec<u16>, Value>;
static EMPTY: Value = Value::Array(Vec::new());
/// The annotations as the browser's JSON: the stroke and its validation work on
/// these values, and only a valid result is decoded into the typed model.
fn fields_of(annotations: &FacetAnnotations) -> Fields {
    match annotations.to_value() {
        Ok(Value::Object(fields)) => fields,
        _ => Fields::new(),
    }
}
fn channel_of(fields: &Fields, channel: Channel) -> &Value {
    fields.get(&u(channel.name())).unwrap_or(&EMPTY)
}
fn refinement_of(fields: &Fields) -> Option<&Fields> {
    match fields.get(&u("refinement")) {
        Some(Value::Object(refinement)) => Some(refinement),
        _ => None,
    }
}
/// `validChannelValue`.
fn valid_value(channel: Channel, value: &PaintValue, filaments: &BTreeSet<Vec<u16>>) -> bool {
    match (channel, value) {
        (Channel::Color, PaintValue::Text(id)) => filaments.contains(id.as_ref()),
        (Channel::Support, PaintValue::Text(t)) => {
            t.iter().copied().eq("enforce".encode_utf16())
                || t.iter().copied().eq("block".encode_utf16())
        }
        (Channel::Seam, PaintValue::Text(t)) => {
            t.iter().copied().eq("prefer".encode_utf16())
                || t.iter().copied().eq("avoid".encode_utf16())
        }
        (Channel::FuzzySkin, PaintValue::Bool(true)) | (Channel::Brim, PaintValue::Bool(_)) => true,
        _ => false,
    }
}

impl FacetStroke {
    pub(super) fn new(v: wire::FacetStroke) -> Result<Self, PreparationError> {
        let channel = match v.channel {
            wire::FacetChannelName::Color => Channel::Color,
            wire::FacetChannelName::Support => Channel::Support,
            wire::FacetChannelName::Seam => Channel::Seam,
            wire::FacetChannelName::FuzzySkin => Channel::FuzzySkin,
            wire::FacetChannelName::Brim => Channel::Brim,
        };
        let ranges = |ranges: Vec<wire::TriangleRangeInput>| -> Vec<TriangleRange> {
            ranges
                .into_iter()
                .map(|r| TriangleRange {
                    start: r.start as f64,
                    end_exclusive: r.end_exclusive as f64,
                })
                .collect()
        };
        let (operation, mode) = match v.operation {
            wire::FacetStrokeOperationInput::Paint(p) => {
                let value = match p.value {
                    wire::PaintValueInput::Text(t) => PaintValue::text(t),
                    wire::PaintValueInput::Flag(b) => PaintValue::Bool(b),
                };
                (StrokeOperation::Paint(ranges(p.ranges), value), "Paint")
            }
            wire::FacetStrokeOperationInput::Erase(e) => {
                (StrokeOperation::Erase(ranges(e.ranges)), "Erase")
            }
            wire::FacetStrokeOperationInput::Reset(_) => (StrokeOperation::Reset, "Reset"),
        };
        let label = match v.label {
            wire::OptionalText::Value(label) => Text::new(label),
            wire::OptionalText::Absent(_) => {
                Text::from_utf8(&format!("{mode} {} facets", channel_name(channel)))
            }
        };
        Ok(Self {
            guard: Guard {
                revision: v.guard.revision,
                hash: v.guard.hash,
                volume: id(v.guard.volume_id)?,
                topology: v.guard.topology_revision as f64,
                triangles: v.guard.triangle_count as f64,
            },
            channel,
            operation,
            label,
            prepared: None,
            applied_once: false,
        })
    }
    pub(super) fn label(&self) -> Text {
        self.label.clone()
    }
    fn current(&self, snapshot: &crate::store::ProjectSnapshot) -> bool {
        snapshot.revision() == self.guard.revision
            && self
                .guard
                .hash
                .iter()
                .copied()
                .eq(snapshot.hash().encode_utf16())
    }
    fn find<'a>(
        &self,
        state: &'a ProjectState,
    ) -> Option<(usize, usize, usize, &'a ProjectVolume)> {
        state.plates.iter().enumerate().find_map(|(p, plate)| {
            plate.objects.iter().enumerate().find_map(|(o, object)| {
                object
                    .volumes
                    .iter()
                    .position(|v| v.id == self.guard.volume)
                    .map(|v| (p, o, v, object.volumes[v].as_ref()))
            })
        })
    }
    fn topology_moved(&self, volume: &ProjectVolume) -> bool {
        volume.source.topology_revision.get() != self.guard.topology
            || volume.source.triangle_count.get() != self.guard.triangles
            || volume.annotations.topology_revision.get() != self.guard.topology
    }
    /// `validateFacetAnnotations`: the number of issues the browser reports.
    fn issues(&self, annotations: &Fields, filaments: &BTreeSet<Vec<u16>>) -> usize {
        let count = self.guard.triangles;
        let mut issues = 0;
        if annotations.get(&u("topologyRevision")) != Some(&Value::Number(self.guard.topology)) {
            issues += 1;
        }
        for channel in Channel::ALL {
            let Value::Array(assignments) = channel_of(annotations, channel) else {
                continue;
            };
            let mut seen = BTreeSet::new();
            for assignment in assignments {
                let Value::Object(fields) = assignment else {
                    continue;
                };
                let value = fields.get(&u("value")).and_then(PaintValue::from_value);
                if !value.is_some_and(|v| valid_value(channel, &v, filaments)) {
                    issues += 1;
                }
                if let Some(Value::Array(triangles)) = fields.get(&u("triangles")) {
                    for triangle in triangles {
                        let Value::Number(t) = triangle else {
                            issues += 1;
                            continue;
                        };
                        if t.fract() != 0.0 || *t < 0.0 || *t >= count {
                            issues += 1;
                            continue;
                        }
                        if !seen.insert(*t as u64) {
                            issues += 1;
                        }
                    }
                }
            }
        }
        if let Some(refinement) = refinement_of(annotations) {
            if refinement.is_empty() {
                issues += 1;
            }
            issues += refinement
                .keys()
                .filter(|k| {
                    !Channel::ALL
                        .iter()
                        .any(|c| k.iter().copied().eq(c.name().encode_utf16()))
                })
                .count();
            for channel in Channel::ALL {
                if let Some(candidate) = refinement.get(&u(channel.name())) {
                    let path = format!("refinement.{}", channel.name());
                    let mut options = ValidationOptions::new(count, &path);
                    options.filament_ids = Some(filaments);
                    issues += crate::facets::validate_refinement(
                        channel,
                        candidate,
                        channel_of(annotations, channel),
                        &options,
                    )
                    .len();
                }
            }
        }
        issues
    }
    /// `prepareFacetAnnotationStroke`.
    fn prepare<E>(&self, state: &ProjectState, current: bool) -> Result<Prepared, CommandError<E>> {
        if !current {
            return Err(stale("project"));
        }
        let (_, _, _, volume) = self.find(state).ok_or_else(|| stale("project"))?;
        if self.topology_moved(volume) {
            return Err(stale("topology"));
        }
        if volume.role != VolumeRole::Model {
            return Err(invalid(1));
        }
        let filaments: BTreeSet<Vec<u16>> = state
            .filaments
            .physical
            .iter()
            .map(|f| f.id.as_utf16().to_vec())
            .chain(
                state
                    .filaments
                    .mixed
                    .iter()
                    .map(|f| f.id.as_utf16().to_vec()),
            )
            .collect();
        let before = volume.annotations.clone();
        let before_fields = fields_of(&before);
        let issues = self.issues(&before_fields, &filaments);
        if issues > 0 {
            return Err(invalid(issues));
        }
        let count = self.guard.triangles;
        let stored = refinement_of(&before_fields)
            .and_then(|r| r.get(&u(self.channel.name())))
            .cloned();
        let decoded = FacetChannel::decode(
            self.channel,
            channel_of(&before_fields, self.channel),
            stored.as_ref(),
            &ValidationOptions::new(count, ""),
        )
        .map_err(|issues| invalid(issues.len()))?;
        let normalized = normalize_assignments(decoded.assignments()).map_err(|_| invalid(1))?;
        let value_of = |assignments: &[crate::facets::Assignment]| {
            Value::Array(assignments.iter().map(|a| a.to_value()).collect())
        };
        let mut after = before_fields.clone();
        let name = u(self.channel.name());
        let ranges = |ranges: &[TriangleRange]| normalize_ranges(ranges, count).map_err(invalid);
        let stroked = |normalized: &[crate::facets::Assignment]| -> Result<Vec<crate::facets::Assignment>, CommandError<E>> {
            match &self.operation {
                StrokeOperation::Reset => Ok(Vec::new()),
                StrokeOperation::Erase(r) => apply_stroke(normalized, &ranges(r)?, None).map_err(|_| invalid(1)),
                StrokeOperation::Paint(r, value) => {
                    apply_stroke(normalized, &ranges(r)?, Some(value)).map_err(|_| invalid(1))
                }
            }
        };
        match (decoded.encoding(), &self.operation) {
            (Some(_), StrokeOperation::Reset) => {
                after.insert(name, Value::Array(Vec::new()));
                set_refinement(&mut after, self.channel, None);
            }
            (Some(encoding), StrokeOperation::Erase(r) | StrokeOperation::Paint(r, _)) => {
                let covered = ranges(r)?;
                let next = encoding.without_roots(|t| {
                    covered
                        .iter()
                        .any(|c| t.number() >= c.start && t.number() < c.end_exclusive)
                });
                after.insert(name, value_of(&stroked(&normalized)?));
                let next = (!next.splits().is_empty()).then(|| next.to_value());
                set_refinement(&mut after, self.channel, next);
            }
            (None, _) => {
                let next = stroked(&normalized)?;
                if next == normalized {
                    return Ok(Prepared::Noop);
                }
                after.insert(name, value_of(&next));
            }
        }
        if before_fields == after {
            return Ok(Prepared::Noop);
        }
        let issues = self.issues(&after, &filaments);
        if issues > 0 {
            return Err(invalid(issues));
        }
        let after = FacetAnnotations::from_value(Value::Object(after))
            .map_err(|_| CommandError::Encoding)?;
        Ok(Prepared::Stroke(before, Arc::new(after)))
    }
    pub(super) fn is_noop<P: TimestampPolicy>(
        &self,
        context: &CommandContext<'_, P>,
    ) -> Result<bool, CommandError<P::Error>> {
        if self.prepared.is_some() {
            return Ok(false);
        }
        let snapshot = context.snapshot();
        Ok(matches!(
            self.prepare(snapshot.state(), self.current(&snapshot))?,
            Prepared::Noop
        ))
    }
    /// `FacetAnnotationStrokeCommand.replace`.
    fn replace<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        expected: &FacetAnnotations,
        replacement: &Arc<FacetAnnotations>,
        mismatch: &str,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        let (p, o, v, volume) = self.find(&state).ok_or_else(|| stale("topology"))?;
        if self.topology_moved(volume) {
            return Err(stale("topology"));
        }
        if volume.annotations.as_ref() != expected {
            return Err(stale(mismatch));
        }
        let replacement = replacement.clone();
        update_object(&mut state, (p, o), |object| {
            let mut volumes = object.volumes.to_vec();
            Arc::make_mut(&mut volumes[v]).annotations = replacement;
            object.volumes = volumes.into();
        });
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        if self.prepared.is_none() {
            let snapshot = context.snapshot();
            match self.prepare(snapshot.state(), self.current(&snapshot))? {
                Prepared::Stroke(before, after) => self.prepared = Some((before, after)),
                Prepared::Noop => return Err(stale("annotations")),
            }
        }
        let (before, after) = self.prepared.clone().expect("prepared");
        if !self.applied_once && !self.current(&context.snapshot()) {
            return Err(stale("project"));
        }
        let mismatch = if self.applied_once {
            "annotations"
        } else {
            "project"
        };
        self.replace(context, &before, &after, mismatch, reason)?;
        self.applied_once = true;
        Ok(())
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let (before, after) = self.prepared.clone().ok_or_else(|| {
            CommandError::domain("FacetStrokeRequestCommand has not been applied")
        })?;
        // The browser's `replace` publishes undo under the command type too.
        let _ = reason;
        self.replace(
            context,
            &after,
            &before,
            "annotations",
            Text::from_utf8("facet-annotation-stroke"),
        )
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        match &self.prepared {
            Some((before, after)) => Ok(duplicate::canonical_length(before.as_ref())?
                + duplicate::canonical_length(after.as_ref())?),
            None => Ok(1),
        }
    }
}

/// `setRefinementChannel`: an emptied refinement map is removed.
fn set_refinement(annotations: &mut Fields, channel: Channel, encoding: Option<Value>) {
    let mut refinement = refinement_of(annotations).cloned().unwrap_or_default();
    match encoding {
        Some(encoding) => {
            refinement.insert(u(channel.name()), encoding);
        }
        None => {
            refinement.remove(&u(channel.name()));
        }
    }
    if refinement.is_empty() {
        annotations.remove(&u("refinement"));
    } else {
        annotations.insert(u("refinement"), Value::Object(refinement));
    }
}
