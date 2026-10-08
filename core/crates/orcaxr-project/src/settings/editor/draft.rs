//! `SettingsDraftEditor.ts`: one draft over inherited values and this node's
//! overrides, validated by the generated codec and committed in one step.
use super::{
    Mode, Requested, Surface,
    fields::{
        Field, Query, Support, assess_support, default_value, field_index, has_key, project_field,
    },
    units,
};
use crate::{
    js_math::convert::{js_keys, json_stringify},
    settings::{
        SettingScope,
        options::{
            DEFINITIONS, Definition, Issue, OptionValue, joined, parse_setting_draft,
            serialize_setting_value, validate_setting_value,
        },
        presets::Collation,
    },
};
use orcaxr_contracts::canonical::Value;
use std::{cmp::Ordering, collections::BTreeMap};

/// Engine values by key.
pub type ValueMap = BTreeMap<Vec<u16>, OptionValue>;

/// A pending edit of one field.
#[derive(Debug, Clone, PartialEq)]
pub enum DraftOperation {
    Set(Vec<u16>),
    Remove,
}
/// `SettingsValueOrigin`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    Changed,
    Inherited,
    Default,
    Unset,
}
impl Origin {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Changed => "changed",
            Self::Inherited => "inherited",
            Self::Default => "default",
            Self::Unset => "unset",
        }
    }
}
/// `SettingsFieldState`.
#[derive(Debug, Clone, PartialEq)]
pub struct FieldState {
    pub field: Field,
    pub value: Option<OptionValue>,
    pub serialized: Option<Vec<u16>>,
    pub origin: Origin,
    pub has_local_override: bool,
    pub changed: bool,
    pub draft_changed: bool,
    pub draft_raw: Option<Vec<u16>>,
    pub draft_value: Option<OptionValue>,
    pub draft_serialized: Option<Vec<u16>>,
    pub issues: Vec<Issue>,
}
/// `SettingsFieldComparison`.
#[derive(Debug, Clone, PartialEq)]
pub struct Comparison {
    pub field_id: &'static str,
    pub key: &'static str,
    pub default: Option<OptionValue>,
    pub inherited: Option<OptionValue>,
    pub overridden: Option<OptionValue>,
    pub effective: Option<OptionValue>,
    pub draft: Option<OptionValue>,
    pub effective_equals_default: bool,
    pub draft_equals_effective: bool,
}
/// `SettingsDraftChange`.
#[derive(Debug, Clone, PartialEq)]
pub enum Change {
    Set {
        field_id: &'static str,
        key: &'static str,
        owner: &'static str,
        previous: Option<OptionValue>,
        value: OptionValue,
        serialized: Vec<u16>,
    },
    Remove {
        field_id: &'static str,
        key: &'static str,
        owner: &'static str,
        previous: OptionValue,
    },
}
/// `SettingsDraftCommit`.
#[derive(Debug, Clone, PartialEq)]
pub struct Commit {
    pub base_revision: u64,
    pub revision: u64,
    pub changes: Vec<Change>,
    pub next_overrides: ValueMap,
}

