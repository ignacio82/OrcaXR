//! The settings projection's host exchange over a captured project: target
//! pages, node override snapshots and explanations as generated contract
//! values. Settings editors open on a node through
//! [`super::editor::exchange::HostEditor::open`].
use super::{
    SettingScope,
    scoped::{self, Target, TargetOption},
};
use crate::{
    ids::{LayerRangeId, ObjectId, PlateId, VolumeId},
    model::{ConfigMap, Text},
    store::ProjectSnapshot,
};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

/// The most targets one page may hold.
pub const MAX_PAGE: usize = 64;

/// Why a request was refused.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    /// A malformed target ID or an oversized page.
    InvalidRequest,
}
impl Refusal {
    pub fn code(self) -> &'static str {
        "invalid_request"
    }
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
fn canonical(value: &Value) -> Vec<u16> {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes)
        .expect("canonical JSON is UTF-8")
        .encode_utf16()
        .collect()
}
fn config(map: &ConfigMap) -> Vec<u16> {
    canonical(map.value())
}
fn optional(units: Option<&[u16]>) -> wire::OptionalText {
    match units {
        Some(u) => wire::OptionalText::Value(u.to_vec()),
        None => wire::OptionalText::Absent(wire::Empty {}),
    }
}
pub fn wire_scope(scope: SettingScope) -> wire::EditorScope {
    match scope {
        SettingScope::Project => wire::EditorScope::Project,
        SettingScope::Plate => wire::EditorScope::Plate,
        SettingScope::Object => wire::EditorScope::Object,
        SettingScope::Part => wire::EditorScope::Part,
        SettingScope::LayerRange => wire::EditorScope::LayerRange,
    }
}
/// A contract target as a node; a malformed ID names no node.
pub fn target(target: &wire::SettingsTarget) -> Result<Target, Refusal> {
    let id = |units: &[u16]| String::from_utf16(units).map_err(|_| Refusal::InvalidRequest);
    let bad = |_| Refusal::InvalidRequest;
    Ok(match target {
        wire::SettingsTarget::Project(_) => Target::Project,
        wire::SettingsTarget::Plate(p) => {
            Target::Plate(PlateId::try_from_str(&id(&p.plate_id)?).map_err(bad)?)
        }
        wire::SettingsTarget::Object(o) => {
            Target::Object(ObjectId::try_from_str(&id(&o.object_id)?).map_err(bad)?)
        }
        wire::SettingsTarget::Part(p) => {
            Target::Part(VolumeId::try_from_str(&id(&p.volume_id)?).map_err(bad)?)
        }
        wire::SettingsTarget::LayerRange(r) => {
            Target::LayerRange(LayerRangeId::try_from_str(&id(&r.layer_range_id)?).map_err(bad)?)
        }
    })
}
fn wire_target(target: &Target) -> wire::SettingsTarget {
    let id = |units: &[u16]| units.to_vec();
    match target {
        Target::Project => wire::SettingsTarget::Project(wire::Empty {}),
        Target::Plate(p) => wire::SettingsTarget::Plate(wire::PlateScope {
            plate_id: id(p.as_utf16()),
        }),
        Target::Object(o) => wire::SettingsTarget::Object(wire::ObjectTarget {
            object_id: id(o.as_utf16()),
        }),
        Target::Part(v) => wire::SettingsTarget::Part(wire::PartScope {
            volume_id: id(v.as_utf16()),
        }),
        Target::LayerRange(r) => wire::SettingsTarget::LayerRange(wire::LayerRangeScope {
            layer_range_id: id(r.as_utf16()),
        }),
    }
}

/// One page of `scopedOverrideTargets`, in scan order.
pub fn target_page(
    snapshot: &ProjectSnapshot,
    request: &wire::SettingsTargetPageRequest,
) -> Result<wire::SettingsTargetPage, Refusal> {
    if request.count > MAX_PAGE as u64 {
        return Err(Refusal::InvalidRequest);
    }
    let all = scoped::targets(snapshot.state());
    let start = usize::try_from(request.start)
        .unwrap_or(usize::MAX)
        .min(all.len());
    let end = start.saturating_add(request.count as usize).min(all.len());
    let option = |o: &TargetOption| wire::SettingsTargetOption {
        id: o.id.clone(),
        target: wire_target(&o.target),
        label: o.label.clone(),
        path: o.path.clone(),
        override_count: o.override_count as u64,
    };
    Ok(wire::SettingsTargetPage {
        total: all.len() as u64,
        targets: all[start..end].iter().map(option).collect(),
    })
}

/// `scopedOverrideSnapshot`, or the browser's unknown-node message.
pub fn snapshot(
    snapshot: &ProjectSnapshot,
    request: &wire::SettingsTargetRequest,
) -> Result<wire::SettingsSnapshotResult, Refusal> {
    let node = target(&request.target)?;
    Ok(match scoped::snapshot(snapshot, &node) {
        Err(unknown) => wire::SettingsSnapshotResult::Unknown(unknown.message()),
        Ok(s) => wire::SettingsSnapshotResult::Snapshot(wire::SettingsSnapshot {
            source_revision: s.source_revision,
            source_hash: units(&s.source_hash),
            label: s.label,
            overrides_json: config(&s.overrides),
            foreign_json: config(&s.foreign),
            foreign_issues: s
                .foreign_issues
                .iter()
                .map(|i| wire::SettingsScopeIssue {
                    code: units(i.code.as_str()),
                    path: i.path.units().to_vec(),
                    scope: i.scope.units().to_vec(),
                    key: i.key.units().to_vec(),
                    message: i.message.units().to_vec(),
                })
                .collect(),
            chain: s
                .chain
                .iter()
                .map(|c| wire::SettingsChainEntry {
                    scope: wire_scope(c.scope),
                    id: optional(c.id.as_ref().map(Text::units)),
                    label: c.label.clone(),
                    overrides_json: config(&c.overrides),
                    is_target: c.is_target,
                })
                .collect(),
            inherited_config_json: config(&s.inherited_config),
            effective_config_json: config(&s.effective_config),
        }),
    })
}

/// `explainScopedSetting`, or the browser's unknown-node message.
pub fn explain(
    snapshot: &ProjectSnapshot,
    request: &wire::SettingsExplainRequest,
) -> Result<wire::SettingsExplainResult, Refusal> {
    let node = target(&request.target)?;
    let s = match scoped::snapshot(snapshot, &node) {
        Err(unknown) => return Ok(wire::SettingsExplainResult::Unknown(unknown.message())),
        Ok(s) => s,
    };
    let e = scoped::explain(&s, snapshot.state(), &Text::new(request.key.clone()));
    Ok(wire::SettingsExplainResult::Explanation(
        wire::SettingsExplanation {
            value_json: match &e.value {
                Some(v) => wire::OptionalJsonText::Value(canonical(v)),
                None => wire::OptionalJsonText::Absent(wire::Empty {}),
            },
            source: match e.source {
                Some(scope) => wire::OptionalEditorScope::Value(wire_scope(scope)),
                None => wire::OptionalEditorScope::Absent(wire::Empty {}),
            },
            source_id: optional(e.source_id.as_ref().map(Text::units)),
            shadowed: e
                .shadowed
                .iter()
                .map(|(scope, id, value)| wire::SettingsShadowed {
                    scope: wire_scope(*scope),
                    id: optional(id.as_ref().map(Text::units)),
                    value_json: canonical(value),
                })
                .collect(),
        },
    ))
}
