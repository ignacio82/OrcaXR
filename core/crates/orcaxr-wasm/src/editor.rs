//! The settings editor host exchange (`settings::editor::exchange`). Requests
//! and replies are generated contract JSON; fields and rows are read one at a
//! time after a query.
use crate::{
    catalog::{HostCollation, PresetCollator},
    project::{error, index},
};
use orcaxr_contracts::{project_intent_types as wire, project_intents::InvalidIntent};
use orcaxr_project::settings::{
    editor::{
        AsciiFolding, SearchFolding,
        exchange::{self, HostEditor, Refusal},
    },
    presets::{AsciiRootCollation, Collation},
};
use orcaxr_project::store::ProjectSnapshot;
use std::cmp::Ordering;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
extern "C" {
    /// Any object with `fold(text: Uint16Array): Uint16Array` folding search
    /// text like `text.normalize('NFKD').toLocaleLowerCase('en-US')`.
    pub type SearchFolder;
    #[wasm_bindgen(method, catch)]
    fn fold(this: &SearchFolder, text: &[u16]) -> Result<Vec<u16>, JsValue>;
}
/// The host collator, or the exact ASCII root order.
struct Order<'a>(Option<&'a PresetCollator>);
impl Collation for Order<'_> {
    type Error = &'static str;
    fn compare(&mut self, left: &[u16], right: &[u16]) -> Result<Ordering, &'static str> {
        match self.0 {
            Some(host) => HostCollation(host)
                .compare(left, right)
                .map_err(|_| "collation_failed"),
            None => AsciiRootCollation
                .compare(left, right)
                .map_err(|_| "non_ascii_collation"),
        }
    }
}
/// The host folder, or the exact ASCII folding.
struct Fold<'a>(Option<&'a SearchFolder>);
impl SearchFolding for Fold<'_> {
    type Error = &'static str;
    fn fold(&mut self, text: &[u16]) -> Result<Vec<u16>, &'static str> {
        match self.0 {
            Some(host) => host.fold(text).map_err(|_| "folding_failed"),
            None => AsciiFolding.fold(text).map_err(|_| "non_ascii_search"),
        }
    }
}
fn refused(e: Refusal<&'static str>) -> JsValue {
    match e {
        Refusal::Host(code) => error(code),
        other => error(other.code()),
    }
}
fn encode<T>(
    value: &T,
    encode: fn(&T) -> Result<String, InvalidIntent>,
) -> Result<String, JsValue> {
    encode(value).map_err(|_| error("output_limit"))
}
fn request<T>(text: &str, decode: fn(&str) -> Result<T, InvalidIntent>) -> Result<T, JsValue> {
    if text.len() > wire::MAX_BYTES {
        return Err(error("input_limit"));
    }
    decode(text).map_err(|_| error("invalid_request"))
}

/// A settings draft over inherited values and one node's overrides.
#[wasm_bindgen]
pub struct SettingsEditor {
    inner: HostEditor,
    collator: Option<PresetCollator>,
    folder: Option<SearchFolder>,
}
#[wasm_bindgen]
impl SettingsEditor {
    /// An `EditorCreate`. Without a collator or folder the exact ASCII
    /// policies apply and refuse other text.
    #[wasm_bindgen(constructor)]
    pub fn new(
        create: &str,
        collator: Option<PresetCollator>,
        folder: Option<SearchFolder>,
    ) -> Result<SettingsEditor, JsValue> {
        let create = request(create, wire::decode_editor_create)?;
        let inner = HostEditor::create::<&'static str>(&create).map_err(refused)?;
        Ok(Self {
            inner,
            collator,
            folder,
        })
    }
    /// An `EditorQuery`; returns the number of fields.
    pub fn query(&mut self, query: &str) -> Result<usize, JsValue> {
        let query = request(query, wire::decode_editor_query)?;
        self.inner
            .query(
                &query,
                &mut Order(self.collator.as_ref()),
                &mut Fold(self.folder.as_ref()),
            )
            .map_err(refused)
    }
    /// The latest query's field at `position`, as an `EditorField`.
    pub fn field(&self, position: f64) -> Result<String, JsValue> {
        let field = self
            .inner
            .field(index(position)?)
            .ok_or_else(|| error("invalid_range"))?;
        encode(&field, wire::encode_editor_field)
    }
    /// An `EditorFieldRef`; returns its `EditorFieldState`.
    pub fn state(&self, field: &str) -> Result<String, JsValue> {
        let field = request(field, wire::decode_editor_field_ref)?;
        encode(
            &self.inner.state(&field).map_err(refused)?,
            wire::encode_editor_field_state,
        )
    }
    /// An `EditorFieldRef`; returns its `EditorComparison`.
    pub fn compare(&self, field: &str) -> Result<String, JsValue> {
        let field = request(field, wire::decode_editor_field_ref)?;
        encode(
            &self.inner.compare(&field).map_err(refused)?,
            wire::encode_editor_comparison,
        )
    }
    /// An `EditorEdit`; returns its `EditorEditResult`.
    pub fn edit(&mut self, edit: &str) -> Result<String, JsValue> {
        let edit = request(edit, wire::decode_editor_edit)?;
        encode(
            &self.inner.edit::<&'static str>(&edit),
            wire::encode_editor_edit_result,
        )
    }
    /// Commit every draft; returns an `EditorCommitResult`.
    pub fn commit(&mut self) -> Result<String, JsValue> {
        let result = self
            .inner
            .commit(&mut Order(self.collator.as_ref()))
            .map_err(refused)?;
        encode(&result, wire::encode_editor_commit_result)
    }
    pub fn revision(&self) -> f64 {
        self.inner.revision() as f64
    }
    /// This node's overrides as canonical JSON.
    pub fn overrides(&self) -> String {
        String::from_utf16_lossy(&self.inner.overrides_json())
    }
    /// An `EditorRowsRequest`; returns the number of rows.
    pub fn rows(&mut self, rows: &str) -> Result<usize, JsValue> {
        let rows = request(rows, wire::decode_editor_rows_request)?;
        self.inner
            .rows(
                &rows,
                &mut Order(self.collator.as_ref()),
                &mut Fold(self.folder.as_ref()),
            )
            .map_err(refused)
    }
    /// Fields the latest rows left out because no surface supports them.
    pub fn unavailable(&self) -> usize {
        self.inner.unavailable()
    }
    pub fn row(&self, position: f64) -> Result<String, JsValue> {
        let row = self
            .inner
            .row(index(position)?)
            .ok_or_else(|| error("invalid_range"))?;
        encode(&row, wire::encode_editor_row)
    }
    /// For an editor opened on a project node: the project `Intent` that
    /// applies its latest commit, guarded by the captured snapshot.
    pub fn intent(&self) -> Result<String, JsValue> {
        let intent = self.inner.intent().ok_or_else(|| error("no_commit"))?;
        encode(intent, wire::encode_intent)
    }
}