/// What the browser editor throws, with its message.
#[derive(Debug, Clone, PartialEq)]
pub enum EditorError<E> {
    UnknownField(String),
    UnknownSetting {
        layer: &'static str,
        key: Vec<u16>,
    },
    /// A stored override the scope never reads.
    StoredOutOfScope {
        key: Vec<u16>,
        scope: SettingScope,
    },
    /// An edit the scope never reads.
    OutOfScope {
        key: &'static str,
        scope: SettingScope,
    },
    Unavailable {
        key: &'static str,
        reason: String,
    },
    NoDefault {
        key: &'static str,
    },
    /// `SettingsDraftCommitError`.
    Invalid(Vec<Issue>),
    /// `SettingsCodecError`: the codec refused a value it was asked to write.
    Codec(Vec<Issue>),
    Collation(E),
}
impl<E> EditorError<E> {
    /// The thrown `Error.message`.
    pub fn message(&self) -> Vec<u16> {
        let quoted = |units: &[u16]| json_stringify(&Value::String(units.to_vec()));
        let mut out = Vec::new();
        let mut s = |text: &str| out.extend(text.encode_utf16());
        match self {
            Self::UnknownField(id) => {
                s("Unknown settings field ");
                out.extend(quoted(&units(id)));
            }
            Self::UnknownSetting { layer, key } => {
                s(&format!("Unknown {layer} setting "));
                out.extend(quoted(key));
            }
            Self::StoredOutOfScope { key, scope } => {
                s("Setting ");
                out.extend(quoted(key));
                out.extend(units(&format!(
                    " cannot be overridden at the {} scope",
                    scope.as_str()
                )));
            }
            Self::OutOfScope { key, scope } => {
                s(&format!(
                    "Setting {key} cannot be overridden at the {} scope",
                    scope.as_str()
                ));
            }
            Self::Unavailable { key, reason } => {
                s(&format!("Setting {key} is unavailable: {reason}"))
            }
            Self::NoDefault { key } => s(&format!("Setting {key} has no generated default")),
            Self::Invalid(issues) => s(&format!(
                "Settings draft contains {} validation issue{}",
                issues.len(),
                if issues.len() == 1 { "" } else { "s" }
            )),
            Self::Codec(issues) => out.extend(joined(issues)),
            Self::Collation(_) => s("Collation failed"),
        }
        out
    }
}

/// `valuesEqual`: the browser compares `JSON.stringify` texts, which equal
/// structural equality for engine values (`-0` prints as `0`).
fn values_equal(left: Option<&OptionValue>, right: Option<&OptionValue>) -> bool {
    left == right
}

/// `SettingsDraftEditor`.
#[derive(Debug, Clone)]
pub struct DraftEditor {
    pub mode: Mode,
    pub technology: Requested,
    pub surface: Option<Surface>,
    pub scope: Option<SettingScope>,
    inherited: ValueMap,
    overrides: ValueMap,
    /// In insertion order; setting a field again keeps its position.
    drafts: Vec<(usize, DraftOperation)>,
    revision: u64,
}

impl DraftEditor {
    /// Unknown keys in either layer, and overrides the scope never reads, are
    /// refused in JavaScript property order.
    pub fn new<E>(
        mode: Mode,
        technology: Requested,
        surface: Option<Surface>,
        scope: Option<SettingScope>,
        inherited: ValueMap,
        overrides: ValueMap,
    ) -> Result<Self, EditorError<E>> {
        for (layer, values) in [("inherited", &inherited), ("overrides", &overrides)] {
            if let Some(key) = js_keys(values).into_iter().find(|k| !has_key(k)) {
                return Err(EditorError::UnknownSetting {
                    layer,
                    key: key.clone(),
                });
            }
        }
        if let Some(scope) = scope
            && let Some(key) = js_keys(&overrides).into_iter().find(|k| !scope.allows(k))
        {
            return Err(EditorError::StoredOutOfScope {
                key: key.clone(),
                scope,
            });
        }
        Ok(Self {
            mode,
            technology,
            surface,
            scope,
            inherited,
            overrides,
            drafts: Vec::new(),
            revision: 0,
        })
    }
    pub fn revision(&self) -> u64 {
        self.revision
    }
    pub fn overrides(&self) -> &ValueMap {
        &self.overrides
    }
    /// `query`: the editor's own mode, technology, surface and scope.
    pub fn query(&self) -> Query {
        Query {
            surface: self.surface,
            scope: self.scope,
            ..Query::new(self.mode, self.technology)
        }
    }

    fn definition<E>(&self, field_id: &str) -> Result<usize, EditorError<E>> {
        field_index(field_id).ok_or_else(|| EditorError::UnknownField(field_id.to_owned()))
    }
    fn editable<E>(&self, index: usize) -> Result<(), EditorError<E>> {
        let d = &DEFINITIONS[index];
        if let Some(scope) = self.scope
            && !scope.allows(&units(d.key))
        {
            return Err(EditorError::OutOfScope { key: d.key, scope });
        }
        match assess_support(index, self.surface) {
            Support::Implemented => Ok(()),
            Support::Unavailable(reason) => Err(EditorError::Unavailable { key: d.key, reason }),
        }
    }
    fn base(&self, index: usize) -> (Option<OptionValue>, Origin) {
        let key = units(DEFINITIONS[index].key);
        if let Some(value) = self.inherited.get(&key) {
            return (Some(value.clone()), Origin::Inherited);
        }
        match default_value(index) {
            Some(value) => (Some(value), Origin::Default),
            None => (None, Origin::Unset),
        }
    }
    fn draft(&self, index: usize) -> Option<&DraftOperation> {
        self.drafts
            .iter()
            .find(|(i, _)| *i == index)
            .map(|(_, d)| d)
    }
    fn put(&mut self, index: usize, operation: DraftOperation) {
        match self.drafts.iter_mut().find(|(i, _)| *i == index) {
            Some(slot) => slot.1 = operation,
            None => self.drafts.push((index, operation)),
        }
    }

