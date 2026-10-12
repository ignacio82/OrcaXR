//! The settings editor's host exchange. A host creates a draft editor from
//! generated contract values and reads fields, states, comparisons, commits,
//! steps and stepper rows back one contract value at a time. Collation and
//! search folding are the host's on every call that sorts or searches.
use super::{
    Field, GROUPS, Mode, PLACEMENTS, PanelModel, Requested, RowKind, Rows, SearchFolding, Step,
    StepRefusal, Surface, TABS, Technology,
    draft::{Change, DraftEditor, EditorError, Origin, ValueMap},
    fields::{Applicability, MatchField, Query, Support, field_index, query_fields},
    full_spectrum, step_value, stepper_rows,
};
use crate::settings::{
    SettingScope,
    options::{Issue, OptionValue, enum_choices, option_value},
    presets::Collation,
    projection_exchange,
    session::{Binding, OpenError, SettingsSession},
};
use crate::store::ProjectSnapshot;
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

/// Why an exchange call was refused. Refusals change nothing.
#[derive(Debug, Clone, PartialEq)]
pub enum Refusal<E> {
    /// Malformed JSON text in a request.
    InvalidRequest,
    /// The browser editor refuses these values (`message` says why).
    InvalidEditor(Vec<u16>),
    /// No definition has this field ID.
    UnknownField,
    /// A read past the latest query or rows.
    Range,
    /// A host policy failed.
    Host(E),
}
impl<E> Refusal<E> {
    pub fn code(&self) -> &'static str {
        match self {
            Self::InvalidRequest => "invalid_request",
            Self::InvalidEditor(_) => "invalid_editor",
            Self::UnknownField => "unknown_field",
            Self::Range => "invalid_range",
            Self::Host(_) => "host_policy_failed",
        }
    }
}

