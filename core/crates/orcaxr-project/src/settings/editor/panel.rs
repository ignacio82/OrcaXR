//! `settingsPanel.ts`: the generated settings panel's model. Which fields a
//! detail level and a search show and how they are grouped, the control each
//! field needs and what it holds, its badges, notes and issues, and the
//! panel's drafts — set, inherited, reset to the generated default, each
//! widened by the reviewed Full Spectrum rules — up to the one validated
//! commit Apply submits. Words the browser translates are left to the host
//! (a row names them by code); words it writes in English are part of the
//! model, in its words.
use super::{
    GROUPS, Mode, PLACEMENTS, PRESENTATION, SearchFolding, TABS,
    draft::{Commit, DraftEditor, EditorError, FieldState, Origin, ValueMap},
    fields::{Applicability, Query, Support, query_fields},
    full_spectrum::{
        self, CROSS_FIELD_CODE, DEFINITIONS_KEY, Dependency, HEIGHT_LOWER_BOUND,
        HEIGHT_UPPER_BOUND, LOCAL_Z_DEPENDENT_KEYS, LOCAL_Z_DIRECT_MULTICOLOR, LOCAL_Z_INFILL,
        LOCAL_Z_MODE, LOCAL_Z_WHOLE_OBJECTS, ModeNotBoolean, STRUCTURED_EDITOR_ID,
    },
    units,
};
use crate::{
    js_math::{
        self,
        convert::{json_stringify, number_to_string},
    },
    settings::{
        SettingScope,
        options::{self, Issue, OptionValue, Shape, ValueType, enum_choices},
        presets::Collation,
    },
};

/// `FULL_SPECTRUM_KEYS`, in declaration order.
const FULL_SPECTRUM_KEYS: [&str; 7] = [
    LOCAL_Z_MODE,
    LOCAL_Z_WHOLE_OBJECTS,
    LOCAL_Z_INFILL,
    LOCAL_Z_DIRECT_MULTICOLOR,
    HEIGHT_LOWER_BOUND,
    HEIGHT_UPPER_BOUND,
    DEFINITIONS_KEY,
];
/// What the structured editor's output shows in place of a control.
pub const STRUCTURED_EDITOR_VALUE: &str = "Use the structured FullSpectrum recipe editor";
/// `FullSpectrumSpecialEditorRequirement.kind`.
pub const STRUCTURED_EDITOR_KIND: &str = "structured-editor-required";

/// One field's pending change.
#[derive(Debug, Clone, PartialEq)]
pub enum PanelDraft {
    Set(Vec<u16>),
    Remove,
}

/// `SettingsPanelIssue`.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelIssue {
    pub code: &'static str,
    pub message: Vec<u16>,
}

/// `SettingsPanelControl`.
#[derive(Debug, Clone, PartialEq)]
pub enum Control {
    Structured,
    Locked(Vec<u16>),
    Checkbox(bool),
    Select {
        value: Vec<u16>,
        nil: Option<&'static str>,
        choices: Vec<(&'static str, &'static str)>,
    },
    Textarea {
        value: Vec<u16>,
        rows: u32,
    },
    Text {
        value: Vec<u16>,
        input_mode: Option<&'static str>,
        spellcheck: bool,
    },
}

/// `SettingsPanelRow`.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelRow {
    pub index: usize,
    pub label: Vec<u16>,
    pub unit: Option<Vec<u16>>,
    pub tooltip: Option<Vec<u16>>,
    pub support: String,
    pub applicability: &'static str,
    pub editable: bool,
    pub dependency_enabled: bool,
    pub control: Control,
    pub origin: Origin,
    pub draft_changed: bool,
    /// `structured-editor` or `unavailable`.
    pub availability: Option<&'static str>,
    pub inherit: bool,
    pub use_default: bool,
    /// The schema's reason and the sentence the panel shows.
    pub unavailable: Option<(String, Vec<u16>)>,
    pub structured_editor: bool,
    pub dependency_controller: Option<&'static str>,
    pub issues: Vec<PanelIssue>,
}

