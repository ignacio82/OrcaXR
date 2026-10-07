//! Layer-range lifecycle (`objects/layerRangeCommands.ts`): add, bounds edits,
//! split, merge and delete on one object's ranges, kept sorted by height then
//! UTF-16 ID, with the browser's checks, messages and selection repair. Settings
//! and filament assignments belong to their scoped commands.
use super::*;
use crate::selection::SelectionSnapshot;

#[derive(Clone)]
pub(super) enum Op {
    Add(Arc<LayerRange>),
    Edit {
        id: LayerRangeId,
        min: Option<f64>,
        max: Option<f64>,
    },
    Split {
        id: LayerRangeId,
        at: f64,
        upper: LayerRangeId,
    },
    Merge {
        first: LayerRangeId,
        second: LayerRangeId,
    },
    Delete {
        id: LayerRangeId,
    },
}
#[derive(Clone)]
pub(super) struct LayerRangeCommand {
    object: ObjectId,
    op: Op,
    previous: Option<List<Arc<LayerRange>>>,
    next: Option<List<Arc<LayerRange>>>,
}

/// `${number}`: ECMAScript Number::toString for these finite heights.
fn js(n: f64) -> String {
    let mut out = Vec::new();
    Value::Number(n)
        .write_canonical(&mut out)
        .expect("in-memory number");
    String::from_utf8(out).expect("ASCII number")
}
fn message(parts: &[&[u16]]) -> Text {
    Text::new(parts.concat())
}
fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn domain<E>(text: Text) -> CommandError<E> {
    CommandError::Domain(text)
}
const BOUNDS: &str = "Layer range must have finite bounds with 0 <= minZMm < maxZMm";
fn valid_bounds(min: f64, max: f64) -> bool {
    min.is_finite() && max.is_finite() && min >= 0.0 && max > min
}
/// `compareLayerRanges`: height, then UTF-16 ID.
fn compare(a: &LayerRange, b: &LayerRange) -> std::cmp::Ordering {
    let (a_min, b_min) = (a.min_z_mm.get(), b.min_z_mm.get());
    let (a_max, b_max) = (a.max_z_mm.get(), b.max_z_mm.get());
    a_min
        .partial_cmp(&b_min)
        .filter(|o| o.is_ne())
        .or_else(|| a_max.partial_cmp(&b_max).filter(|o| o.is_ne()))
        .unwrap_or_else(|| a.id.as_utf16().cmp(b.id.as_utf16()))
}
fn locate(state: &ProjectState, id: &ObjectId) -> Option<(usize, usize)> {
    state.plates.iter().enumerate().find_map(|(p, plate)| {
        plate
            .objects
            .iter()
            .position(|o| &o.id == id)
            .map(|o| (p, o))
    })
}
fn require_object<E>(
    state: &ProjectState,
    id: &ObjectId,
) -> Result<(usize, usize), CommandError<E>> {
    locate(state, id).ok_or_else(|| domain(message(&[&u("Unknown object "), id.as_utf16()])))
}
fn owned<E>(
    object: &ProjectObject,
    ranges: &[Arc<LayerRange>],
    id: &LayerRangeId,
) -> Result<usize, CommandError<E>> {
    ranges.iter().position(|r| &r.id == id).ok_or_else(|| {
        domain(message(&[
            &u("Layer range "),
            id.as_utf16(),
            &u(" is not owned by object "),
            object.id.as_utf16(),
        ]))
    })
}
fn ids_in_use(state: &ProjectState) -> std::collections::HashSet<&[u16]> {
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
fn available<E>(state: &ProjectState, id: &[u16]) -> Result<(), CommandError<E>> {
    if ids_in_use(state).contains(id) {
        return Err(domain(message(&[
            &u("Injected ID "),
            id,
            &u(" already exists in the project"),
        ])));
    }
    Ok(())
}
fn no_overlap<E>(
    ranges: &[Arc<LayerRange>],
    min: f64,
    max: f64,
    excluded: Option<&LayerRangeId>,
) -> Result<(), CommandError<E>> {
    if let Some(o) = ranges
        .iter()
        .find(|r| Some(&r.id) != excluded && min < r.max_z_mm.get() && r.min_z_mm.get() < max)
    {
        return Err(domain(Text::from_utf8(&format!(
            "Layer range [{}, {}] overlaps [{}, {}]",
            js(min),
            js(max),
            js(o.min_z_mm.get()),
            js(o.max_z_mm.get())
        ))));
    }
    Ok(())
}
fn number<E>(value: f64) -> Result<Number, CommandError<E>> {
    Number::new(value).map_err(|_| domain(Text::from_utf8(BOUNDS)))
}
/// `inspectOwnedLayerRangeMerge` after ownership: adjacency, then settings,
/// then filament assignment.
fn merge_refusal(
    ranges: &[Arc<LayerRange>],
    lower: &LayerRange,
    upper: &LayerRange,
) -> Option<&'static str> {
    let mut ordered: Vec<&LayerRange> = ranges.iter().map(Arc::as_ref).collect();
    ordered.sort_by(|a, b| compare(a, b));
    let index = |r: &LayerRange| ordered.iter().position(|o| std::ptr::eq(*o, r));
    if index(upper) != index(lower).map(|i| i + 1) || lower.max_z_mm.get() != upper.min_z_mm.get() {
        return Some(
            "Layer ranges can be merged only when they are consecutive and touch without a gap",
        );
    }
    if lower.config != upper.config {
        return Some(
            "Layer ranges with different settings cannot be merged without an explicit conflict choice",
        );
    }
    if lower.filament_id != upper.filament_id {
        return Some("Layer ranges with different filament assignments cannot be merged");
    }
    None
}
fn ordered_pair<'a>(
    a: &'a Arc<LayerRange>,
    b: &'a Arc<LayerRange>,
) -> (&'a Arc<LayerRange>, &'a Arc<LayerRange>) {
    if compare(a, b).is_le() {
        (a, b)
    } else {
        (b, a)
    }
}

