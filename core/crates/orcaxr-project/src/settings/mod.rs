//! Pinned engine scope eligibility and deterministic settings resolution.
//! These read-only views borrow immutable input values; explicit public exports
//! copy. They neither validate option values nor execute project commands.
pub mod catalog;
pub mod catalog_exchange;
mod generated;
pub mod library;
pub mod library_exchange;
pub mod options;
pub mod presets;
mod project;
use crate::model::{ConfigMap, Encode, Text};
pub use generated::{SCOPE_ORDER, SOURCE_COMMIT, SOURCE_DIGEST, SOURCE_FILES};
use orcaxr_contracts::canonical::{Value, write_string};
pub use project::*;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, Write};

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum SettingScope {
    Project,
    Plate,
    Object,
    Part,
    LayerRange,
}
impl SettingScope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Plate => "plate",
            Self::Object => "object",
            Self::Part => "part",
            Self::LayerRange => "layerRange",
        }
    }
    pub fn label(self) -> &'static str {
        match self {
            Self::LayerRange => "height range",
            _ => self.as_str(),
        }
    }
    pub fn from_utf16(value: &[u16]) -> Option<Self> {
        SCOPE_ORDER
            .iter()
            .copied()
            .find(|scope| value.iter().copied().eq(scope.as_str().encode_utf16()))
    }
    pub fn keys(self) -> &'static [&'static str] {
        generated::keys(self)
    }
    pub fn allows(self, key: &[u16]) -> bool {
        self.keys()
            .binary_search_by(|candidate| candidate.encode_utf16().cmp(key.iter().copied()))
            .is_ok()
    }
    fn rank(self) -> usize {
        SCOPE_ORDER
            .iter()
            .position(|scope| *scope == self)
            .expect("generated scope")
    }
}
pub fn scopes_for_setting(key: &[u16]) -> impl DoubleEndedIterator<Item = SettingScope> + '_ {
    SCOPE_ORDER
        .iter()
        .copied()
        .filter(move |scope| scope.allows(key))
}
pub fn narrowest_scope_for_setting(key: &[u16]) -> Option<SettingScope> {
    scopes_for_setting(key).next_back()
}

