//! A settings session: the editor a browser settings panel opens for one
//! project node, and the intent its commit becomes (`mountSettingsEditors.ts`).
//! The project scope edits its explicit overrides over the inherited preset
//! configuration; any other node edits its own overrides over the chain above
//! it. Both decode stored values through the generated codec and write back
//! through `applySettingsCommitToConfig`, so unknown and read-only values
//! survive untouched.
use super::{
    SettingScope,
    editor::{
        Change as DraftChange, Commit, DraftEditor, EditorError, Mode, Requested, surface_for_scope,
    },
    options::{self, CommitError, decode_settings_config},
    scoped::{self, Target, UnknownTarget},
};
use crate::{model::ConfigMap, store::ProjectSnapshot};
use orcaxr_contracts::{canonical::Value, project_intent_types as wire};

/// Why a session could not open.
#[derive(Debug, Clone, PartialEq)]
pub enum OpenError<E> {
    UnknownTarget(UnknownTarget),
    Editor(EditorError<E>),
}

/// What a session's editor is bound to: the node, the snapshot's guard, and
/// the raw configuration its commits are applied to.
#[derive(Debug, Clone)]
pub struct Binding {
    target: Target,
    revision: u64,
    hash: String,
    /// The raw configuration the node inherits.
    inherited: ConfigMap,
    /// The node's raw stored in-scope overrides.
    overrides: ConfigMap,
}
/// One node's settings editor, bound to the snapshot it was opened from.
#[derive(Debug, Clone)]
pub struct SettingsSession {
    pub binding: Binding,
    pub editor: DraftEditor,
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

impl SettingsSession {
    /// The browser's project or node adapter: decoded values, the node's
    /// scope (none for the project) and the surface that scope edits on.
    pub fn open<E>(
        source: &ProjectSnapshot,
        target: &Target,
        mode: Mode,
        technology: Requested,
    ) -> Result<Self, OpenError<E>> {
        let (inherited, overrides) = match target {
            Target::Project => {
                let p = scoped::project_overrides(source);
                (p.inherited_config, p.overrides)
            }
            node => {
                let s = scoped::snapshot(source, node).map_err(OpenError::UnknownTarget)?;
                (s.inherited_config, s.overrides)
            }
        };
        let scope = target.scope();
        let editor = DraftEditor::new(
            mode,
            technology,
            Some(surface_for_scope(scope)),
            (scope != SettingScope::Project).then_some(scope),
            decode_settings_config(&inherited).values,
            decode_settings_config(&overrides).values,
        )
        .map_err(OpenError::Editor)?;
        Ok(Self {
            binding: Binding {
                target: target.clone(),
                revision: source.revision(),
                hash: source.hash().to_owned(),
                inherited,
                overrides,
            },
            editor,
        })
    }
}

impl Binding {
    pub fn target(&self) -> &Target {
        &self.target
    }
    /// The project intent that applies a commit of this session's editor to
    /// the snapshot it was opened from, guarded by that snapshot.
    pub fn intent(&self, commit: &Commit) -> Result<wire::Intent, CommitError> {
        let changes: Vec<options::Change> = commit
            .changes
            .iter()
            .map(|change| match change {
                DraftChange::Set {
                    key, serialized, ..
                } => options::Change::Set {
                    key: key.encode_utf16().collect(),
                    serialized: Some(serialized.clone()),
                },
                DraftChange::Remove { key, .. } => options::Change::Remove {
                    key: key.encode_utf16().collect(),
                },
            })
            .collect();
        let next = options::apply_settings_commit(&self.overrides, &changes)?;
        let guard = wire::SettingsGuard {
            source_revision: self.revision,
            source_hash: self.hash.encode_utf16().collect(),
        };
        let overrides_json = canonical(&Value::Object(next));
        let id = |units: &[u16]| units.to_vec();
        let command = match &self.target {
            Target::Project => {
                wire::Command::SetProjectSettingsOverrides(wire::SetProjectSettingsOverrides {
                    guard,
                    inherited_config_json: canonical(self.inherited.value()),
                    overrides_json,
                })
            }
            node => wire::Command::SetScopedOverrides(wire::SetScopedOverrides {
                guard,
                target: match node {
                    Target::Plate(p) => wire::ScopedTarget::Plate(wire::PlateScope {
                        plate_id: id(p.as_utf16()),
                    }),
                    Target::Object(o) => wire::ScopedTarget::Object(wire::ObjectTarget {
                        object_id: id(o.as_utf16()),
                    }),
                    Target::Part(v) => wire::ScopedTarget::Part(wire::PartScope {
                        volume_id: id(v.as_utf16()),
                    }),
                    Target::LayerRange(r) => {
                        wire::ScopedTarget::LayerRange(wire::LayerRangeScope {
                            layer_range_id: id(r.as_utf16()),
                        })
                    }
                    Target::Project => unreachable!("handled above"),
                },
                overrides_json,
            }),
        };
        Ok(wire::Intent {
            version: 1,
            command,
        })
    }
}