/// `SettingsPanelSection`.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelSection {
    pub id: Vec<u16>,
    pub label: Vec<u16>,
    /// The first field's placement: surface, tab and group labels.
    pub location: Option<(&'static str, &'static str, &'static str)>,
    pub rows: Vec<PanelRow>,
}

/// `SettingsPanelView`.
#[derive(Debug, Clone, PartialEq)]
pub struct PanelView {
    pub shown: usize,
    pub unavailable: usize,
    pub sections: Vec<PanelSection>,
}
impl PanelView {
    /// "n settings shown; m unavailable."
    pub fn summary(&self) -> String {
        format!(
            "{} setting{} shown; {} unavailable.",
            self.shown,
            if self.shown == 1 { "" } else { "s" },
            self.unavailable
        )
    }
}

/// `SettingsPanelDraftState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PanelState {
    pub changed: bool,
    pub invalid: bool,
}

/// What a panel edit or Apply threw: the editor's error or the Full
/// Spectrum expansion's `TypeError`.
#[derive(Debug, Clone, PartialEq)]
pub enum PanelError<E> {
    Editor(EditorError<E>),
    Expansion(ModeNotBoolean),
}
impl<E> PanelError<E> {
    pub fn message(&self) -> Vec<u16> {
        match self {
            Self::Editor(e) => e.message(),
            Self::Expansion(e) => units(&e.message()),
        }
    }
}
impl<E> From<EditorError<E>> for PanelError<E> {
    fn from(e: EditorError<E>) -> Self {
        Self::Editor(e)
    }
}

/// "Use default": drafted, or a default the codec could not write back.
#[derive(Debug, Clone, PartialEq)]
pub enum DefaultOutcome {
    Drafted,
    /// `Generated default for <key> could not be serialized`.
    Unserializable(String),
}

/// `SettingsPanelModel`: the node's draft editor and the drafts Apply commits.
#[derive(Debug, Clone)]
pub struct PanelModel {
    base: DraftEditor,
    editor: DraftEditor,
    /// In first-drafted order; drafting a field again keeps its place.
    drafts: Vec<(usize, PanelDraft)>,
}

fn field_id(index: usize) -> &'static str {
    options::DEFINITIONS[index].id
}
/// `catalog.has(key) && catalog.all(key).length === 1`, as the one definition.
fn single(key: &str) -> Option<usize> {
    let key = units(key);
    let mut found = options::DEFINITIONS
        .iter()
        .enumerate()
        .filter(|(_, d)| units(d.key) == key)
        .map(|(i, _)| i);
    let first = found.next()?;
    found.next().is_none().then_some(first)
}

impl PanelModel {
    /// The panel over [editor], a freshly opened node with no drafts.
    pub fn new(editor: DraftEditor) -> Self {
        Self {
            base: editor.clone(),
            editor,
            drafts: Vec::new(),
        }
    }
    pub fn editor(&self) -> &DraftEditor {
        &self.editor
    }
    pub fn editor_mut(&mut self) -> &mut DraftEditor {
        &mut self.editor
    }
    /// Field indices with a draft, in first-drafted order.
    pub fn drafts(&self) -> impl Iterator<Item = (usize, &PanelDraft)> {
        self.drafts.iter().map(|(i, d)| (*i, d))
    }
    pub fn has_drafts(&self) -> bool {
        !self.drafts.is_empty()
    }

