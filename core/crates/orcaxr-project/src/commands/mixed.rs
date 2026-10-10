//! Mixed-filament recipes (`filaments/mixedCommands.ts`): add, edit, duplicate,
//! enable/disable and tombstone run as validated snapshot commands through
//! [`super::filaments::FilamentCommand`]; removal is its own command that first
//! proves no reference remains. Free-form maps (`config`, `extensionData`) arrive
//! as canonical JSON text with the browser mapping's refusals.
use super::*;
use crate::facets::{Channel, FacetChannel, ValidationOptions};
use std::collections::BTreeMap;

#[derive(Clone)]
pub(super) enum MixedOp {
    Add(Box<MixedFilament>),
    Edit {
        id: MixedFilamentId,
        patch: Box<Patch>,
    },
    Duplicate {
        source: MixedFilamentId,
        duplicate: MixedFilamentId,
        name: Option<Vec<u16>>,
    },
    Enabled {
        id: MixedFilamentId,
        enabled: bool,
        reason: Vec<u16>,
    },
    Tombstone {
        id: MixedFilamentId,
        reason: Vec<u16>,
    },
}
/// `EditMixedFilamentPatch`; name and display colour are already trimmed.
#[derive(Clone, Default)]
pub(super) struct Patch {
    name: Option<Text>,
    display_color: Option<Text>,
    components: Option<List<MixedComponent>>,
    distribution: Option<MixedDistribution>,
    full_spectrum: Option<Arc<FullSpectrumRecipeState>>,
    config: Option<ConfigMap>,
}

