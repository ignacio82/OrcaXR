//! Authored layer events (`layerEventCommands.ts`): add, patch and delete of
//! plate-scoped `customGcode` entries that carry a `layerEvent`. Each command
//! rewrites the whole list and lets graph validation (heights, tools, custom
//! code) refuse an invalid result, exactly as the browser's
//! `assertValidProjectState` does before publication.
use super::*;

/// One optional event field in an edit: keep the current value, remove it, or
/// replace it (`key in patch` in the browser).
#[derive(Clone)]
pub(super) enum Field<T> {
    Keep,
    Clear,
    Set(T),
}
impl<T: Clone> Field<T> {
    fn pick(&self, current: &Option<T>) -> Option<T> {
        match self {
            Self::Keep => current.clone(),
            Self::Clear => None,
            Self::Set(value) => Some(value.clone()),
        }
    }
}

/// `LayerEventDraft` without its IDs.
#[derive(Clone)]
pub(super) struct Draft {
    kind: LayerEventType,
    top_z_mm: Number,
    tool_index: Option<Number>,
    filament_id: Option<FilamentId>,
    color: Option<Text>,
    message: Option<Text>,
    code: Option<Text>,
}
#[derive(Clone)]
pub(super) struct Patch {
    kind: Option<LayerEventType>,
    top_z_mm: Option<Number>,
    tool_index: Field<Number>,
    filament_id: Field<FilamentId>,
    color: Field<Text>,
    message: Field<Text>,
    code: Option<Text>,
}
#[derive(Clone)]
pub(super) enum Op {
    Add(Arc<CustomGcode>),
    Edit {
        id: CustomGcodeId,
        patch: Box<Patch>,
    },
    Delete {
        id: CustomGcodeId,
    },
}
#[derive(Clone)]
pub(super) struct LayerEventCommand {
    op: Op,
    previous: Option<List<Arc<CustomGcode>>>,
}

fn kind(value: wire::LayerEventType) -> LayerEventType {
    match value {
        wire::LayerEventType::ColorChange => LayerEventType::ColorChange,
        wire::LayerEventType::Pause => LayerEventType::Pause,
        wire::LayerEventType::ToolChange => LayerEventType::ToolChange,
        wire::LayerEventType::Template => LayerEventType::Template,
        wire::LayerEventType::Custom => LayerEventType::Custom,
    }
}
fn number(value: f64) -> Result<Number, PreparationError> {
    Number::new(value).map_err(|_| PreparationError::InvalidIntent)
}
fn optional_number(value: wire::OptionalFinite) -> Result<Option<Number>, PreparationError> {
    match value {
        wire::OptionalFinite::Absent(_) => Ok(None),
        wire::OptionalFinite::Value(v) => number(v).map(Some),
    }
}
fn optional_text(value: wire::OptionalText) -> Option<Text> {
    match value {
        wire::OptionalText::Absent(_) => None,
        wire::OptionalText::Value(v) => Some(Text::new(v)),
    }
}

/// `layerEventEntry`: the canonical entry the engine projection reads. Only a
/// custom event carries a body; the others come from the printer profile.
fn entry(id: CustomGcodeId, plate_id: Option<PlateId>, draft: Draft) -> CustomGcode {
    CustomGcode {
        id,
        scope: GcodeScope::Plate,
        plate_id,
        // The engine fires these before the layer they name is printed.
        trigger: GcodeTrigger::BeforeLayer,
        code: match draft.kind {
            LayerEventType::Custom => draft.code.unwrap_or_else(|| Text::new(Vec::new())),
            _ => Text::new(Vec::new()),
        },
        layer_event: Some(Arc::new(CustomGcodeLayerEvent {
            kind: draft.kind,
            top_z_mm: draft.top_z_mm,
            tool_index: draft.tool_index,
            filament_id: draft.filament_id,
            color: draft.color,
            message: draft.message,
            extra: ExtraFields::default(),
        })),
        extra: ExtraFields::default(),
    }
}
fn unknown_event<E>(id: &CustomGcodeId) -> CommandError<E> {
    CommandError::Domain(text_parts("Unknown layer event ", id.as_utf16(), ""))
}