    /// `view`: what the panel shows for a detail level and a search.
    pub fn view<E, C, F>(
        &self,
        mode: Mode,
        search: &[u16],
        collation: &mut C,
        folding: &mut F,
    ) -> Result<PanelView, PanelError<E>>
    where
        C: Collation<Error = E>,
        F: SearchFolding<Error = E>,
    {
        let query = Query {
            mode,
            technology: self.editor.technology,
            surface: self.editor.surface,
            scope: self.editor.scope,
            search: search.to_vec(),
            include_non_applicable: false,
            include_unknown_applicability: true,
            include_unavailable: true,
        };
        let fields = query_fields(&query, collation, folding)
            .map_err(|e| PanelError::Editor(EditorError::Collation(e)))?;
        let unavailable = fields
            .iter()
            .filter(|f| {
                f.support != Support::Implemented
                    || full_spectrum::requires_structured_editor(&units(f.definition().key))
            })
            .count();
        let full_spectrum = full_spectrum_values(&self.editor)?;
        let mut sections: Vec<PanelSection> = Vec::new();
        for field in &fields {
            let (id, label, location) = match field.primary {
                Some(primary) => {
                    let placement = &PLACEMENTS[primary];
                    let (tab, group) = (&TABS[placement.tab], &GROUPS[placement.group]);
                    let label = [
                        surface_label(placement.surface.as_str()),
                        tab.label,
                        group.label,
                    ]
                    .into_iter()
                    .filter(|part| !part.is_empty())
                    .collect::<Vec<_>>()
                    .join(" \u{b7} ");
                    (
                        units(group.id),
                        units(&label),
                        Some((placement.surface.as_str(), tab.label, group.label)),
                    )
                }
                None => {
                    let mut id = units("metadata:");
                    id.extend(&field.category);
                    (id, field.category.clone(), None)
                }
            };
            let row = self.row_of(field.index, &full_spectrum)?;
            match sections.iter_mut().find(|s| s.id == id) {
                Some(section) => section.rows.push(row),
                None => sections.push(PanelSection {
                    id,
                    label,
                    location,
                    rows: vec![row],
                }),
            }
        }
        Ok(PanelView {
            shown: fields.len(),
            unavailable,
            sections,
        })
    }

    /// `row`: one field as it stands now.
    pub fn row<E>(&self, field_id: &str) -> Result<PanelRow, PanelError<E>> {
        let state = self.editor.field_state(field_id)?;
        let full_spectrum = full_spectrum_values(&self.editor)?;
        self.row_of(state.field.index, &full_spectrum)
    }

    fn row_of<E>(&self, index: usize, full_spectrum: &ValueMap) -> Result<PanelRow, PanelError<E>> {
        let state = self.editor.field_state(field_id(index))?;
        let field = &state.field;
        let key = units(field.definition().key);
        let special = full_spectrum::requires_structured_editor(&key);
        let dependency: Option<Dependency> = full_spectrum::dependency(&key, full_spectrum);
        let editable = field.support == Support::Implemented && !special;
        let mut issues: Vec<PanelIssue> = state
            .issues
            .iter()
            .map(|i| PanelIssue {
                code: i.code,
                message: i.message.clone(),
            })
            .collect();
        if [HEIGHT_LOWER_BOUND, HEIGHT_UPPER_BOUND]
            .iter()
            .any(|k| units(k) == key)
            && let Some(message) = full_spectrum::cross_field_issue(full_spectrum)
        {
            issues.push(PanelIssue {
                code: CROSS_FIELD_CODE,
                message,
            });
        }
        let unavailable = match &field.support {
            Support::Unavailable(reason) => Some((
                reason.clone(),
                units(&format!(
                    "Unavailable: {}",
                    format_unavailable_reason(Some(reason))
                )),
            )),
            Support::Implemented => None,
        };
        Ok(PanelRow {
            index,
            label: field.label.clone(),
            unit: field.unit.clone(),
            tooltip: field.tooltip.clone(),
            support: if special {
                STRUCTURED_EDITOR_KIND.to_owned()
            } else {
                match field.support {
                    Support::Implemented => "implemented",
                    Support::Unavailable(_) => "unavailable",
                }
                .to_owned()
            },
            applicability: match dependency {
                Some(d) if d.enabled => "applicable",
                Some(_) => "not-applicable",
                None => match field.applicability {
                    Applicability::Applicable => "applicable",
                    Applicability::NotApplicable => "not-applicable",
                    Applicability::Unknown => "unknown",
                },
            },
            editable,
            dependency_enabled: dependency.is_none_or(|d| d.enabled),
            control: control(index, &state, editable, special),
            origin: state.origin,
            draft_changed: state.draft_changed,
            availability: if special {
                Some("structured-editor")
            } else if unavailable.is_some() {
                Some("unavailable")
            } else {
                None
            },
            inherit: editable,
            use_default: editable && PRESENTATION[index].default.is_some(),
            unavailable,
            structured_editor: special,
            dependency_controller: dependency
                .filter(|d| !d.enabled)
                .map(|_| Dependency::CONTROLLER),
            issues,
        })
    }

