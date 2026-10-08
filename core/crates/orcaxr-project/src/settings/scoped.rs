//! The read side of `scopedOverrides.ts` and `settingsOverrides.ts`: every
//! node a scoped edit can address, and the snapshot a settings surface edits
//! for one of them (its in-scope overrides, the keys it stores but does not
//! own, the chain above it, and the configuration with and without it).
use super::{
    ConfigView, ScopeIssue, ScopedOverrideLayer, SettingScope, explain_setting, fields,
    resolve_scoped_config, sanitize_scoped_overrides,
};
use crate::{
    ids::{LayerRangeId, ObjectId, PlateId, VolumeId},
    js_math::convert::number_to_string,
    model::{ConfigMap, JsonObject, ProjectState, Text},
    store::ProjectSnapshot,
};
use orcaxr_contracts::canonical::Value;
use std::collections::BTreeMap;

/// `ScopedOverrideTarget`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Project,
    Plate(PlateId),
    Object(ObjectId),
    Part(VolumeId),
    LayerRange(LayerRangeId),
}
impl Target {
    pub fn scope(&self) -> SettingScope {
        match self {
            Self::Project => SettingScope::Project,
            Self::Plate(_) => SettingScope::Plate,
            Self::Object(_) => SettingScope::Object,
            Self::Part(_) => SettingScope::Part,
            Self::LayerRange(_) => SettingScope::LayerRange,
        }
    }
    /// `describeTargetId`.
    pub fn id(&self) -> Option<&[u16]> {
        match self {
            Self::Project => None,
            Self::Plate(id) => Some(id.as_utf16()),
            Self::Object(id) => Some(id.as_utf16()),
            Self::Part(id) => Some(id.as_utf16()),
            Self::LayerRange(id) => Some(id.as_utf16()),
        }
    }
}
/// `UnknownScopedOverrideTargetError`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnknownTarget(pub Target);
impl UnknownTarget {
    pub fn message(&self) -> Vec<u16> {
        let mut out = units(&format!("No {} node matches ", self.0.scope().as_str()));
        match self.0.id() {
            Some(id) => out.extend_from_slice(id),
            None => out.extend(units("the requested target")),
        }
        out
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn or(name: &Text, fallback: &str) -> Vec<u16> {
    if name.units().is_empty() {
        units(fallback)
    } else {
        name.units().to_vec()
    }
}
/// `${minZMm}–${maxZMm} mm`.
fn range_label(min: f64, max: f64) -> Vec<u16> {
    units(&format!(
        "{}\u{2013}{} mm",
        number_to_string(min),
        number_to_string(max)
    ))
}
fn in_scope(scope: SettingScope, stored: &ConfigMap) -> ConfigMap {
    let kept = sanitize_scoped_overrides(scope, stored, None).overrides;
    config(
        kept.entries()
            .map(|(k, v)| (k.to_vec(), v.clone()))
            .collect(),
    )
}
fn config(fields: BTreeMap<Vec<u16>, Value>) -> ConfigMap {
    JsonObject::new(Value::Object(fields)).expect("configuration values are JSON")
}
fn empty() -> ConfigMap {
    config(BTreeMap::new())
}

/// `ScopedOverrideTargetOption`.
#[derive(Debug, Clone, PartialEq)]
pub struct TargetOption {
    pub id: Vec<u16>,
    pub target: Target,
    pub label: Vec<u16>,
    pub path: Vec<u16>,
    pub override_count: usize,
}
/// `scopedOverrideTargets`: project, then each plate in order with its
/// objects, their parts and height ranges, as a person scans the scene.
pub fn targets(state: &ProjectState) -> Vec<TargetOption> {
    let join = |parts: &[&[u16]]| {
        let mut out = Vec::new();
        for (i, part) in parts.iter().enumerate() {
            if i > 0 {
                out.extend(units(" \u{203a} "));
            }
            out.extend_from_slice(part);
        }
        out
    };
    let prefixed = |prefix: &str, id: &[u16]| {
        let mut out = units(prefix);
        out.extend_from_slice(id);
        out
    };
    let count = |scope: SettingScope, stored: &ConfigMap| fields(&in_scope(scope, stored)).len();
    let project = or(&state.name, "Project");
    let mut options = vec![TargetOption {
        id: units("project"),
        target: Target::Project,
        label: project.clone(),
        path: project,
        override_count: state
            .settings_overrides
            .as_ref()
            .map_or(0, |o| count(SettingScope::Project, o)),
    }];
    let mut plates: Vec<_> = state.plates.iter().collect();
    // A stable sort by order, as `Array.prototype.sort` is.
    plates.sort_by(|a, b| {
        a.order
            .get()
            .partial_cmp(&b.order.get())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for plate in plates {
        let plate_label = or(&plate.name, "Plate");
        options.push(TargetOption {
            id: prefixed("plate:", plate.id.as_utf16()),
            target: Target::Plate(plate.id.clone()),
            label: plate_label.clone(),
            path: plate_label.clone(),
            override_count: count(SettingScope::Plate, &plate.config),
        });
        for object in plate.objects.iter() {
            let object_label = or(&object.name, "Object");
            options.push(TargetOption {
                id: prefixed("object:", object.id.as_utf16()),
                target: Target::Object(object.id.clone()),
                label: object_label.clone(),
                path: join(&[&plate_label, &object_label]),
                override_count: count(SettingScope::Object, &object.config),
            });
            for volume in object.volumes.iter() {
                let volume_label = or(&volume.name, "Part");
                options.push(TargetOption {
                    id: prefixed("part:", volume.id.as_utf16()),
                    target: Target::Part(volume.id.clone()),
                    label: volume_label.clone(),
                    path: join(&[&plate_label, &object_label, &volume_label]),
                    override_count: count(SettingScope::Part, &volume.config),
                });
            }
            for range in object.layer_ranges.iter() {
                let range_label = range_label(range.min_z_mm.get(), range.max_z_mm.get());
                options.push(TargetOption {
                    id: prefixed("layerRange:", range.id.as_utf16()),
                    target: Target::LayerRange(range.id.clone()),
                    label: range_label.clone(),
                    path: join(&[&plate_label, &object_label, &range_label]),
                    override_count: count(SettingScope::LayerRange, &range.config),
                });
            }
        }
    }
    options
}

/// `ScopedOverrideChainEntry`.
#[derive(Debug, Clone, PartialEq)]
pub struct ChainEntry {
    pub scope: SettingScope,
    pub id: Option<Text>,
    pub label: Vec<u16>,
    pub overrides: ConfigMap,
    pub is_target: bool,
}
/// `ScopedOverrideSnapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct ScopedSnapshot {
    pub source_revision: u64,
    pub source_hash: String,
    pub target: Target,
    pub label: Vec<u16>,
    pub overrides: ConfigMap,
    /// Keys stored on the node that its scope does not own, kept on write.
    pub foreign: ConfigMap,
    pub foreign_issues: Vec<ScopeIssue>,
    pub chain: Vec<ChainEntry>,
    /// The chain without this node's overrides: what an editor shows as
    /// inherited.
    pub inherited_config: ConfigMap,
    pub effective_config: ConfigMap,
}

struct Resolved<'a> {
    label: Vec<u16>,
    stored: Option<&'a ConfigMap>,
    ancestors: Vec<ChainEntry>,
}
fn project_entry(state: &ProjectState) -> ChainEntry {
    ChainEntry {
        scope: SettingScope::Project,
        id: None,
        label: units("Project"),
        overrides: state
            .settings_overrides
            .as_ref()
            .map_or_else(empty, |o| in_scope(SettingScope::Project, o)),
        is_target: false,
    }
}
fn entry(
    scope: SettingScope,
    id: &[u16],
    name: &Text,
    fallback: &str,
    stored: &ConfigMap,
) -> ChainEntry {
    ChainEntry {
        scope,
        id: Some(Text::new(id.to_vec())),
        label: or(name, fallback),
        overrides: in_scope(scope, stored),
        is_target: false,
    }
}
/// `resolveTarget`: the node's stored map and its ancestors, highest first.
fn resolve<'a>(state: &'a ProjectState, target: &Target) -> Result<Resolved<'a>, UnknownTarget> {
    let unknown = || UnknownTarget(target.clone());
    match target {
        Target::Project => Ok(Resolved {
            label: units("Project"),
            stored: state.settings_overrides.as_ref(),
            ancestors: Vec::new(),
        }),
        Target::Plate(id) => {
            let plate = state
                .plates
                .iter()
                .find(|p| &p.id == id)
                .ok_or_else(unknown)?;
            Ok(Resolved {
                label: or(&plate.name, "Plate"),
                stored: Some(&plate.config),
                ancestors: vec![project_entry(state)],
            })
        }
        _ => {
            for plate in state.plates.iter() {
                for object in plate.objects.iter() {
                    let ancestors = || {
                        vec![
                            project_entry(state),
                            entry(
                                SettingScope::Plate,
                                plate.id.as_utf16(),
                                &plate.name,
                                "Plate",
                                &plate.config,
                            ),
                        ]
                    };
                    match target {
                        Target::Object(id) if &object.id == id => {
                            return Ok(Resolved {
                                label: or(&object.name, "Object"),
                                stored: Some(&object.config),
                                ancestors: ancestors(),
                            });
                        }
                        Target::Part(id) => {
                            if let Some(volume) = object.volumes.iter().find(|v| &v.id == id) {
                                let mut chain = ancestors();
                                chain.push(entry(
                                    SettingScope::Object,
                                    object.id.as_utf16(),
                                    &object.name,
                                    "Object",
                                    &object.config,
                                ));
                                return Ok(Resolved {
                                    label: or(&volume.name, "Part"),
                                    stored: Some(&volume.config),
                                    ancestors: chain,
                                });
                            }
                        }
                        Target::LayerRange(id) => {
                            if let Some(range) = object.layer_ranges.iter().find(|r| &r.id == id) {
                                let mut chain = ancestors();
                                chain.push(entry(
                                    SettingScope::Object,
                                    object.id.as_utf16(),
                                    &object.name,
                                    "Object",
                                    &object.config,
                                ));
                                return Ok(Resolved {
                                    label: range_label(range.min_z_mm.get(), range.max_z_mm.get()),
                                    stored: Some(&range.config),
                                    ancestors: chain,
                                });
                            }
                        }
                        _ => {}
                    }
                }
            }
            Err(unknown())
        }
    }
}
fn base(state: &ProjectState) -> &ConfigMap {
    state.settings_base_config.as_ref().unwrap_or(&state.config)
}
fn layers<'a>(chain: &'a [ChainEntry], scopes: &'a [Text]) -> Vec<ScopedOverrideLayer<'a>> {
    chain
        .iter()
        .zip(scopes)
        .map(|(entry, scope)| ScopedOverrideLayer {
            scope,
            id: entry.id.as_ref(),
            overrides: &entry.overrides,
        })
        .collect()
}
fn view_config(view: ConfigView<'_>) -> ConfigMap {
    config(
        view.entries()
            .map(|(k, v)| (k.to_vec(), v.clone()))
            .collect(),
    )
}