    /// `getFieldState`.
    pub fn field_state<E>(&self, field_id: &str) -> Result<FieldState, EditorError<E>> {
        let index = self.definition(field_id)?;
        let d: &Definition = &DEFINITIONS[index];
        let field = project_field(index, self.technology, self.surface);
        let (base, base_origin) = self.base(index);
        let key = units(d.key);
        let overridden = self.overrides.get(&key).cloned();
        let has_override = overridden.is_some();
        let effective = if has_override {
            overridden.clone()
        } else {
            base.clone()
        };
        let origin = if !has_override || values_equal(overridden.as_ref(), base.as_ref()) {
            base_origin
        } else {
            Origin::Changed
        };
        let mut issues = effective
            .as_ref()
            .map_or_else(Vec::new, |value| validate_setting_value(d, value));
        let draft = self.draft(index);
        let (mut draft_value, mut draft_serialized, mut draft_issues) = (None, None, Vec::new());
        match draft {
            Some(DraftOperation::Remove) => {
                draft_value = base.clone();
                if let Some(value) = &draft_value {
                    draft_issues = validate_setting_value(d, value);
                    if draft_issues.is_empty() {
                        draft_serialized = serialize_setting_value(d, value).ok();
                    }
                }
            }
            Some(DraftOperation::Set(raw)) => match parse_setting_draft(d, raw) {
                Ok(parsed) => {
                    draft_value = Some(parsed.value);
                    draft_serialized = Some(parsed.serialized);
                }
                Err(found) => draft_issues = found,
            },
            None => {}
        }
        let serialized = match &effective {
            Some(value) if issues.is_empty() => serialize_setting_value(d, value).ok(),
            _ => None,
        };
        let draft_changed = match draft {
            None => false,
            Some(DraftOperation::Remove) => has_override,
            Some(DraftOperation::Set(_)) => {
                !values_equal(draft_value.as_ref(), overridden.as_ref())
            }
        };
        issues.extend(draft_issues);
        Ok(FieldState {
            field,
            value: effective,
            serialized,
            origin,
            has_local_override: has_override,
            changed: origin == Origin::Changed,
            draft_changed,
            draft_raw: match draft {
                Some(DraftOperation::Set(raw)) => Some(raw.clone()),
                _ => None,
            },
            draft_value,
            draft_serialized,
            issues,
        })
    }