impl LayerEventCommand {
    fn new(op: Op) -> Self {
        Self { op, previous: None }
    }
    pub(super) fn add(v: wire::AddLayerEvent) -> Result<Self, PreparationError> {
        let draft = Draft {
            kind: kind(v.event_type),
            top_z_mm: number(v.top_z_mm)?,
            tool_index: optional_number(v.tool_index)?,
            filament_id: match v.filament_id {
                wire::OptionalId::Absent(_) => None,
                wire::OptionalId::Value(units) => Some(id(units)?),
            },
            color: optional_text(v.color),
            message: optional_text(v.message),
            code: optional_text(v.code),
        };
        let entry = entry(id(v.custom_gcode_id)?, Some(id(v.plate_id)?), draft);
        Ok(Self::new(Op::Add(Arc::new(entry))))
    }
    pub(super) fn edit(v: wire::EditLayerEvent) -> Result<Self, PreparationError> {
        let id_value = id(v.custom_gcode_id)?;
        let patch = Patch {
            kind: match v.event_type {
                wire::OptionalLayerEventType::Absent(_) => None,
                wire::OptionalLayerEventType::Value(t) => Some(kind(t)),
            },
            top_z_mm: optional_number(v.top_z_mm)?,
            tool_index: match v.tool_index {
                wire::PatchFinite::Keep(_) => Field::Keep,
                wire::PatchFinite::Clear(_) => Field::Clear,
                wire::PatchFinite::Value(n) => Field::Set(number(n)?),
            },
            filament_id: match v.filament_id {
                wire::PatchId::Keep(_) => Field::Keep,
                wire::PatchId::Clear(_) => Field::Clear,
                wire::PatchId::Value(units) => Field::Set(id(units)?),
            },
            color: text_field(v.color),
            message: text_field(v.message),
            code: optional_text(v.code),
        };
        Ok(Self::new(Op::Edit {
            id: id_value,
            patch: Box::new(patch),
        }))
    }
    pub(super) fn delete(v: wire::DeleteLayerEvent) -> Result<Self, PreparationError> {
        Ok(Self::new(Op::Delete {
            id: id(v.custom_gcode_id)?,
        }))
    }
    /// `Add ${LABELS[type]}` for an add; fixed labels otherwise.
    pub(super) fn label(&self) -> Text {
        Text::from_utf8(match &self.op {
            Op::Add(entry) => match entry.layer_event.as_ref().map(|e| e.kind) {
                Some(LayerEventType::ColorChange) => "Add colour change",
                Some(LayerEventType::Pause) => "Add pause",
                Some(LayerEventType::ToolChange) => "Add tool change",
                Some(LayerEventType::Template) => "Add template G-code",
                Some(LayerEventType::Custom) | None => "Add custom G-code",
            },
            Op::Edit { .. } => "Edit layer event",
            Op::Delete { .. } => "Delete layer event",
        })
    }
    pub(super) fn reason(&self) -> &'static str {
        match self.op {
            Op::Add(_) => "add-layer-event",
            Op::Edit { .. } => "edit-layer-event",
            Op::Delete { .. } => "delete-layer-event",
        }
    }
    fn class(&self) -> &'static str {
        match self.op {
            Op::Add(_) => "AddLayerEventCommand",
            Op::Edit { .. } => "EditLayerEventCommand",
            Op::Delete { .. } => "DeleteLayerEventCommand",
        }
    }
    /// The next `customGcode` list, or the browser's refusal. Validity of the
    /// result (heights, tools, code, plate) is left to graph validation.
    fn mutate<E>(
        &self,
        current: &[Arc<CustomGcode>],
    ) -> Result<Vec<Arc<CustomGcode>>, CommandError<E>> {
        let is_event = |e: &CustomGcode, id: &CustomGcodeId| &e.id == id && e.layer_event.is_some();
        let mut next = current.to_vec();
        match &self.op {
            Op::Add(entry) => {
                if current.iter().any(|e| e.id == entry.id) {
                    return Err(CommandError::Domain(text_parts(
                        "Custom G-code ",
                        entry.id.as_utf16(),
                        " already exists",
                    )));
                }
                next.push(entry.clone());
            }
            Op::Edit { id, patch } => {
                let index = current
                    .iter()
                    .position(|e| is_event(e, id))
                    .ok_or_else(|| unknown_event(id))?;
                let entry_now = &current[index];
                let event = entry_now.layer_event.as_ref().expect("located layer event");
                let draft = Draft {
                    kind: patch.kind.unwrap_or(event.kind),
                    top_z_mm: patch.top_z_mm.unwrap_or(event.top_z_mm),
                    tool_index: patch.tool_index.pick(&event.tool_index),
                    filament_id: patch.filament_id.pick(&event.filament_id),
                    color: patch.color.pick(&event.color),
                    message: patch.message.pick(&event.message),
                    code: Some(patch.code.clone().unwrap_or_else(|| entry_now.code.clone())),
                };
                next[index] = Arc::new(entry(
                    entry_now.id.clone(),
                    entry_now.plate_id.clone(),
                    draft,
                ));
            }
            Op::Delete { id } => {
                if !current.iter().any(|e| is_event(e, id)) {
                    return Err(unknown_event(id));
                }
                next.retain(|e| &e.id != id);
            }
        }
        Ok(next)
    }
    pub(super) fn is_noop<E>(&self, state: &ProjectState) -> Result<bool, CommandError<E>> {
        Ok(self.mutate(&state.custom_gcode)?.as_slice() == &*state.custom_gcode)
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let mut state = context.snapshot().state().clone();
        self.previous = Some(state.custom_gcode.clone());
        state.custom_gcode = self.mutate(&state.custom_gcode)?.into();
        // Layer events change what the machine does mid-print: the validating
        // replacement refuses an invalid list before it reaches the store.
        context.replace(state, reason, PROJECT)
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
        let mut state = context.snapshot().state().clone();
        state.custom_gcode = previous;
        context.replace(state, reason, PROJECT)
    }
    /// The browser retains only the previous list.
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        match &self.previous {
            Some(previous) => duplicate::canonical_length(previous),
            None => Ok(1),
        }
    }
}
fn text_field(value: wire::PatchText) -> Field<Text> {
    match value {
        wire::PatchText::Keep(_) => Field::Keep,
        wire::PatchText::Clear(_) => Field::Clear,
        wire::PatchText::Value(units) => Field::Set(Text::new(units)),
    }
}