/// `scopedOverrideSnapshot`.
pub fn snapshot(
    source: &ProjectSnapshot,
    target: &Target,
) -> Result<ScopedSnapshot, UnknownTarget> {
    let state = source.state();
    let resolved = resolve(state, target)?;
    let scope = target.scope();
    let id = target.id().map(|id| Text::new(id.to_vec()));
    let empty_stored = empty();
    let stored = resolved.stored.unwrap_or(&empty_stored);
    let split = sanitize_scoped_overrides(scope, stored, id.as_ref());
    let overrides = view_config(split.overrides);
    let foreign = config(
        fields(stored)
            .iter()
            .filter(|(k, _)| !fields(&overrides).contains_key(*k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect(),
    );
    let mut chain = resolved.ancestors;
    chain.push(ChainEntry {
        scope,
        id: id.clone(),
        label: resolved.label.clone(),
        overrides: overrides.clone(),
        is_target: true,
    });
    let scopes: Vec<Text> = chain
        .iter()
        .map(|e| Text::from_utf8(e.scope.as_str()))
        .collect();
    let all = layers(&chain, &scopes);
    let resolve = |layers: &[ScopedOverrideLayer<'_>]| -> ConfigMap {
        view_config(
            resolve_scoped_config(base(state), layers).expect("chains hold in-scope overrides"),
        )
    };
    let inherited_config = resolve(&all[..all.len() - 1]);
    let effective_config = resolve(&all);
    Ok(ScopedSnapshot {
        source_revision: source.revision(),
        source_hash: source.hash().to_owned(),
        target: target.clone(),
        label: resolved.label,
        overrides,
        foreign,
        foreign_issues: split.removed,
        chain,
        inherited_config,
        effective_config,
    })
}

/// `SettingResolution`: one key's value at a target, the scope it came from
/// (`None` is the base configuration) and what it shadowed, nearest first.
#[derive(Debug, Clone, PartialEq)]
pub struct Explanation {
    pub value: Option<Value>,
    pub source: Option<SettingScope>,
    pub source_id: Option<Text>,
    pub shadowed: Vec<(SettingScope, Option<Text>, Value)>,
}
/// `explainScopedSetting`: why one key has its value at a snapshot's target.
pub fn explain(snapshot: &ScopedSnapshot, state: &ProjectState, key: &Text) -> Explanation {
    let scopes: Vec<Text> = snapshot
        .chain
        .iter()
        .map(|e| Text::from_utf8(e.scope.as_str()))
        .collect();
    let r = explain_setting(base(state), &layers(&snapshot.chain, &scopes), key)
        .expect("chains hold in-scope overrides");
    Explanation {
        value: r.value.cloned(),
        source: r.source,
        source_id: r.source_id.cloned(),
        shadowed: r
            .shadowed
            .iter()
            .map(|x| (x.scope, x.id.cloned(), x.value.clone()))
            .collect(),
    }
}

/// `ProjectSettingsOverrideSnapshot`.
#[derive(Debug, Clone, PartialEq)]
pub struct ProjectOverrides {
    pub source_revision: u64,
    pub source_hash: String,
    pub inherited_config: ConfigMap,
    pub overrides: ConfigMap,
    pub effective_config: ConfigMap,
}
/// `projectSettingsOverrideSnapshot`.
pub fn project_overrides(source: &ProjectSnapshot) -> ProjectOverrides {
    let state = source.state();
    ProjectOverrides {
        source_revision: source.revision(),
        source_hash: source.hash().to_owned(),
        inherited_config: base(state).clone(),
        overrides: state.settings_overrides.clone().unwrap_or_else(empty),
        effective_config: state.config.clone(),
    }
}