fn u(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn field(name: &str, value: Value) -> (Vec<u16>, Value) {
    (u(name), value)
}
fn object(fields: impl IntoIterator<Item = (Vec<u16>, Value)>) -> Value {
    Value::Object(fields.into_iter().collect())
}
fn numbers(values: Vec<f64>) -> Value {
    Value::Array(values.into_iter().map(Value::Number).collect())
}
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
fn blank(units: &[u16]) -> bool {
    trim(units).is_empty()
}
fn domain<E>(parts: &[&[u16]]) -> CommandError<E> {
    CommandError::Domain(Text::new(parts.concat()))
}

/// Nesting limit for free-form JSON text (the browser's `JSON_TEXT_MAX_DEPTH`):
/// a map lands up to seven levels deep in the project state, which must stay
/// inside the canonical parser's own limit of 64.
const JSON_TEXT_MAX_DEPTH: usize = 16;
fn depth(value: &Value) -> usize {
    match value {
        Value::Array(items) => items.iter().map(|v| 1 + depth(v)).max().unwrap_or(0),
        Value::Object(fields) => fields.values().map(|v| 1 + depth(v)).max().unwrap_or(0),
        _ => 0,
    }
}
/// Canonical JSON text for a free-form object: well-formed UTF-16, the
/// canonical grammar, the nesting limit, and an object at the root.
pub(super) fn json_object(units: Vec<u16>) -> Result<JsonObject, PreparationError> {
    let source = String::from_utf16(&units).map_err(|_| PreparationError::InvalidIntent)?;
    let value =
        orcaxr_contracts::canonical::parse(&source).map_err(|_| PreparationError::InvalidIntent)?;
    if depth(&value) > JSON_TEXT_MAX_DEPTH || !matches!(value, Value::Object(_)) {
        return Err(PreparationError::InvalidIntent);
    }
    JsonObject::new(value).map_err(|_| PreparationError::InvalidIntent)
}
fn component_value(c: wire::MixedComponentInput) -> Result<Value, PreparationError> {
    let id: PhysicalFilamentId = id(c.filament_id)?;
    Ok(object([
        field("filamentId", Value::String(id.as_utf16().to_vec())),
        field("weight", Value::Number(c.weight)),
    ]))
}
fn components_value(components: Vec<wire::MixedComponentInput>) -> Result<Value, PreparationError> {
    Ok(Value::Array(
        components
            .into_iter()
            .map(component_value)
            .collect::<Result<_, _>>()?,
    ))
}
fn distribution_value(d: wire::MixedDistributionInput) -> Value {
    let optional = |name: &str, v: wire::OptionalFinite| match v {
        wire::OptionalFinite::Absent(_) => None,
        wire::OptionalFinite::Value(n) => Some(field(name, Value::Number(n))),
    };
    match d {
        wire::MixedDistributionInput::Ratio(_) => {
            object([field("mode", Value::String(u("ratio")))])
        }
        wire::MixedDistributionInput::Cycle(c) => object(
            [field("mode", Value::String(u("cycle")))]
                .into_iter()
                .chain(optional("cycleLengthMm", c.cycle_length_mm)),
        ),
        wire::MixedDistributionInput::Match(m) => object([
            field("mode", Value::String(u("match"))),
            field("targetColor", Value::String(m.target_color)),
        ]),
        wire::MixedDistributionInput::Gradient(g) => object(
            [
                field("mode", Value::String(u("gradient"))),
                field("startWeights", numbers(g.start_weights)),
                field("endWeights", numbers(g.end_weights)),
            ]
            .into_iter()
            .chain(optional("startZMm", g.start_z_mm))
            .chain(optional("endZMm", g.end_z_mm)),
        ),
    }
}
fn full_spectrum_value(f: wire::FullSpectrumInput) -> Result<Value, PreparationError> {
    let physical = |units: Vec<u16>| -> Result<Value, PreparationError> {
        let id: PhysicalFilamentId = id(units)?;
        Ok(Value::String(id.as_utf16().to_vec()))
    };
    let physical_list = |units: Vec<Vec<u16>>| -> Result<Value, PreparationError> {
        Ok(Value::Array(
            units.into_iter().map(physical).collect::<Result<_, _>>()?,
        ))
    };
    let ui_mode = match f.ui_mode {
        wire::FullSpectrumUiMode::Legacy => -1.0,
        wire::FullSpectrumUiMode::Ui0 => 0.0,
        wire::FullSpectrumUiMode::Ui1 => 1.0,
        wire::FullSpectrumUiMode::Ui2 => 2.0,
        wire::FullSpectrumUiMode::Ui3 => 3.0,
    };
    let distribution_mode = match f.distribution_mode {
        wire::FullSpectrumDistributionMode::M0 => 0.0,
        wire::FullSpectrumDistributionMode::M2 => 2.0,
    };
    Ok(object([
        field("schemaVersion", Value::Number(1.0)),
        field("upstreamStableId", Value::String(f.upstream_stable_id)),
        field("uiMode", Value::Number(ui_mode)),
        field("componentAId", physical(f.component_a_id)?),
        field("componentBId", physical(f.component_b_id)?),
        field("ratioA", Value::Number(f.ratio_a)),
        field("ratioB", Value::Number(f.ratio_b)),
        field("mixBPercent", Value::Number(f.mix_b_percent)),
        field(
            "manualPatternGroups",
            Value::Array(
                f.manual_pattern_groups
                    .into_iter()
                    .map(physical_list)
                    .collect::<Result<_, _>>()?,
            ),
        ),
        field(
            "gradientComponentIds",
            physical_list(f.gradient_component_ids)?,
        ),
        field(
            "gradientComponentWeights",
            numbers(f.gradient_component_weights),
        ),
        // Compiled out of the pinned engine, so never authored.
        field("pointillismAllFilaments", Value::Bool(false)),
        field("distributionMode", Value::Number(distribution_mode)),
        field("localZMaxSublayers", Value::Number(f.local_z_max_sublayers)),
        field("gradientEnabled", Value::Bool(f.gradient_enabled)),
        field("gradientStart", Value::Number(f.gradient_start)),
        field("gradientEnd", Value::Number(f.gradient_end)),
        field(
            "componentASurfaceOffsetMm",
            Value::Number(f.component_a_surface_offset_mm),
        ),
        field(
            "componentBSurfaceOffsetMm",
            Value::Number(f.component_b_surface_offset_mm),
        ),
        field("deleted", Value::Bool(f.deleted)),
        field("custom", Value::Bool(f.custom)),
        field("originAuto", Value::Bool(f.origin_auto)),
    ]))
}
fn decode<T: Decode>(value: Value) -> Result<T, PreparationError> {
    T::from_value(value).map_err(|_| PreparationError::InvalidIntent)
}

/// A complete recipe from its typed intent input.
pub(super) fn mixed_filament(
    f: wire::MixedFilamentInput,
) -> Result<MixedFilament, PreparationError> {
    let id: MixedFilamentId = id(f.mixed_filament_id)?;
    let mut fields = vec![
        field("id", Value::String(id.as_utf16().to_vec())),
        field("name", Value::String(f.name)),
        field("displayColor", Value::String(f.display_color)),
        field("components", components_value(f.components)?),
        field("distribution", distribution_value(f.distribution)),
        field("enabled", Value::Bool(f.enabled)),
    ];
    if let wire::OptionalFullSpectrum::Value(fs) = f.full_spectrum {
        fields.push(field("fullSpectrum", full_spectrum_value(fs)?));
    }
    fields.push(field("config", json_object(f.config_json)?.into_value()));
    if let wire::OptionalJsonText::Value(text) = f.extension_data_json {
        fields.push(field("extensionData", json_object(text)?.into_value()));
    }
    decode(object(fields))
}

impl MixedOp {
    pub(super) fn add(v: wire::AddMixedFilament) -> Result<(Self, Text), PreparationError> {
        let label = Text::new([&u("Add ")[..], &v.filament.name].concat());
        Ok((Self::Add(Box::new(mixed_filament(v.filament)?)), label))
    }
    pub(super) fn edit(v: wire::EditMixedFilament) -> Result<Self, PreparationError> {
        // The browser maps every field (invalid intents) before its
        // constructor refuses a blank name or colour.
        let mut patch = Patch::default();
        if let wire::OptionalMixedComponents::Value(components) = v.components {
            patch.components = Some(decode(components_value(components)?)?);
        }
        if let wire::OptionalMixedDistribution::Value(d) = v.distribution {
            patch.distribution = Some(decode(distribution_value(d))?);
        }
        if let wire::OptionalFullSpectrum::Value(fs) = v.full_spectrum {
            patch.full_spectrum = Some(decode(full_spectrum_value(fs)?)?);
        }
        if let wire::OptionalJsonText::Value(text) = v.config_json {
            patch.config = Some(json_object(text)?);
        }
        let id: MixedFilamentId = id(v.mixed_filament_id)?;
        if let wire::OptionalText::Value(name) = v.name {
            if blank(&name) {
                return Err(PreparationError::Domain(Text::from_utf8(
                    "Mixed filament name cannot be empty",
                )));
            }
            patch.name = Some(Text::new(trim(&name).to_vec()));
        }
        if let wire::OptionalText::Value(color) = v.display_color {
            if blank(&color) {
                return Err(PreparationError::Domain(Text::from_utf8(
                    "Mixed filament display color cannot be empty",
                )));
            }
            patch.display_color = Some(Text::new(trim(&color).to_vec()));
        }
        Ok(Self::Edit {
            id,
            patch: Box::new(patch),
        })
    }
    pub(super) fn duplicate(v: wire::DuplicateMixedFilament) -> Result<Self, PreparationError> {
        let source = id(v.source_id)?;
        let duplicate = id(v.duplicate_id)?;
        let name = match v.name {
            wire::OptionalText::Absent(_) => None,
            wire::OptionalText::Value(name) if blank(&name) => {
                return Err(PreparationError::Domain(Text::from_utf8(
                    "Duplicate mixed filament name cannot be empty",
                )));
            }
            wire::OptionalText::Value(name) => Some(name),
        };
        Ok(Self::Duplicate {
            source,
            duplicate,
            name,
        })
    }
    pub(super) fn enabled(v: wire::SetMixedFilamentEnabled) -> Result<Self, PreparationError> {
        Ok(Self::Enabled {
            id: id(v.mixed_filament_id)?,
            enabled: v.enabled,
            reason: match v.reason {
                wire::OptionalText::Absent(_) => u("user"),
                wire::OptionalText::Value(reason) => reason,
            },
        })
    }
    pub(super) fn tombstone(v: wire::TombstoneMixedFilament) -> Result<Self, PreparationError> {
        Ok(Self::Tombstone {
            id: id(v.mixed_filament_id)?,
            reason: match v.reason {
                wire::OptionalText::Absent(_) => u("user-delete"),
                wire::OptionalText::Value(reason) => reason,
            },
        })
    }
    pub(super) fn label(&self) -> Option<Text> {
        Some(Text::from_utf8(match self {
            Self::Add(_) => return None,
            Self::Edit { .. } => "Edit mixed filament",
            Self::Duplicate { .. } => "Duplicate mixed filament",
            Self::Enabled { enabled: true, .. } => "Enable mixed filament",
            Self::Enabled { enabled: false, .. } => "Disable mixed filament",
            Self::Tombstone { .. } => "Delete mixed filament",
        }))
    }
    pub(super) fn reason(&self) -> &'static str {
        match self {
            Self::Add(_) => "add-mixed-filament",
            Self::Edit { .. } => "edit-mixed-filament",
            Self::Duplicate { .. } => "duplicate-mixed-filament",
            Self::Enabled { .. } => "set-mixed-filament-enabled",
            Self::Tombstone { .. } => "tombstone-mixed-filament",
        }
    }
    pub(super) fn class(&self) -> &'static str {
        match self {
            Self::Add(_) => "AddMixedFilamentCommand",
            Self::Edit { .. } => "EditMixedFilamentCommand",
            Self::Duplicate { .. } => "DuplicateMixedFilamentCommand",
            Self::Enabled { .. } => "SetMixedFilamentEnabledCommand",
            Self::Tombstone { .. } => "TombstoneMixedFilamentCommand",
        }
    }

    pub(super) fn mutate<E>(&self, state: &mut ProjectState) -> Result<(), CommandError<E>> {
        let mut mixed = state.filaments.mixed.to_vec();
        match self {
            Self::Add(filament) => {
                assert_new_id(state, filament.id.as_utf16())?;
                validate_components(state, &filament.components)?;
                validate_shape(filament)?;
                mixed.push(Arc::new(filament.as_ref().clone()));
            }
            Self::Edit { id, patch } => {
                let index = require(&mixed, id)?;
                let filament = Arc::make_mut(&mut mixed[index]);
                if let Some(components) = &patch.components {
                    validate_components(state, components)?;
                    filament.components = components.clone();
                }
                if let Some(name) = &patch.name {
                    filament.name = name.clone();
                }
                if let Some(color) = &patch.display_color {
                    filament.display_color = color.clone();
                }
                if let Some(distribution) = &patch.distribution {
                    filament.distribution = distribution.clone();
                }
                if let Some(full_spectrum) = &patch.full_spectrum {
                    filament.full_spectrum = Some(full_spectrum.clone());
                }
                if let Some(config) = &patch.config {
                    filament.config = config.clone();
                }
                validate_shape(filament)?;
            }
            Self::Duplicate {
                source,
                duplicate,
                name,
            } => {
                let index = require(&mixed, source)?;
                assert_new_id(state, duplicate.as_utf16())?;
                let original = mixed[index].clone();
                validate_components(state, &original.components)?;
                validate_shape(&original)?;
                let mut copy = original.as_ref().clone();
                copy.id = duplicate.clone();
                copy.name = match name {
                    Some(name) => Text::new(trim(name).to_vec()),
                    None => Text::new([original.name.units(), &u(" copy")].concat()),
                };
                if let Some(full_spectrum) = &mut copy.full_spectrum {
                    let full_spectrum = Arc::make_mut(full_spectrum);
                    full_spectrum.upstream_stable_id = Text::from_utf8(
                        &crate::filaments::auto_pairs::stable_numeric_id(duplicate.as_utf16()),
                    );
                    full_spectrum.custom = true;
                    full_spectrum.origin_auto = false;
                    full_spectrum.deleted = false;
                }
                mixed.insert(index + 1, Arc::new(copy));
            }
            Self::Enabled {
                id,
                enabled,
                reason,
            } => {
                let index = require(&mixed, id)?;
                if *enabled {
                    validate_components(state, &mixed[index].components)?;
                    validate_shape(&mixed[index])?;
                }
                let filament = Arc::make_mut(&mut mixed[index]);
                if *enabled && let Some(full_spectrum) = &mut filament.full_spectrum {
                    Arc::make_mut(full_spectrum).deleted = false;
                }
                filament.enabled = *enabled;
                let mut extension = extension_fields(&filament.extension_data);
                if *enabled {
                    if extension.remove(&u(LIFECYCLE)).is_some() {
                        filament.extension_data = if extension.is_empty() {
                            None
                        } else {
                            Some(json(extension)?)
                        };
                    }
                } else {
                    extension.insert(
                        u(LIFECYCLE),
                        lifecycle("disabled", reason, "tombstone-preserve-references"),
                    );
                    filament.extension_data = Some(json(extension)?);
                }
            }
            Self::Tombstone { id, reason } => {
                let index = require(&mixed, id)?;
                let filament = Arc::make_mut(&mut mixed[index]);
                filament.enabled = false;
                if let Some(full_spectrum) = &mut filament.full_spectrum {
                    Arc::make_mut(full_spectrum).deleted = true;
                }
                let mut extension = extension_fields(&filament.extension_data);
                extension.insert(
                    u(LIFECYCLE),
                    lifecycle(
                        "deleted",
                        reason,
                        "tombstone-preserve-references-and-auto-pair-origin",
                    ),
                );
                filament.extension_data = Some(json(extension)?);
            }
        }
        let mut filaments = state.filaments.clone();
        filaments.mixed = mixed.into();
        state.filaments = filaments;
        Ok(())
    }
}