impl LayerRangeCommand {
    fn new(object: ObjectId, op: Op) -> Self {
        Self {
            object,
            op,
            previous: None,
            next: None,
        }
    }
    pub(super) fn add(
        object: ObjectId,
        id: LayerRangeId,
        min: f64,
        max: f64,
    ) -> Result<Self, PreparationError> {
        if !valid_bounds(min, max) {
            return Err(PreparationError::Domain(Text::from_utf8(BOUNDS)));
        }
        let config = JsonObject::new(Value::Object(Default::default()))
            .map_err(|_| PreparationError::InvalidIntent)?;
        let range = LayerRange {
            id,
            min_z_mm: Number::new(min).map_err(|_| PreparationError::InvalidIntent)?,
            max_z_mm: Number::new(max).map_err(|_| PreparationError::InvalidIntent)?,
            config,
            filament_id: None,
            extra: ExtraFields::default(),
        };
        Ok(Self::new(object, Op::Add(Arc::new(range))))
    }
    pub(super) fn edit(
        object: ObjectId,
        id: LayerRangeId,
        min: Option<f64>,
        max: Option<f64>,
    ) -> Self {
        Self::new(object, Op::Edit { id, min, max })
    }
    pub(super) fn split(object: ObjectId, id: LayerRangeId, at: f64, upper: LayerRangeId) -> Self {
        Self::new(object, Op::Split { id, at, upper })
    }
    pub(super) fn merge(
        object: ObjectId,
        first: LayerRangeId,
        second: LayerRangeId,
    ) -> Result<Self, PreparationError> {
        if first == second {
            return Err(PreparationError::Domain(Text::from_utf8(
                "Merging layer ranges requires two distinct ranges",
            )));
        }
        Ok(Self::new(object, Op::Merge { first, second }))
    }
    pub(super) fn delete(object: ObjectId, id: LayerRangeId) -> Self {
        Self::new(object, Op::Delete { id })
    }
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(match self.op {
            Op::Add(_) => "Add layer range",
            Op::Edit { .. } => "Edit layer range",
            Op::Split { .. } => "Split layer range",
            Op::Merge { .. } => "Merge layer ranges",
            Op::Delete { .. } => "Delete layer range",
        })
    }
    pub(super) fn reason(&self) -> &'static str {
        match self.op {
            Op::Add(_) => "add-layer-range",
            Op::Edit { .. } => "edit-layer-range-bounds",
            Op::Split { .. } => "split-layer-range",
            Op::Merge { .. } => "merge-layer-ranges",
            Op::Delete { .. } => "delete-layer-range",
        }
    }
    /// The object's next ranges, sorted, or the browser's refusal.
    fn mutate<E>(
        &self,
        state: &ProjectState,
        object: &ProjectObject,
    ) -> Result<Vec<Arc<LayerRange>>, CommandError<E>> {
        let mut ranges: Vec<Arc<LayerRange>> = object.layer_ranges.to_vec();
        match &self.op {
            Op::Add(range) => {
                available(state, range.id.as_utf16())?;
                no_overlap(&ranges, range.min_z_mm.get(), range.max_z_mm.get(), None)?;
                ranges.push(range.clone());
            }
            Op::Edit { id, min, max } => {
                let index = owned(object, &ranges, id)?;
                let current = &ranges[index];
                let min = min.unwrap_or(current.min_z_mm.get());
                let max = max.unwrap_or(current.max_z_mm.get());
                if !valid_bounds(min, max) {
                    return Err(domain(Text::from_utf8(BOUNDS)));
                }
                no_overlap(&ranges, min, max, Some(id))?;
                let mut edited = current.as_ref().clone();
                edited.min_z_mm = number(min)?;
                edited.max_z_mm = number(max)?;
                ranges[index] = Arc::new(edited);
            }
            Op::Split { id, at, upper } => {
                let index = owned(object, &ranges, id)?;
                let lower = ranges[index].clone();
                if *at <= lower.min_z_mm.get() || *at >= lower.max_z_mm.get() {
                    return Err(domain(Text::from_utf8(&format!(
                        "Layer-range split height {} must be strictly inside [{}, {}]",
                        js(*at),
                        js(lower.min_z_mm.get()),
                        js(lower.max_z_mm.get())
                    ))));
                }
                available(state, upper.as_utf16())?;
                let mut top = lower.as_ref().clone();
                top.id = upper.clone();
                top.min_z_mm = number(*at)?;
                let mut bottom = lower.as_ref().clone();
                bottom.max_z_mm = number(*at)?;
                ranges[index] = Arc::new(bottom);
                ranges.push(Arc::new(top));
            }
            Op::Merge { first, second } => {
                let a = owned(object, &ranges, first)?;
                let b = owned(object, &ranges, second)?;
                let (lower, upper) = ordered_pair(&ranges[a], &ranges[b]);
                if let Some(reason) = merge_refusal(&ranges, lower, upper) {
                    return Err(domain(Text::from_utf8(reason)));
                }
                let mut merged = lower.as_ref().clone();
                merged.max_z_mm = upper.max_z_mm;
                let (lower_id, upper_id) = (lower.id.clone(), upper.id.clone());
                ranges.retain(|r| r.id != upper_id);
                let index = ranges
                    .iter()
                    .position(|r| r.id == lower_id)
                    .expect("retained lower range");
                ranges[index] = Arc::new(merged);
            }
            Op::Delete { id } => {
                let index = owned(object, &ranges, id)?;
                ranges.remove(index);
            }
        }
        ranges.sort_by(|a, b| compare(a, b));
        Ok(ranges)
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        let (p, o) = require_object(state, &self.object)?;
        let object = &state.plates[p].objects[o];
        Ok(self.mutate(state, object)?.as_slice() == &*object.layer_ranges)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let before = context.snapshot();
        let mut state = before.state().clone();
        let (p, o) = require_object(&state, &self.object)?;
        let before_selection = context.selection();
        let previous = state.plates[p].objects[o].layer_ranges.clone();
        let next: List<Arc<LayerRange>> = self.mutate(&state, &state.plates[p].objects[o])?.into();
        set_ranges(&mut state, p, o, next.clone());
        self.previous = Some(previous.clone());
        self.next = Some(next);
        context.replace(state, reason, PROJECT)?;
        let snapshot = context.snapshot();
        let after = snapshot.state();
        match &self.op {
            Op::Add(range) => {
                let only = SelectionRef::LayerRange(range.id.clone());
                context.set_selection(std::slice::from_ref(&only), Some(only.clone()))?;
            }
            Op::Split { upper, .. } => {
                let only = SelectionRef::LayerRange(upper.clone());
                context.set_selection(std::slice::from_ref(&only), Some(only.clone()))?;
            }
            Op::Merge { first, second } => {
                let find = |id: &LayerRangeId| {
                    previous
                        .iter()
                        .find(|r| &r.id == id)
                        .expect("owned range")
                        .clone()
                };
                let (a, b) = (find(first), find(second));
                let (retained, removed) = ordered_pair(&a, &b);
                repair(
                    context,
                    &before_selection,
                    &removed.id,
                    SelectionRef::LayerRange(retained.id.clone()),
                )?;
            }
            Op::Delete { id } => {
                let mut ordered: Vec<&Arc<LayerRange>> = previous.iter().collect();
                ordered.sort_by(|a, b| compare(a, b));
                let removed = ordered
                    .iter()
                    .position(|r| &r.id == id)
                    .expect("owned range");
                let (p, o) = locate(after, &self.object).expect("object retained");
                let remaining = &after.plates[p].objects[o].layer_ranges;
                let fallback = if remaining.is_empty() {
                    SelectionRef::Object(self.object.clone())
                } else {
                    SelectionRef::LayerRange(remaining[removed.min(remaining.len() - 1)].id.clone())
                };
                repair(context, &before_selection, id, fallback)?;
            }
            Op::Edit { .. } => {}
        }
        Ok(())
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self
            .previous
            .clone()
            .ok_or_else(|| unapplied("LayerRangeLifecycleCommand"))?;
        let mut state = context.snapshot().state().clone();
        let (p, o) = require_object(&state, &self.object)?;
        set_ranges(&mut state, p, o, previous);
        context.replace(state, reason, PROJECT)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        let previous = match &self.previous {
            Some(p) => duplicate::canonical_length(p)?,
            None => 0,
        };
        let next = match &self.next {
            Some(n) => duplicate::canonical_length(n)?,
            None => 1,
        };
        Ok(previous + next)
    }
}