fn mode(m: &wire::EditorMode) -> Mode {
    match m {
        wire::EditorMode::Simple => Mode::Simple,
        wire::EditorMode::Advanced => Mode::Advanced,
        wire::EditorMode::Develop => Mode::Develop,
    }
}
fn wire_mode(m: Mode) -> wire::EditorMode {
    match m {
        Mode::Simple => wire::EditorMode::Simple,
        Mode::Advanced => wire::EditorMode::Advanced,
        Mode::Develop => wire::EditorMode::Develop,
    }
}
fn requested(t: &wire::EditorTechnology) -> Requested {
    match t {
        wire::EditorTechnology::Fff => Requested::Fff,
        wire::EditorTechnology::Sla => Requested::Sla,
        wire::EditorTechnology::Any => Requested::Any,
    }
}
fn surface(s: &wire::EditorSurface) -> Surface {
    match s {
        wire::EditorSurface::Process => Surface::Process,
        wire::EditorSurface::Filament => Surface::Filament,
        wire::EditorSurface::Printer => Surface::Printer,
        wire::EditorSurface::Object => Surface::Object,
        wire::EditorSurface::Plate => Surface::Plate,
    }
}
fn wire_surface(s: Surface) -> wire::EditorSurface {
    match s {
        Surface::Process => wire::EditorSurface::Process,
        Surface::Filament => wire::EditorSurface::Filament,
        Surface::Printer => wire::EditorSurface::Printer,
        Surface::Object => wire::EditorSurface::Object,
        Surface::Plate => wire::EditorSurface::Plate,
    }
}
fn optional_surface(s: &wire::OptionalEditorSurface) -> Option<Surface> {
    match s {
        wire::OptionalEditorSurface::Absent(_) => None,
        wire::OptionalEditorSurface::Value(s) => Some(surface(s)),
    }
}
pub fn scope(s: &wire::EditorScope) -> SettingScope {
    match s {
        wire::EditorScope::Project => SettingScope::Project,
        wire::EditorScope::Plate => SettingScope::Plate,
        wire::EditorScope::Object => SettingScope::Object,
        wire::EditorScope::Part => SettingScope::Part,
        wire::EditorScope::LayerRange => SettingScope::LayerRange,
    }
}
fn optional_scope(s: &wire::OptionalEditorScope) -> Option<SettingScope> {
    match s {
        wire::OptionalEditorScope::Absent(_) => None,
        wire::OptionalEditorScope::Value(s) => Some(scope(s)),
    }
}
fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn optional_units(units: Option<&[u16]>) -> wire::OptionalText {
    match units {
        Some(u) => wire::OptionalText::Value(u.to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
fn canonical_units(value: &Value) -> Vec<u16> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes)
        .expect("canonical JSON is UTF-8")
        .encode_utf16()
        .collect()
}
fn value_json(value: Option<&OptionValue>) -> wire::OptionalJsonText {
    match value {
        Some(v) => wire::OptionalJsonText::Value(canonical_units(&v.to_value())),
        None => wire::OptionalJsonText::Absent(wire::Empty {}),
    }
}
fn map_json(map: &ValueMap) -> Vec<u16> {
    canonical_units(&Value::Object(
        map.iter().map(|(k, v)| (k.clone(), v.to_value())).collect(),
    ))
}
/// A JSON object of engine values.
fn values<E>(units: &[u16]) -> Result<ValueMap, Refusal<E>> {
    let source = String::from_utf16(units).map_err(|_| Refusal::InvalidRequest)?;
    let Ok(Value::Object(fields)) = orcaxr_contracts::canonical::parse(&source) else {
        return Err(Refusal::InvalidRequest);
    };
    fields
        .into_iter()
        .map(|(k, v)| {
            option_value(&v)
                .map(|v| (k, v))
                .ok_or(Refusal::InvalidRequest)
        })
        .collect()
}
fn issues(list: &[Issue]) -> Vec<wire::EditorIssue> {
    list.iter()
        .map(|i| wire::EditorIssue {
            code: units(i.code),
            path: units(&i.path),
            message: i.message.clone(),
        })
        .collect()
}
fn refusal<E>(e: &EditorError<E>) -> wire::EditorRefusal {
    wire::EditorRefusal {
        message: e.message(),
        issues: match e {
            EditorError::Invalid(found) => issues(found),
            _ => Vec::new(),
        },
    }
}

/// `SettingsFieldProjection` as a contract value.
pub fn field(f: &Field) -> wire::EditorField {
    let d = f.definition();
    let location = |&i: &usize| {
        let p = &PLACEMENTS[i];
        let (tab, group) = (&TABS[p.tab], &GROUPS[p.group]);
        wire::EditorLocation {
            tab_id: units(tab.id),
            tab: units(tab.label),
            tab_order: u64::from(tab.order),
            group_id: units(group.id),
            group: units(group.label),
            group_order: u64::from(group.order),
            placement_id: units(p.id),
            order: u64::from(p.order),
            surface: wire_surface(p.surface),
        }
    };
    wire::EditorField {
        id: units(d.id),
        key: units(d.key),
        owner: units(d.owner),
        label: f.label.clone(),
        full_label: optional_units(f.full_label.as_deref()),
        category: f.category.clone(),
        tooltip: optional_units(f.tooltip.as_deref()),
        unit: optional_units(f.unit.as_deref()),
        mode: wire_mode(f.mode),
        technology: match f.technology {
            Technology::Unknown => wire::EditorDefinitionTechnology::Unknown,
            Technology::Any => wire::EditorDefinitionTechnology::Any,
            Technology::Fff => wire::EditorDefinitionTechnology::Fff,
            Technology::Sla => wire::EditorDefinitionTechnology::Sla,
        },
        applicability: match f.applicability {
            Applicability::Applicable => wire::EditorApplicability::Applicable,
            Applicability::NotApplicable => wire::EditorApplicability::NotApplicable,
            Applicability::Unknown => wire::EditorApplicability::Unknown,
        },
        support: match &f.support {
            Support::Implemented => wire::EditorSupport::Implemented(wire::Empty {}),
            Support::Unavailable(reason) => wire::EditorSupport::Unavailable(units(reason)),
        },
        locations: f.locations.iter().map(location).collect(),
        primary: match f
            .primary
            .and_then(|p| f.locations.iter().position(|l| *l == p))
        {
            Some(i) => wire::OptionalCounter::Value(i as u64),
            None => wire::OptionalCounter::Absent(wire::Empty {}),
        },
        enum_choices: enum_choices(d)
            .map(|(serialized, label)| wire::EditorChoice {
                serialized: units(serialized),
                label: units(label),
            })
            .collect(),
        matches: f
            .matches
            .iter()
            .map(|m| wire::EditorMatch {
                field: match m.field {
                    MatchField::Key => wire::EditorMatchField::Key,
                    MatchField::Label => wire::EditorMatchField::Label,
                    MatchField::FullLabel => wire::EditorMatchField::FullLabel,
                    MatchField::Category => wire::EditorMatchField::Category,
                    MatchField::Page => wire::EditorMatchField::Page,
                    MatchField::Group => wire::EditorMatchField::Group,
                    MatchField::Surface => wire::EditorMatchField::Surface,
                    MatchField::Tooltip => wire::EditorMatchField::Tooltip,
                    MatchField::Owner => wire::EditorMatchField::Owner,
                    MatchField::Alias => wire::EditorMatchField::Alias,
                    MatchField::Enum => wire::EditorMatchField::Enum,
                },
                start: m.start as u64,
                length: m.length as u64,
                text: m.text.clone(),
            })
            .collect(),
    }
}

/// A draft editor a host owns, with its latest query and rows.
pub struct HostEditor {
    /// The editor and the generated settings panel's drafts over it.
    panel: PanelModel,
    fields: Vec<Field>,
    rows: Rows,
    binding: Option<Binding>,
    intent: Option<wire::Intent>,
}

impl HostEditor {
    /// `new SettingsDraftEditor`: unknown keys and out-of-scope overrides
    /// refuse with the browser's message.
    pub fn create<E>(request: &wire::EditorCreate) -> Result<Self, Refusal<E>> {
        let editor = DraftEditor::new::<E>(
            mode(&request.mode),
            requested(&request.technology),
            optional_surface(&request.surface),
            optional_scope(&request.scope),
            values(&request.inherited_json)?,
            values(&request.overrides_json)?,
        )
        .map_err(|e| Refusal::InvalidEditor(e.message()))?;
        Ok(Self::with(editor, None))
    }
    fn with(editor: DraftEditor, binding: Option<Binding>) -> Self {
        Self {
            panel: PanelModel::new(editor),
            fields: Vec::new(),
            rows: Rows {
                rows: Vec::new(),
                unavailable: 0,
            },
            binding,
            intent: None,
        }
    }
    /// The editor a browser settings panel opens for one node of a captured
    /// project. An unknown node refuses with the browser's message.
    pub fn open<E>(
        snapshot: &ProjectSnapshot,
        request: &wire::SettingsSessionRequest,
    ) -> Result<Self, Refusal<E>> {
        let node =
            projection_exchange::target(&request.target).map_err(|_| Refusal::InvalidRequest)?;
        let session = SettingsSession::open::<E>(
            snapshot,
            &node,
            mode(&request.mode),
            requested(&request.technology),
        )
        .map_err(|e| match e {
            OpenError::UnknownTarget(unknown) => Refusal::InvalidEditor(unknown.message()),
            OpenError::Editor(e) => Refusal::InvalidEditor(e.message()),
        })?;
        Ok(Self::with(session.editor, Some(session.binding)))
    }
    /// The project intent of this editor's latest commit, for an editor
    /// opened on a project node.
    pub fn intent(&self) -> Option<&wire::Intent> {
        self.intent.as_ref()
    }
    pub fn editor(&self) -> &DraftEditor {
        self.panel.editor()
    }
    pub fn revision(&self) -> u64 {
        self.panel.editor().revision()
    }
    /// The overrides as canonical JSON.
    pub fn overrides_json(&self) -> Vec<u16> {
        map_json(self.panel.editor().overrides())
    }

    /// `projectSettingsFields`; the fields are then read one at a time.
    pub fn query<E, C, F>(
        &mut self,
        request: &wire::EditorQuery,
        collation: &mut C,
        folding: &mut F,
    ) -> Result<usize, Refusal<E>>
    where
        C: Collation<Error = E>,
        F: SearchFolding<Error = E>,
    {
        let query = Query {
            mode: mode(&request.mode),
            technology: requested(&request.technology),
            surface: optional_surface(&request.surface),
            scope: optional_scope(&request.scope),
            search: request.search.clone(),
            include_non_applicable: request.include_non_applicable,
            include_unknown_applicability: request.include_unknown_applicability,
            include_unavailable: request.include_unavailable,
        };
        self.fields = query_fields(&query, collation, folding).map_err(Refusal::Host)?;
        Ok(self.fields.len())
    }
    pub fn field(&self, index: usize) -> Option<wire::EditorField> {
        self.fields.get(index).map(field)
    }

    /// `getFieldState`.
    pub fn state<E>(
        &self,
        request: &wire::EditorFieldRef,
    ) -> Result<wire::EditorFieldState, Refusal<E>> {
        let id = String::from_utf16(&request.field_id).map_err(|_| Refusal::UnknownField)?;
        let s = self
            .panel
            .editor()
            .field_state::<E>(&id)
            .map_err(|_| Refusal::UnknownField)?;
        Ok(wire::EditorFieldState {
            field: field(&s.field),
            value_json: value_json(s.value.as_ref()),
            serialized: optional_units(s.serialized.as_deref()),
            origin: match s.origin {
                Origin::Changed => wire::EditorOrigin::Changed,
                Origin::Inherited => wire::EditorOrigin::Inherited,
                Origin::Default => wire::EditorOrigin::Default,
                Origin::Unset => wire::EditorOrigin::Unset,
            },
            has_local_override: s.has_local_override,
            changed: s.changed,
            draft_changed: s.draft_changed,
            draft_raw: optional_units(s.draft_raw.as_deref()),
            draft_value_json: value_json(s.draft_value.as_ref()),
            draft_serialized: optional_units(s.draft_serialized.as_deref()),
            issues: issues(&s.issues),
        })
    }
    /// `compare`.
    pub fn compare<E>(
        &self,
        request: &wire::EditorFieldRef,
    ) -> Result<wire::EditorComparison, Refusal<E>> {
        let id = String::from_utf16(&request.field_id).map_err(|_| Refusal::UnknownField)?;
        let c = self
            .panel
            .editor()
            .compare::<E>(&id)
            .map_err(|_| Refusal::UnknownField)?;
        Ok(wire::EditorComparison {
            field_id: units(c.field_id),
            key: units(c.key),
            default_json: value_json(c.default.as_ref()),
            inherited_json: value_json(c.inherited.as_ref()),
            override_json: value_json(c.overridden.as_ref()),
            effective_json: value_json(c.effective.as_ref()),
            draft_json: value_json(c.draft.as_ref()),
            effective_equals_default: c.effective_equals_default,
            draft_equals_effective: c.draft_equals_effective,
        })
    }
    /// `setDraft`, `clearDraft`, `resetToInherited` and `resetToDefault`; the
    /// browser's thrown errors are refusals with their messages.
    pub fn edit<E>(&mut self, edit: &wire::EditorEdit) -> wire::EditorEditResult {
        let id = |units: &[u16]| String::from_utf16_lossy(units);
        let editor = self.panel.editor_mut();
        let result = match edit {
            wire::EditorEdit::Set(e) => editor.set_draft::<E>(&id(&e.field_id), &e.raw),
            wire::EditorEdit::Clear(e) => editor.clear_draft::<E>(&id(&e.field_id)),
            wire::EditorEdit::Inherit(e) => editor.reset_to_inherited::<E>(&id(&e.field_id)),
            wire::EditorEdit::Reset(e) => editor.reset_to_default::<E>(&id(&e.field_id)),
        };
        match result {
            Ok(()) => wire::EditorEditResult::Applied(wire::Empty {}),
            Err(e) => wire::EditorEditResult::Refused(refusal(&e)),
        }
    }
    /// `commit`: drafts in collation order; any issue refuses the whole commit.
    pub fn commit<C: Collation>(
        &mut self,
        collation: &mut C,
    ) -> Result<wire::EditorCommitResult, Refusal<C::Error>> {
        match self.panel.editor_mut().commit(collation) {
            Err(EditorError::Collation(e)) => Err(Refusal::Host(e)),
            Err(e) => Ok(wire::EditorCommitResult::Refused(refusal(&e))),
            Ok(c) => {
                if let Some(binding) = &self.binding {
                    // Editor commits change each key once with its wire text.
                    self.intent = Some(binding.intent(&c).expect("editor commits apply"));
                }
                Ok(committed(c))
            }
        }
    }
}

/// The generated settings panel over this editor (`panel_exchange`).
impl HostEditor {
    /// What the panel shows for `{"mode","search"}`.
    pub fn panel_view<E, C, F>(
        &self,
        request: &str,
        collation: &mut C,
        folding: &mut F,
    ) -> Result<String, Refusal<E>>
    where
        C: Collation<Error = E>,
        F: SearchFolding<Error = E>,
    {
        super::panel_exchange::view_json(&self.panel, request, collation, folding)
    }
    /// One field's row for `{"fieldId"}`.
    pub fn panel_row<E>(&self, request: &str) -> Result<String, Refusal<E>> {
        super::panel_exchange::row_json(&self.panel, request)
    }
    /// A draft: set, inherited or reset to the default.
    pub fn panel_edit<E>(&mut self, request: &str) -> Result<String, Refusal<E>> {
        super::panel_exchange::edit_json(&mut self.panel, request)
    }
    /// Whether Apply has something valid to apply.
    pub fn panel_state<E>(&self) -> Result<String, Refusal<E>> {
        super::panel_exchange::state_json(&self.panel)
    }
    /// Apply: the drafts' one commit. For an editor opened on a project node,
    /// a commit that changes something becomes [Self::intent].
    pub fn panel_apply<C: Collation>(
        &mut self,
        collation: &mut C,
    ) -> Result<String, Refusal<C::Error>> {
        let (reply, commit) = super::panel_exchange::apply(&mut self.panel, collation)?;
        if let (Some(commit), Some(binding)) = (commit, &self.binding) {
            // Panel commits change each key once with its wire text.
            self.intent = Some(binding.intent(&commit).expect("panel commits apply"));
        }
        Ok(reply)
    }
    /// Cancel: every draft dropped.
    pub fn panel_cancel(&mut self) {
        self.panel.discard();
    }
}

fn committed(c: super::draft::Commit) -> wire::EditorCommitResult {
    wire::EditorCommitResult::Committed(wire::EditorCommit {
        base_revision: c.base_revision,
        revision: c.revision,
        changes: c
            .changes
            .iter()
            .map(|change| match change {
                Change::Set {
                    field_id,
                    key,
                    owner,
                    previous,
                    value,
                    serialized,
                } => wire::EditorChange {
                    field_id: units(field_id),
                    key: units(key),
                    owner: units(owner),
                    action: wire::EditorChangeAction::Set,
                    previous_json: value_json(previous.as_ref()),
                    value_json: value_json(Some(value)),
                    serialized: optional_units(Some(serialized)),
                },
                Change::Remove {
                    field_id,
                    key,
                    owner,
                    previous,
                } => wire::EditorChange {
                    field_id: units(field_id),
                    key: units(key),
                    owner: units(owner),
                    action: wire::EditorChangeAction::Remove,
                    previous_json: value_json(Some(previous)),
                    value_json: value_json(None),
                    serialized: optional_units(None),
                },
            })
            .collect(),
        next_overrides_json: map_json(&c.next_overrides),
    })
}

impl HostEditor {
    /// `ScopedSettingsStepper.build` for this editor; rows are then read one
    /// at a time.
    pub fn rows<E, C, F>(
        &mut self,
        request: &wire::EditorRowsRequest,
        collation: &mut C,
        folding: &mut F,
    ) -> Result<usize, Refusal<E>>
    where
        C: Collation<Error = E>,
        F: SearchFolding<Error = E>,
    {
        self.rows = stepper_rows(
            self.panel.editor(),
            scope(&request.scope),
            collation,
            folding,
        )
        .map_err(|e| match e {
            EditorError::Collation(e) => Refusal::Host(e),
            other => Refusal::InvalidEditor(other.message()),
        })?;
        Ok(self.rows.rows.len())
    }
    /// Fields the schema cannot support, counted rather than listed.
    pub fn unavailable(&self) -> usize {
        self.rows.unavailable
    }
    pub fn row(&self, index: usize) -> Option<wire::EditorRow> {
        let r = self.rows.rows.get(index)?;
        let d = r.field.definition();
        let finite = |n: Option<f64>| match n {
            Some(n) => wire::OptionalFinite::Value(n),
            None => wire::OptionalFinite::Absent(wire::Empty {}),
        };
        Some(wire::EditorRow {
            field: field(&r.field),
            group: r.group.clone(),
            value: r.value.clone(),
            overridden: r.overridden,
            steppable: r.refusal.is_none(),
            reason: optional_units(r.refusal.map(|x| units(x.reason())).as_deref()),
            kind: match r.kind {
                RowKind::Numeric => wire::EditorRowKind::Numeric,
                RowKind::Bool => wire::EditorRowKind::Bool,
                RowKind::Enum => wire::EditorRowKind::Enum,
                RowKind::Text => wire::EditorRowKind::Text,
                RowKind::ReadOnly => wire::EditorRowKind::ReadOnly,
            },
            minimum: finite(d.min),
            maximum: finite(d.max),
            integer: d.option_type == crate::settings::options::OptionType::CoInt,
            typeable: r.kind != RowKind::ReadOnly,
        })
    }
}

/// `stepSettingValue`.
pub fn step<E>(request: &wire::EditorStepRequest) -> Result<wire::EditorStep, Refusal<E>> {
    let id = String::from_utf16(&request.field_id).map_err(|_| Refusal::UnknownField)?;
    let index = field_index(&id).ok_or(Refusal::UnknownField)?;
    Ok(match step_value(index, &request.current, request.up) {
        Step::Value(v) => wire::EditorStep::Value(v),
        Step::Refused(r) => wire::EditorStep::Refused(wire::EditorStepRefusal {
            code: match r {
                StepRefusal::NotNumeric => wire::EditorStepRefusalCode::NotNumeric,
                StepRefusal::Unbounded => wire::EditorStepRefusalCode::Unbounded,
                StepRefusal::Unreadable => wire::EditorStepRefusalCode::Unreadable,
                StepRefusal::ReadOnly => wire::EditorStepRefusalCode::ReadOnly,
            },
            reason: units(r.reason()),
        }),
        Step::Codec(found) => wire::EditorStep::Codec(crate::settings::options::joined(&found)),
    })
}

/// The Full Spectrum rules for one transaction and key.
pub fn rules<E>(request: &wire::EditorRuleRequest) -> Result<wire::EditorRules, Refusal<E>> {
    let effective = values(&request.effective_json)?;
    Ok(wire::EditorRules {
        expansion: match full_spectrum::expand_transaction(&request.changed_keys, &effective) {
            Ok(e) => wire::EditorExpansionResult::Expanded(wire::EditorExpansion {
                effective_json: map_json(&e.effective),
                implicit: e
                    .implicit
                    .iter()
                    .map(|(key, value)| wire::EditorImplicitValue {
                        key: units(key),
                        value: *value,
                    })
                    .collect(),
            }),
            Err(e) => wire::EditorExpansionResult::Refused(units(&e.message())),
        },
        dependency: match full_spectrum::dependency(&request.key, &effective) {
            Some(d) => wire::EditorDependency::Enabled(d.enabled),
            None => wire::EditorDependency::Unmanaged(wire::Empty {}),
        },
        cross_field: optional_units(full_spectrum::cross_field_issue(&effective).as_deref()),
        structured_editor: optional_units(
            full_spectrum::requires_structured_editor(&request.key)
                .then(|| units(full_spectrum::STRUCTURED_EDITOR_REASON))
                .as_deref(),
        ),
    })
}