const LIFECYCLE: &str = "orcaxrFilamentLifecycle";
fn lifecycle(state: &str, reason: &[u16], semantics: &str) -> Value {
    object([
        field("state", Value::String(u(state))),
        field("reason", Value::String(reason.to_vec())),
        field("semantics", Value::String(u(semantics))),
    ])
}
fn extension_fields(extension: &Option<JsonObject>) -> BTreeMap<Vec<u16>, Value> {
    match extension.as_ref().map(JsonObject::value) {
        Some(Value::Object(fields)) => fields.clone(),
        _ => BTreeMap::new(),
    }
}
fn json<E>(fields: BTreeMap<Vec<u16>, Value>) -> Result<JsonObject, CommandError<E>> {
    JsonObject::new(Value::Object(fields)).map_err(|_| non_serializable())
}
fn require<E>(
    mixed: &[Arc<MixedFilament>],
    id: &MixedFilamentId,
) -> Result<usize, CommandError<E>> {
    mixed
        .iter()
        .position(|f| &f.id == id)
        .ok_or_else(|| domain(&[&u("Unknown mixed filament "), id.as_utf16()]))
}
/// `assertNewMixedId`: the ID is unused anywhere in the project.
fn assert_new_id<E>(state: &ProjectState, id: &[u16]) -> Result<(), CommandError<E>> {
    if ids_in_use(state).contains(id) {
        return Err(domain(&[
            &u("Mixed filament ID "),
            id,
            &u(" already exists in the project"),
        ]));
    }
    Ok(())
}
/// `validateNewRecipeComponents`: unique, existing, enabled physical tools.
fn validate_components<E>(
    state: &ProjectState,
    components: &[MixedComponent],
) -> Result<(), CommandError<E>> {
    let mut seen: Vec<&[u16]> = Vec::new();
    for component in components {
        let id = component.filament_id.as_utf16();
        if seen.contains(&id) {
            return Err(domain(&[
                &u("Mixed filament component "),
                id,
                &u(" is duplicated"),
            ]));
        }
        seen.push(id);
        let filament = state
            .filaments
            .physical
            .iter()
            .find(|f| f.id.as_utf16() == id)
            .ok_or_else(|| domain(&[&u("Unknown mixed filament component "), id]))?;
        if !filament.enabled {
            return Err(domain(&[
                &u("Mixed filament component "),
                id,
                &u(" is disabled"),
            ]));
        }
    }
    Ok(())
}
/// `validateRecipeShape`.
fn validate_shape<E>(filament: &MixedFilament) -> Result<(), CommandError<E>> {
    let refuse = |message: &str| Err(CommandError::domain(message));
    if blank(filament.name.units()) {
        return refuse("Mixed filament name cannot be empty");
    }
    if blank(filament.display_color.units()) {
        return refuse("Mixed filament display color cannot be empty");
    }
    match &filament.distribution {
        MixedDistribution::Ratio(_) => Ok(()),
        MixedDistribution::Cycle(c) => match c.cycle_length_mm {
            // `!(length > 0)`, as the browser writes it.
            Some(length) if length.get() <= 0.0 || length.get().is_nan() => {
                refuse("Mixed filament cycle length must be greater than zero")
            }
            _ => Ok(()),
        },
        MixedDistribution::Match(m) => {
            if blank(m.target_color.units()) {
                return refuse("Mixed filament match target color cannot be empty");
            }
            Ok(())
        }
        MixedDistribution::Gradient(g) => {
            let range_ok = match (g.start_z_mm, g.end_z_mm) {
                (None, None) => true,
                (Some(start), Some(end)) => start.get() >= 0.0 && end.get() > start.get(),
                _ => false,
            };
            if !range_ok {
                return refuse("Mixed filament gradient range must satisfy 0 <= startZMm < endZMm");
            }
            let count = filament.components.len();
            if g.start_weights.len() != count || g.end_weights.len() != count {
                return refuse("Mixed filament gradient weights must match component count");
            }
            for (endpoint, weights) in [("start", &g.start_weights), ("end", &g.end_weights)] {
                if weights.iter().any(|w| w.get() < 0.0) {
                    return refuse(&format!(
                        "Mixed filament gradient {endpoint} weights must be finite and non-negative"
                    ));
                }
                if weights.iter().all(|w| w.get() == 0.0) {
                    return refuse(&format!(
                        "Mixed filament gradient {endpoint} weights need at least one positive value"
                    ));
                }
            }
            Ok(())
        }
    }
}
/// `RemoveMixedFilamentCommand`: removal only after a canonical dependency scan
/// finds no reference; undo restores the exact previous state.
#[derive(Clone)]
pub(super) struct RemoveMixed {
    id: MixedFilamentId,
    previous: Option<ValidatedProject>,
}
impl RemoveMixed {
    pub(super) fn new(v: wire::RemoveMixedFilament) -> Result<Self, PreparationError> {
        Ok(Self {
            id: id(v.mixed_filament_id)?,
            previous: None,
        })
    }
    pub(super) fn apply<P: TimestampPolicy>(
        &mut self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let current = context.snapshot();
        let mut state = current.state().clone();
        let mut mixed = state.filaments.mixed.to_vec();
        let index = require(&mixed, &self.id)?;
        let paths = dependent_paths(&state, self.id.as_utf16())?;
        if !paths.is_empty() {
            let joined: Vec<u16> = paths.join(&u(", ")[..]);
            return Err(domain(&[
                &u("Mixed filament "),
                self.id.as_utf16(),
                &u(" is still referenced by: "),
                &joined,
            ]));
        }
        self.previous = Some(current.project().clone());
        mixed.remove(index);
        let mut filaments = state.filaments.clone();
        filaments.mixed = mixed.into();
        state.filaments = filaments;
        context.replace(state, reason, PROJECT)?;
        context.prune_selection();
        Ok(())
    }
    pub(super) fn revert<P: TimestampPolicy>(
        &self,
        context: &mut CommandContext<'_, P>,
        reason: Text,
    ) -> Result<(), CommandError<P::Error>> {
        let previous = self.previous.clone().ok_or_else(|| {
            CommandError::domain("RemoveMixedFilamentCommand has not been applied")
        })?;
        context.replace_validated(previous, reason, PROJECT)
    }
    pub(super) fn estimate(&self) -> std::io::Result<u64> {
        match &self.previous {
            Some(previous) => duplicate::canonical_length(previous.state()),
            None => Ok(1),
        }
    }
}