    /// `setDraft`.
    pub fn set_draft<E>(&mut self, field_id: &str, raw: &[u16]) -> Result<(), EditorError<E>> {
        let index = self.definition(field_id)?;
        self.editable(index)?;
        self.put(index, DraftOperation::Set(raw.to_vec()));
        Ok(())
    }
    /// `clearDraft`.
    pub fn clear_draft<E>(&mut self, field_id: &str) -> Result<(), EditorError<E>> {
        let index = self.definition(field_id)?;
        self.drafts.retain(|(i, _)| *i != index);
        Ok(())
    }
    /// `resetToInherited`.
    pub fn reset_to_inherited<E>(&mut self, field_id: &str) -> Result<(), EditorError<E>> {
        let index = self.definition(field_id)?;
        self.editable(index)?;
        self.put(index, DraftOperation::Remove);
        Ok(())
    }
    /// `resetToDefault`.
    pub fn reset_to_default<E>(&mut self, field_id: &str) -> Result<(), EditorError<E>> {
        let index = self.definition(field_id)?;
        self.editable(index)?;
        let d = &DEFINITIONS[index];
        let Some(default) = default_value(index) else {
            return Err(EditorError::NoDefault { key: d.key });
        };
        let issues = validate_setting_value(d, &default);
        if !issues.is_empty() {
            return Err(EditorError::Invalid(issues));
        }
        let serialized = serialize_setting_value(d, &default).map_err(EditorError::Invalid)?;
        self.put(index, DraftOperation::Set(serialized));
        Ok(())
    }
    /// `compare`.
    pub fn compare<E>(&self, field_id: &str) -> Result<Comparison, EditorError<E>> {
        let index = self.definition(field_id)?;
        let d = &DEFINITIONS[index];
        let state = self.field_state(field_id)?;
        let key = units(d.key);
        let default = default_value(index);
        Ok(Comparison {
            field_id: d.id,
            key: d.key,
            effective_equals_default: values_equal(state.value.as_ref(), default.as_ref()),
            draft_equals_effective: values_equal(
                state.draft_value.as_ref().or(state.value.as_ref()),
                state.value.as_ref(),
            ),
            default,
            inherited: self.inherited.get(&key).cloned(),
            overridden: self.overrides.get(&key).cloned(),
            effective: state.value,
            draft: state.draft_value,
        })
    }

    /// `commit`: drafts in key, owner and ID order under the host collation.
    /// Any issue refuses the whole commit and changes nothing.
    pub fn commit<C: Collation>(
        &mut self,
        collation: &mut C,
    ) -> Result<Commit, EditorError<C::Error>> {
        let base_revision = self.revision;
        let mut next = self.overrides.clone();
        let mut ordered: Vec<(usize, DraftOperation)> = self.drafts.clone();
        let mut failure = None;
        ordered.sort_by(|(l, _), (r, _)| {
            if failure.is_some() {
                return Ordering::Equal;
            }
            let (a, b) = (&DEFINITIONS[*l], &DEFINITIONS[*r]);
            let mut compare = || -> Result<Ordering, C::Error> {
                for (x, y) in [(a.key, b.key), (a.owner, b.owner), (a.id, b.id)] {
                    match collation.compare(&units(x), &units(y))? {
                        Ordering::Equal => {}
                        order => return Ok(order),
                    }
                }
                Ok(Ordering::Equal)
            };
            compare().unwrap_or_else(|e| {
                failure = Some(e);
                Ordering::Equal
            })
        });
        if let Some(e) = failure {
            return Err(EditorError::Collation(e));
        }
        let mut changes = Vec::new();
        let mut issues = Vec::new();
        for (index, draft) in ordered {
            let d = &DEFINITIONS[index];
            if let Support::Unavailable(reason) = assess_support(index, self.surface) {
                issues.push(Issue {
                    code: "unavailable-setting",
                    path: d.key.into(),
                    message: units(&format!("Setting is unavailable: {reason}")),
                });
                continue;
            }
            let key = units(d.key);
            let previous = next.get(&key).cloned();
            match draft {
                DraftOperation::Remove => {
                    if let Some(previous) = next.remove(&key) {
                        changes.push(Change::Remove {
                            field_id: d.id,
                            key: d.key,
                            owner: d.owner,
                            previous,
                        });
                    }
                }
                DraftOperation::Set(raw) => match parse_setting_draft(d, &raw) {
                    Err(found) => issues.extend(found.into_iter().map(|i| Issue {
                        path: format!("{}{}", d.key, i.path),
                        ..i
                    })),
                    Ok(parsed) => {
                        if !values_equal(previous.as_ref(), Some(&parsed.value)) {
                            next.insert(key, parsed.value.clone());
                            changes.push(Change::Set {
                                field_id: d.id,
                                key: d.key,
                                owner: d.owner,
                                previous,
                                value: parsed.value,
                                serialized: parsed.serialized,
                            });
                        }
                    }
                },
            }
        }
        if !issues.is_empty() {
            return Err(EditorError::Invalid(issues));
        }
        let revision = if changes.is_empty() {
            base_revision
        } else {
            base_revision + 1
        };
        self.overrides = next.clone();
        self.revision = revision;
        self.drafts.clear();
        Ok(Commit {
            base_revision,
            revision,
            changes,
            next_overrides: next,
        })
    }
}