    /// `set`: a typed value, drafted with the Full Spectrum values it implies.
    pub fn set<E>(&mut self, field_id: &str, raw: &[u16]) -> Result<(), PanelError<E>> {
        self.editor.set_draft::<E>(field_id, raw)?;
        let index = self.editor.field_state::<E>(field_id)?.field.index;
        record(&mut self.drafts, index, PanelDraft::Set(raw.to_vec()));
        self.expand_live(index)
    }
    /// `inherit`: "Use inherited".
    pub fn inherit<E>(&mut self, field_id: &str) -> Result<(), PanelError<E>> {
        self.editor.reset_to_inherited::<E>(field_id)?;
        let index = self.editor.field_state::<E>(field_id)?.field.index;
        record(&mut self.drafts, index, PanelDraft::Remove);
        self.expand_live(index)
    }
    /// `useDefault`: "Use default".
    pub fn use_default<E>(&mut self, field_id: &str) -> Result<DefaultOutcome, PanelError<E>> {
        self.editor.reset_to_default::<E>(field_id)?;
        let state = self.editor.field_state::<E>(field_id)?;
        let Some(serialized) = state.draft_serialized else {
            return Ok(DefaultOutcome::Unserializable(format!(
                "Generated default for {} could not be serialized",
                state.field.definition().key
            )));
        };
        let index = state.field.index;
        record(&mut self.drafts, index, PanelDraft::Set(serialized));
        self.expand_live(index)?;
        Ok(DefaultOutcome::Drafted)
    }
    fn expand_live<E>(&mut self, index: usize) -> Result<(), PanelError<E>> {
        let changed = [units(options::DEFINITIONS[index].key)];
        expand(&mut self.editor, Some(&mut self.drafts), &changed)
    }

    /// `state`: whether Apply has something valid to apply.
    pub fn state<E>(&self) -> Result<PanelState, PanelError<E>> {
        let mut changed = false;
        let mut invalid = false;
        for (index, _) in &self.drafts {
            let state = self.editor.field_state::<E>(field_id(*index))?;
            changed |= state.draft_changed;
            invalid |= !state.issues.is_empty();
        }
        invalid |=
            full_spectrum::cross_field_issue(&full_spectrum_values::<E>(&self.editor)?).is_some();
        Ok(PanelState { changed, invalid })
    }

    /// `prepare`: the one commit Apply submits.
    pub fn prepare<C: Collation>(&self, collation: &mut C) -> Result<Commit, PanelError<C::Error>> {
        let mut staging = self.base.clone();
        for (index, draft) in &self.drafts {
            match draft {
                PanelDraft::Set(raw) => staging.set_draft(field_id(*index), raw)?,
                PanelDraft::Remove => staging.reset_to_inherited(field_id(*index))?,
            }
        }
        let changed: Vec<Vec<u16>> = self
            .drafts
            .iter()
            .map(|(i, _)| units(options::DEFINITIONS[*i].key))
            .collect();
        expand(&mut staging, None, &changed)?;
        if let Some(message) = full_spectrum::cross_field_issue(&full_spectrum_values(&staging)?) {
            return Err(PanelError::Editor(EditorError::Invalid(vec![Issue {
                code: CROSS_FIELD_CODE,
                path: HEIGHT_UPPER_BOUND.to_owned(),
                message,
            }])));
        }
        Ok(staging.commit(collation)?)
    }

    /// `discard`: every draft dropped.
    pub fn discard(&mut self) {
        self.editor = self.base.clone();
        self.drafts.clear();
    }
}

fn record(drafts: &mut Vec<(usize, PanelDraft)>, index: usize, draft: PanelDraft) {
    match drafts.iter_mut().find(|(i, _)| *i == index) {
        Some(slot) => slot.1 = draft,
        None => drafts.push((index, draft)),
    }
}