/// `CapturedProject.settings_editor`: the editor a settings panel opens for
/// one node of the captured project.
pub(crate) fn open(
    snapshot: &ProjectSnapshot,
    request: &str,
    collator: Option<PresetCollator>,
    folder: Option<SearchFolder>,
) -> Result<SettingsEditor, JsValue> {
    let request = self::request(request, wire::decode_settings_session_request)?;
    let inner = HostEditor::open::<&'static str>(snapshot, &request).map_err(refused)?;
    Ok(SettingsEditor {
        inner,
        collator,
        folder,
    })
}
/// An `ObjectTreeRequest` on a captured project, as contract JSON; the folder
/// folds non-ASCII search text (without one, such text is refused).
pub(crate) fn object_tree(
    snapshot: &ProjectSnapshot,
    request: &str,
    folder: Option<&SearchFolder>,
) -> Result<String, JsValue> {
    use orcaxr_project::objects_tree::{self, Refusal};
    let request = self::request(request, wire::decode_object_tree_request)?;
    let reply = objects_tree::answer(snapshot.state(), &request, &mut Fold(folder)).map_err(
        |e| match e {
            Refusal::Host(code) => error(code),
            other => error(other.code()),
        },
    )?;
    encode(&reply, wire::encode_object_tree_reply)
}
/// The settings projection of a captured project, as contract JSON.
pub(crate) fn projection(
    snapshot: &ProjectSnapshot,
    kind: Projection,
    request: &str,
) -> Result<String, JsValue> {
    use orcaxr_project::settings::projection_exchange as p;
    let refused = |e: p::Refusal| error(e.code());
    match kind {
        Projection::Targets => {
            let request = self::request(request, wire::decode_settings_target_page_request)?;
            encode(
                &p::target_page(snapshot, &request).map_err(refused)?,
                wire::encode_settings_target_page,
            )
        }
        Projection::Snapshot => {
            let request = self::request(request, wire::decode_settings_target_request)?;
            encode(
                &p::snapshot(snapshot, &request).map_err(refused)?,
                wire::encode_settings_snapshot_result,
            )
        }
        Projection::Explain => {
            let request = self::request(request, wire::decode_settings_explain_request)?;
            encode(
                &p::explain(snapshot, &request).map_err(refused)?,
                wire::encode_settings_explain_result,
            )
        }
    }
}
pub(crate) enum Projection {
    Targets,
    Snapshot,
    Explain,
}

/// `stepSettingValue`: an `EditorStepRequest` to an `EditorStep`.
#[wasm_bindgen]
pub fn settings_step(step: &str) -> Result<String, JsValue> {
    let step = request(step, wire::decode_editor_step_request)?;
    encode(
        &exchange::step::<&'static str>(&step).map_err(refused)?,
        wire::encode_editor_step,
    )
}
/// The Full Spectrum rules: an `EditorRuleRequest` to `EditorRules`.
#[wasm_bindgen]
pub fn settings_rules(rules: &str) -> Result<String, JsValue> {
    let rules = request(rules, wire::decode_editor_rule_request)?;
    encode(
        &exchange::rules::<&'static str>(&rules).map_err(refused)?,
        wire::encode_editor_rules,
    )
}