/// A raw textual scope retains unknown names for structured validation errors.
/// Non-text scopes belong to host shape decoding, not this typed boundary.
pub struct ScopedOverrideLayer<'a> {
    pub scope: &'a Text,
    pub id: Option<&'a Text>,
    pub overrides: &'a ConfigMap,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ScopeIssueCode {
    NotInScope,
    UnknownScope,
    DuplicateLayer,
}
impl ScopeIssueCode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NotInScope => "setting-not-in-scope",
            Self::UnknownScope => "unknown-setting-scope",
            Self::DuplicateLayer => "duplicate-scope-layer",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeIssue {
    pub code: ScopeIssueCode,
    pub path: Text,
    pub scope: Text,
    pub key: Text,
    pub message: Text,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScopeError {
    pub issues: Vec<ScopeIssue>,
}
impl ScopeError {
    pub const NAME: &'static str = "SettingScopeError";
    /// Operator-facing diagnostics can include imported keys; Debug/Display
    /// intentionally omit those values from ordinary logs.
    pub fn message(&self) -> Text {
        if self.issues.len() == 1 {
            self.issues[0].message.clone()
        } else {
            Text::from_utf8(&format!(
                "{} settings cannot be stored at the scope they were given",
                self.issues.len()
            ))
        }
    }
}
impl std::fmt::Display for ScopeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Invalid setting scopes ({} issues)", self.issues.len())
    }
}
impl std::error::Error for ScopeError {}
pub(super) fn fields(config: &ConfigMap) -> &BTreeMap<Vec<u16>, Value> {
    let Value::Object(fields) = config.value() else {
        unreachable!("ConfigMap is an object")
    };
    fields
}
pub(super) fn text(parts: &[&[u16]]) -> Text {
    Text::new(parts.concat())
}
pub(super) fn units(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}
fn out_of_scope(scope: SettingScope, key: &[u16]) -> Text {
    let names: Vec<_> = scopes_for_setting(key).map(SettingScope::label).collect();
    if names.is_empty() {
        return text(&[
            key,
            &units(
                " is not an override at any scope; it belongs to a preset, not to a project node",
            ),
        ]);
    }
    let list = if names.len() == 1 {
        names[0].to_owned()
    } else {
        format!(
            "{} or {}",
            names[..names.len() - 1].join(", "),
            names[names.len() - 1]
        )
    };
    let label = scope.label();
    text(&[
        key,
        &units(&format!(
            " cannot be set on a {label}; the engine reads it from the {list}"
        )),
    ])
}
pub fn validate_scoped_overrides(layers: &[ScopedOverrideLayer<'_>]) -> Vec<ScopeIssue> {
    let mut issues = vec![];
    let mut seen = BTreeSet::new();
    for (index, layer) in layers.iter().enumerate() {
        let path = units(&format!("layers[{index}]"));
        let Some(scope) = SettingScope::from_utf16(layer.scope.units()) else {
            let mut quoted = Vec::new();
            write_string(layer.scope.units(), &mut quoted).expect("in-memory text");
            let quoted = String::from_utf8(quoted).expect("canonical text is UTF-8");
            issues.push(ScopeIssue {
                code: ScopeIssueCode::UnknownScope,
                path: Text::new(path),
                scope: layer.scope.clone(),
                key: Text::from_utf8(""),
                message: Text::from_utf8(&format!("{quoted} is not a setting scope")),
            });
            continue;
        };
        // Tuple identity matches scope + NUL + id, including omitted/empty IDs,
        // because all recognized scope names are fixed ASCII without NULs.
        if !seen.insert((scope, layer.id.map(Text::units).unwrap_or(&[]))) {
            issues.push(ScopeIssue {
                code: ScopeIssueCode::DuplicateLayer,
                path: Text::new(path.clone()),
                scope: layer.scope.clone(),
                key: Text::from_utf8(""),
                message: Text::from_utf8(&format!(
                    "The {} scope was supplied twice for the same node",
                    scope.label()
                )),
            });
        }
        for key in fields(layer.overrides).keys() {
            if scope.allows(key) {
                continue;
            }
            issues.push(ScopeIssue {
                code: ScopeIssueCode::NotInScope,
                path: text(&[&path, &units("."), key]),
                scope: layer.scope.clone(),
                key: Text::new(key.clone()),
                message: out_of_scope(scope, key),
            });
        }
    }
    issues
}

/// Read-only resolved values borrow their original immutable JSON; Debug does
/// not print potentially private configuration payloads.
#[derive(Clone, Default, PartialEq)]
pub struct ConfigView<'a>(BTreeMap<&'a [u16], &'a Value>);
impl std::fmt::Debug for ConfigView<'_> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ConfigView")
            .field("keys", &self.0.len())
            .finish()
    }
}
impl<'a> ConfigView<'a> {
    pub fn get(&self, key: &[u16]) -> Option<&'a Value> {
        self.0.get(key).copied()
    }
    pub fn entries(&self) -> impl Iterator<Item = (&'a [u16], &'a Value)> + '_ {
        self.0.iter().map(|(k, v)| (*k, *v))
    }
    fn from_config(config: &'a ConfigMap) -> Self {
        Self(
            fields(config)
                .iter()
                .map(|(key, value)| (key.as_slice(), value))
                .collect(),
        )
    }
}
impl Encode for ConfigView<'_> {
    fn write_json(&self, mut out: &mut dyn Write) -> io::Result<()> {
        out.write_all(b"{")?;
        for (index, (key, value)) in self.0.iter().enumerate() {
            if index > 0 {
                out.write_all(b",")?;
            }
            write_string(key, &mut out)?;
            out.write_all(b":")?;
            value.write_canonical(&mut out)?;
        }
        out.write_all(b"}")
    }
    fn to_value(&self) -> io::Result<Value> {
        Ok(Value::Object(
            self.0
                .iter()
                .map(|(key, value)| (key.to_vec(), (*value).clone()))
                .collect(),
        ))
    }
}
fn ordered<'a, 'b>(
    layers: &'b [ScopedOverrideLayer<'a>],
) -> Vec<(SettingScope, &'b ScopedOverrideLayer<'a>)> {
    let mut ordered: Vec<_> = layers
        .iter()
        .map(|layer| {
            (
                SettingScope::from_utf16(layer.scope.units()).expect("validated scope"),
                layer,
            )
        })
        .collect();
    ordered.sort_by_key(|(scope, _)| scope.rank());
    ordered
}
pub fn resolve_scoped_config<'a>(
    base: &'a ConfigMap,
    layers: &[ScopedOverrideLayer<'a>],
) -> Result<ConfigView<'a>, ScopeError> {
    let issues = validate_scoped_overrides(layers);
    if !issues.is_empty() {
        return Err(ScopeError { issues });
    }
    let mut resolved = ConfigView::from_config(base);
    for (_, layer) in ordered(layers) {
        for (key, value) in fields(layer.overrides) {
            resolved.0.insert(key, value);
        }
    }
    Ok(resolved)
}
pub struct ShadowedSetting<'a> {
    pub scope: SettingScope,
    pub id: Option<&'a Text>,
    pub value: &'a Value,
}
pub struct SettingResolution<'a> {
    pub key: &'a Text,
    pub value: Option<&'a Value>,
    pub source: Option<SettingScope>,
    pub source_id: Option<&'a Text>,
    pub shadowed: Vec<ShadowedSetting<'a>>,
}
pub fn explain_setting<'a>(
    base: &'a ConfigMap,
    layers: &[ScopedOverrideLayer<'a>],
    key: &'a Text,
) -> Result<SettingResolution<'a>, ScopeError> {
    let issues = validate_scoped_overrides(layers);
    if !issues.is_empty() {
        return Err(ScopeError { issues });
    }
    let mut contributors: Vec<_> = ordered(layers)
        .into_iter()
        .filter_map(|(scope, layer)| {
            fields(layer.overrides)
                .get(key.units())
                .map(|value| ShadowedSetting {
                    scope,
                    id: layer.id,
                    value,
                })
        })
        .collect();
    let winner = contributors.pop();
    contributors.reverse();
    Ok(SettingResolution {
        key,
        value: winner
            .as_ref()
            .map(|entry| entry.value)
            .or_else(|| fields(base).get(key.units())),
        source: winner.as_ref().map(|entry| entry.scope),
        source_id: winner.and_then(|entry| entry.id),
        shadowed: contributors,
    })
}
pub struct SanitizedOverrides<'a> {
    pub overrides: ConfigView<'a>,
    pub removed: Vec<ScopeIssue>,
}
pub fn sanitize_scoped_overrides<'a>(
    scope: SettingScope,
    overrides: &'a ConfigMap,
    id: Option<&Text>,
) -> SanitizedOverrides<'a> {
    let raw_scope = Text::from_utf8(scope.as_str());
    let mut kept = ConfigView::default();
    let mut removed = vec![];
    for (key, value) in fields(overrides) {
        if scope.allows(key) {
            kept.0.insert(key, value);
            continue;
        }
        let path = if let Some(id) = id.filter(|id| !id.units().is_empty()) {
            text(&[
                raw_scope.units(),
                &units("["),
                id.units(),
                &units("]."),
                key,
            ])
        } else {
            text(&[raw_scope.units(), &units("."), key])
        };
        removed.push(ScopeIssue {
            code: ScopeIssueCode::NotInScope,
            path,
            scope: raw_scope.clone(),
            key: Text::new(key.clone()),
            message: out_of_scope(scope, key),
        });
    }
    SanitizedOverrides {
        overrides: kept,
        removed,
    }
}
pub fn scoped_config_bytes(
    base: &ConfigMap,
    layers: &[ScopedOverrideLayer<'_>],
) -> Result<String, ScopeError> {
    let config = resolve_scoped_config(base, layers)?;
    let mut bytes = vec![];
    config
        .write_json(&mut bytes)
        .expect("canonical immutable JSON");
    Ok(String::from_utf8(bytes).expect("canonical text is UTF-8"))
}