/// `fullSpectrumValues`: the Full Spectrum keys as [editor] would apply them.
fn full_spectrum_values<E>(editor: &DraftEditor) -> Result<ValueMap, PanelError<E>> {
    let mut values = ValueMap::new();
    for key in FULL_SPECTRUM_KEYS {
        let Some(index) = single(key) else { continue };
        let state = editor.field_state::<E>(field_id(index))?;
        let value = if state.draft_raw.is_some() {
            state.draft_value
        } else {
            state.draft_value.or(state.value)
        };
        if let Some(value) = value {
            values.insert(units(key), value);
        }
    }
    Ok(values)
}

/// `expand`: the values the Full Spectrum rules add to a change, drafted in
/// [editor] and recorded in [drafts] when given.
fn expand<E>(
    editor: &mut DraftEditor,
    mut drafts: Option<&mut Vec<(usize, PanelDraft)>>,
    changed: &[Vec<u16>],
) -> Result<(), PanelError<E>> {
    let effective = full_spectrum_values(editor)?;
    let expansion =
        full_spectrum::expand_transaction(changed, &effective).map_err(PanelError::Expansion)?;
    for key in LOCAL_Z_DEPENDENT_KEYS {
        let Some((_, value)) = expansion.implicit.iter().find(|(k, _)| *k == key) else {
            continue;
        };
        let Some(index) = single(key) else { continue };
        let raw = units(if *value { "1" } else { "0" });
        editor.set_draft::<E>(field_id(index), &raw)?;
        if let Some(drafts) = drafts.as_deref_mut() {
            record(drafts, index, PanelDraft::Set(raw));
        }
    }
    Ok(())
}

/// `settingsPanelControl`.
fn control(index: usize, state: &FieldState, editable: bool, special: bool) -> Control {
    let d = &options::DEFINITIONS[index];
    if special {
        return Control::Structured;
    }
    let value = raw_value(state);
    if !editable {
        return Control::Locked(value);
    }
    if d.shape == Shape::Scalar && d.value_type == ValueType::Bool && !d.nullable {
        let on = |v: &Option<OptionValue>| *v == Some(OptionValue::Bool(true));
        return Control::Checkbox(
            on(&state.draft_value) || (state.draft_value.is_none() && on(&state.value)),
        );
    }
    if d.shape == Shape::Scalar && d.value_type == ValueType::Enum {
        return Control::Select {
            value,
            nil: d.nullable.then(|| d.nil_token.unwrap_or("nil")),
            choices: enum_choices(d).collect(),
        };
    }
    let p = &PRESENTATION[index];
    if d.value_type == ValueType::String && p.multiline {
        return Control::Textarea {
            value,
            rows: multiline_rows(p.height),
        };
    }
    Control::Text {
        value,
        input_mode: match d.value_type {
            ValueType::Int => Some("numeric"),
            ValueType::Float | ValueType::FloatOrPercent => Some("decimal"),
            _ => None,
        },
        spellcheck: d.value_type == ValueType::String,
    }
}

/// `settingsFieldRawValue`: the typed draft, else the value as the codec writes it.
pub fn raw_value(state: &FieldState) -> Vec<u16> {
    if let Some(raw) = &state.draft_raw {
        return raw.clone();
    }
    if let Some(serialized) = &state.draft_serialized {
        return serialized.clone();
    }
    if let Some(serialized) = &state.serialized {
        return serialized.clone();
    }
    // `draftValue ?? value`: a null draft falls back too.
    let value = match &state.draft_value {
        Some(OptionValue::Null) | None => state.value.as_ref(),
        Some(v) => Some(v),
    };
    match value {
        None => Vec::new(),
        Some(OptionValue::Text(text)) => text.clone(),
        Some(OptionValue::Number(n)) => units(&number_to_string(*n)),
        Some(OptionValue::Bool(b)) => units(if *b { "true" } else { "false" }),
        Some(other) => json_stringify(&other.to_value()),
    }
}