fn set_ranges(state: &mut ProjectState, p: usize, o: usize, ranges: List<Arc<LayerRange>>) {
    let mut plates = state.plates.to_vec();
    let mut plate = plates[p].as_ref().clone();
    let mut objects = plate.objects.to_vec();
    let mut object = objects[o].as_ref().clone();
    object.layer_ranges = ranges;
    objects[o] = Arc::new(object);
    plate.objects = objects.into();
    plates[p] = Arc::new(plate);
    state.plates = plates.into();
}

/// `repairSelectionAfterRemoval`: prune, then reselect the fallback as primary
/// only when the removed range was the primary (or, without a primary, selected).
fn repair<P: TimestampPolicy>(
    context: &mut CommandContext<'_, P>,
    before: &SelectionSnapshot,
    removed: &LayerRangeId,
    fallback: SelectionRef,
) -> Result<(), CommandError<P::Error>> {
    let removed = SelectionRef::LayerRange(removed.clone());
    let was_selected = before.refs().contains(&removed);
    let primary_removed = match before.primary() {
        Some(primary) => primary == &removed,
        None => was_selected,
    };
    context.prune_selection();
    if !primary_removed {
        return Ok(());
    }
    let after = context.selection();
    let mut refs = after.refs().to_vec();
    if !refs.contains(&fallback) {
        refs.push(fallback.clone());
    }
    context.set_selection(&refs, Some(fallback))
}