/// `findFilamentDependentPaths`: every canonical reference, sorted by UTF-16.
fn dependent_paths<E>(state: &ProjectState, id: &[u16]) -> Result<Vec<Vec<u16>>, CommandError<E>> {
    let mut paths: Vec<Vec<u16>> = Vec::new();
    let is =
        |candidate: &Option<FilamentId>| candidate.as_ref().is_some_and(|f| f.as_utf16() == id);
    for (p, plate) in state.plates.iter().enumerate() {
        if plate
            .wipe_tower
            .as_ref()
            .is_some_and(|t| is(&t.filament_id))
        {
            paths.push(u(&format!("plates[{p}].wipeTower.filamentId")));
        }
        for (o, object) in plate.objects.iter().enumerate() {
            let object_path = format!("plates[{p}].objects[{o}]");
            if is(&object.filament_id) {
                paths.push(u(&format!("{object_path}.filamentId")));
            }
            for (v, volume) in object.volumes.iter().enumerate() {
                let volume_path = format!("{object_path}.volumes[{v}]");
                if is(&volume.filament_id) {
                    paths.push(u(&format!("{volume_path}.filamentId")));
                }
                if let Value::Array(assignments) = volume.annotations.color.value() {
                    for (i, assignment) in assignments.iter().enumerate() {
                        if let Value::Object(a) = assignment
                            && matches!(a.get(&u("value")), Some(Value::String(v)) if v == id)
                        {
                            paths.push(u(&format!("{volume_path}.annotations.color[{i}].value")));
                        }
                    }
                }
                let encoding = match volume
                    .annotations
                    .refinement
                    .as_ref()
                    .map(JsonObject::value)
                {
                    Some(Value::Object(r)) => r.get(&u("color")),
                    _ => None,
                };
                if let Some(encoding) = encoding {
                    let triangle_count = match encoding {
                        Value::Object(e) => match e.get(&u("triangleCount")) {
                            Some(Value::Number(n)) => *n,
                            _ => volume.source.triangle_count.get(),
                        },
                        _ => volume.source.triangle_count.get(),
                    };
                    let channel = FacetChannel::decode(
                        Channel::Color,
                        volume.annotations.color.value(),
                        Some(encoding),
                        &ValidationOptions::new(triangle_count, ""),
                    )
                    .map_err(|_| CommandError::domain("Facet paint cannot be scanned"))?;
                    if let Some(encoding) = channel.encoding() {
                        encoding.visit_assigned(|value, path| {
                            if matches!(value, crate::facets::PaintValue::Text(v) if v.as_ref() == id) {
                                paths.push(u(&format!(
                                    "{volume_path}.annotations.refinement.color.{path}"
                                )));
                            }
                        });
                    }
                }
            }
            for (r, range) in object.layer_ranges.iter().enumerate() {
                if is(&range.filament_id) {
                    paths.push(u(&format!("{object_path}.layerRanges[{r}].filamentId")));
                }
            }
        }
    }
    for (f, filament) in state.filaments.mixed.iter().enumerate() {
        for (c, component) in filament.components.iter().enumerate() {
            if component.filament_id.as_utf16() == id {
                paths.push(u(&format!(
                    "filaments.mixed[{f}].components[{c}].filamentId"
                )));
            }
        }
    }
    paths.sort();
    Ok(paths)
}