/// `settingsMultilineRows`: rows from the GUI height hint.
pub fn multiline_rows(height: Option<f64>) -> u32 {
    let rows = match height {
        None => 4.0,
        Some(h) if h > 30.0 => js_math::round(h / 20.0),
        Some(h) => js_math::round(h),
    };
    rows.clamp(3.0, 12.0) as u32
}

/// `settingsOriginLabel`.
pub fn origin_label(origin: Origin) -> &'static str {
    match origin {
        Origin::Changed => "Changed",
        Origin::Inherited => "Inherited",
        Origin::Default => "Default",
        Origin::Unset => "Unset",
    }
}

/// `guiSurfaceLabel`.
pub fn surface_label(surface: &str) -> &str {
    match surface {
        "filament" => "Filament",
        "object" => "Object",
        "plate" => "Plate",
        "printer" => "Printer",
        "process" => "Process",
        other => other,
    }
}

/// `formatUnavailableReason`.
pub fn format_unavailable_reason(reason: Option<&str>) -> String {
    let Some(reason) = reason.filter(|r| !r.is_empty()) else {
        return "the generated schema does not provide a safe editable contract".to_owned();
    };
    if let Some(widget) = reason.strip_prefix("special-widget:") {
        return format!("requires the unimplemented {widget} generated widget");
    }
    if let Some(surface) = reason.strip_prefix("gui-surface-unavailable:") {
        return format!(
            "belongs to another settings scope; this panel may edit only the {} surface",
            surface_label(surface)
        );
    }
    match reason {
        "ambiguous-key-owners" => {
            "the engine key has multiple owners and cannot be selected safely".to_owned()
        }
        "conditional-enum-domain" => {
            "the enum domain depends on runtime state that is not generated yet".to_owned()
        }
        "custom-tab-widget" => {
            "the pinned Tab.cpp uses a custom widget whose behavior is not generated yet".to_owned()
        }
        "no-literal-gui-placement" => {
            "the pinned GUI inventory has no unambiguous literal placement for this field"
                .to_owned()
        }
        "readonly" => "the engine marks this field read-only".to_owned(),
        "unknown-technology-applicability" => {
            "the generated schema cannot prove this field applies to this technology".to_owned()
        }
        other => other.replace('-', " "),
    }
}

/// `scopedSettingsScopeLabel`: the scoped panel's name for a scope.
pub fn scope_label(scope: SettingScope) -> &'static str {
    match scope {
        SettingScope::Project => "Project",
        SettingScope::Plate => "Plate",
        SettingScope::Object => "Object",
        SettingScope::Part => "Part",
        SettingScope::LayerRange => "Height range",
    }
}
/// `scopedSettingsOptionText`: `Object: Plate 1 › Cube — 2 overrides`.
pub fn option_text(scope: SettingScope, path: &[u16], override_count: u64) -> Vec<u16> {
    let mut out = units(&format!("{}: ", scope_label(scope)));
    out.extend_from_slice(path);
    if override_count > 0 {
        out.extend(units(&format!(
            " \u{2014} {override_count} override{}",
            if override_count == 1 { "" } else { "s" }
        )));
    }
    out
}
/// `scopedSettingsSummary`: what a scope's values do.
pub fn summary(scope: SettingScope) -> String {
    match scope {
        SettingScope::Project => {
            "Applies to every plate unless a narrower scope overrides it.".to_owned()
        }
        other => format!(
            "Overrides the {}'s inherited values. {}",
            scope_label(other).to_lowercase(),
            if other == SettingScope::Part {
                "A height range crossing this part wins over it, as it does in the engine."
            } else {
                "Only settings the engine reads at this scope are listed."
            }
        ),
    }
}
/// `scopedSettingsHeading`: `Object settings — Cube`.
pub fn heading(scope: SettingScope, label: &[u16]) -> Vec<u16> {
    let mut out = units(&format!("{} settings \u{2014} ", scope_label(scope)));
    out.extend_from_slice(label);
    out
}

/// The structured editor that owns the Full Spectrum recipes.
pub fn structured_editor_id() -> &'static str {
    STRUCTURED_EDITOR_ID
}
