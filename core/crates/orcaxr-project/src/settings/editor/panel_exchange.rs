//! The generated settings panel's host exchange (`settingsPanelExchange.ts`):
//! canonical JSON requests and replies over one host editor's panel.
//!
//! - view `{"mode","search"}` → `{"sections","shown","summary","unavailable"}`;
//! - row `{"fieldId"}` → `{"row"}`, or `{"refused"}` with the editor's message;
//! - edit `{"fieldId","op":"set","raw"}`, `{"fieldId","op":"inherit"}` or
//!   `{"fieldId","op":"default"}` → `{"outcome":"applied"}`,
//!   `{"message","outcome":"unserializable"}` (a default the codec cannot
//!   write) or `{"message","outcome":"refused"}` (what the browser throws);
//! - state → `{"changed","drafts","invalid"}`;
//! - apply → `{"changes","outcome":"committed"}`, `{"outcome":"unchanged"}`
//!   (the drafts dropped), `{"message","outcome":"invalid"}` (validation) or
//!   `{"message","outcome":"failed"}`;
//! - target texts `{"label","overrideCount","path","scope"}` →
//!   `{"heading","summary","text"}`, the scoped panel's words for a target.
use super::{
    Mode, PanelModel, SearchFolding,
    draft::{Commit, EditorError},
    exchange::Refusal,
    panel::{
        Control, DefaultOutcome, PanelError, PanelRow, PanelView, STRUCTURED_EDITOR_VALUE, heading,
        option_text, origin_label, structured_editor_id, summary,
    },
    units,
};
use crate::settings::{SettingScope, options, presets::Collation};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;

fn read<E>(request: &str, keys: &[&str]) -> Result<BTreeMap<Vec<u16>, Value>, Refusal<E>> {
    let Ok(Value::Object(fields)) = parse(request) else {
        return Err(Refusal::InvalidRequest);
    };
    if fields.len() != keys.len() || !keys.iter().all(|k| fields.contains_key(&units(k))) {
        return Err(Refusal::InvalidRequest);
    }
    Ok(fields)
}
fn text<E>(fields: &mut BTreeMap<Vec<u16>, Value>, key: &str) -> Result<Vec<u16>, Refusal<E>> {
    match fields.remove(&units(key)) {
        Some(Value::String(units)) => Ok(units),
        _ => Err(Refusal::InvalidRequest),
    }
}
/// A field ID: the definitions' IDs are ASCII.
fn field_id<E>(fields: &mut BTreeMap<Vec<u16>, Value>) -> Result<String, Refusal<E>> {
    String::from_utf16(&text(fields, "fieldId")?).map_err(|_| Refusal::InvalidRequest)
}
fn string(text: &str) -> Value {
    Value::String(units(text))
}
fn object<const N: usize>(members: [(&str, Option<Value>); N]) -> Value {
    Value::Object(
        members
            .into_iter()
            .filter_map(|(k, v)| v.map(|v| (units(k), v)))
            .collect(),
    )
}
fn canonical(value: &Value) -> String {
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes).expect("canonical JSON is UTF-8")
}
fn outcome(name: &str, message: Option<Vec<u16>>) -> String {
    canonical(&object([
        ("message", message.map(Value::String)),
        ("outcome", Some(string(name))),
    ]))
}
fn mode<E>(value: &[u16]) -> Result<Mode, Refusal<E>> {
    match String::from_utf16_lossy(value).as_str() {
        "simple" => Ok(Mode::Simple),
        "advanced" => Ok(Mode::Advanced),
        "develop" => Ok(Mode::Develop),
        _ => Err(Refusal::InvalidRequest),
    }
}
/// A panel error the browser throws, as its message.
fn thrown<E>(error: PanelError<E>) -> Result<Vec<u16>, Refusal<E>> {
    match error {
        PanelError::Editor(EditorError::Collation(e)) => Err(Refusal::Host(e)),
        other => Ok(other.message()),
    }
}

fn control(control: &Control) -> Value {
    let kind = |k: &str| Some(string(k));
    match control {
        Control::Structured => object([
            ("editorId", Some(string(structured_editor_id()))),
            ("kind", kind("structured")),
            ("value", Some(string(STRUCTURED_EDITOR_VALUE))),
        ]),
        Control::Locked(value) => object([
            ("kind", kind("locked")),
            ("value", Some(Value::String(value.clone()))),
        ]),
        Control::Checkbox(checked) => object([
            ("checked", Some(Value::Bool(*checked))),
            ("kind", kind("checkbox")),
        ]),
        Control::Select {
            value,
            nil,
            choices,
        } => object([
            (
                "choices",
                Some(Value::Array(
                    choices
                        .iter()
                        .map(|(value, label)| {
                            object([
                                ("label", Some(string(label))),
                                ("value", Some(string(value))),
                            ])
                        })
                        .collect(),
                )),
            ),
            ("kind", kind("select")),
            ("nil", nil.map(string)),
            ("value", Some(Value::String(value.clone()))),
        ]),
        Control::Textarea { value, rows } => object([
            ("kind", kind("textarea")),
            ("rows", Some(Value::Number(f64::from(*rows)))),
            ("value", Some(Value::String(value.clone()))),
        ]),
        Control::Text {
            value,
            input_mode,
            spellcheck,
        } => object([
            ("inputMode", input_mode.map(string)),
            ("kind", kind("text")),
            ("spellcheck", Some(Value::Bool(*spellcheck))),
            ("value", Some(Value::String(value.clone()))),
        ]),
    }
}

/// `SettingsPanelRow` as the browser's model writes it.
pub fn row_value(row: &PanelRow) -> Value {
    let d = &options::DEFINITIONS[row.index];
    object([
        ("applicability", Some(string(row.applicability))),
        ("availability", row.availability.map(string)),
        ("control", Some(control(&row.control))),
        (
            "dependencyController",
            row.dependency_controller.map(string),
        ),
        (
            "dependencyEnabled",
            Some(Value::Bool(row.dependency_enabled)),
        ),
        ("draftChanged", Some(Value::Bool(row.draft_changed))),
        ("editable", Some(Value::Bool(row.editable))),
        ("fieldId", Some(string(d.id))),
        ("inherit", Some(Value::Bool(row.inherit))),
        (
            "issues",
            Some(Value::Array(
                row.issues
                    .iter()
                    .map(|i| {
                        object([
                            ("code", Some(string(i.code))),
                            ("message", Some(Value::String(i.message.clone()))),
                        ])
                    })
                    .collect(),
            )),
        ),
        ("key", Some(string(d.key))),
        ("label", Some(Value::String(row.label.clone()))),
        ("origin", Some(string(row.origin.as_str()))),
        ("originLabel", Some(string(origin_label(row.origin)))),
        (
            "structuredEditor",
            row.structured_editor
                .then(|| string(structured_editor_id())),
        ),
        ("support", Some(string(&row.support))),
        ("tooltip", row.tooltip.clone().map(Value::String)),
        (
            "unavailable",
            row.unavailable.as_ref().map(|(reason, message)| {
                object([
                    ("message", Some(Value::String(message.clone()))),
                    ("reason", Some(string(reason))),
                ])
            }),
        ),
        ("unit", row.unit.clone().map(Value::String)),
        ("useDefault", Some(Value::Bool(row.use_default))),
    ])
}

/// `SettingsPanelView` as the browser's model writes it.
pub fn view_value(view: &PanelView) -> Value {
    object([
        (
            "sections",
            Some(Value::Array(
                view.sections
                    .iter()
                    .map(|s| {
                        let location = s.location;
                        object([
                            ("group", location.map(|(_, _, g)| string(g))),
                            ("id", Some(Value::String(s.id.clone()))),
                            ("label", Some(Value::String(s.label.clone()))),
                            ("page", location.map(|(_, p, _)| string(p))),
                            (
                                "rows",
                                Some(Value::Array(s.rows.iter().map(row_value).collect())),
                            ),
                            ("surface", location.map(|(surface, _, _)| string(surface))),
                        ])
                    })
                    .collect(),
            )),
        ),
        ("shown", Some(Value::Number(view.shown as f64))),
        ("summary", Some(string(&view.summary()))),
        ("unavailable", Some(Value::Number(view.unavailable as f64))),
    ])
}

/// `view`.
pub fn view_json<E, C, F>(
    panel: &PanelModel,
    request: &str,
    collation: &mut C,
    folding: &mut F,
) -> Result<String, Refusal<E>>
where
    C: Collation<Error = E>,
    F: SearchFolding<Error = E>,
{
    let mut fields = read(request, &["mode", "search"])?;
    let mode = mode(&text(&mut fields, "mode")?)?;
    let search = text(&mut fields, "search")?;
    match panel.view(mode, &search, collation, folding) {
        Ok(view) => Ok(canonical(&view_value(&view))),
        Err(PanelError::Editor(EditorError::Collation(e))) => Err(Refusal::Host(e)),
        Err(other) => Err(Refusal::InvalidEditor(other.message())),
    }
}

/// `row`.
pub fn row_json<E>(panel: &PanelModel, request: &str) -> Result<String, Refusal<E>> {
    let mut fields = read(request, &["fieldId"])?;
    let id = field_id(&mut fields)?;
    Ok(match panel.row::<E>(&id) {
        Ok(row) => canonical(&object([("row", Some(row_value(&row)))])),
        Err(e) => canonical(&object([("refused", Some(Value::String(thrown(e)?)))])),
    })
}

/// `set`, `inherit` and `useDefault`.
pub fn edit_json<E>(panel: &mut PanelModel, request: &str) -> Result<String, Refusal<E>> {
    let Ok(Value::Object(peek)) = parse(request) else {
        return Err(Refusal::InvalidRequest);
    };
    let op = match peek.get(&units("op")) {
        Some(Value::String(op)) => String::from_utf16_lossy(op),
        _ => return Err(Refusal::InvalidRequest),
    };
    let result = match op.as_str() {
        "set" => {
            let mut fields = read(request, &["fieldId", "op", "raw"])?;
            let id = field_id(&mut fields)?;
            let raw = text(&mut fields, "raw")?;
            panel.set::<E>(&id, &raw).map(|()| None)
        }
        "inherit" => {
            let mut fields = read(request, &["fieldId", "op"])?;
            panel.inherit::<E>(&field_id(&mut fields)?).map(|()| None)
        }
        "default" => {
            let mut fields = read(request, &["fieldId", "op"])?;
            panel
                .use_default::<E>(&field_id(&mut fields)?)
                .map(|outcome| match outcome {
                    DefaultOutcome::Drafted => None,
                    DefaultOutcome::Unserializable(message) => Some(units(&message)),
                })
        }
        _ => return Err(Refusal::InvalidRequest),
    };
    Ok(match result {
        Ok(None) => outcome("applied", None),
        Ok(Some(message)) => outcome("unserializable", Some(message)),
        Err(e) => outcome("refused", Some(thrown(e)?)),
    })
}

/// `state`, with the number of drafted fields.
pub fn state_json<E>(panel: &PanelModel) -> Result<String, Refusal<E>> {
    let state = panel
        .state::<E>()
        .map_err(|e| Refusal::InvalidEditor(e.message()))?;
    Ok(canonical(&object([
        ("changed", Some(Value::Bool(state.changed))),
        ("drafts", Some(Value::Number(panel.drafts().count() as f64))),
        ("invalid", Some(Value::Bool(state.invalid))),
    ])))
}

/// Apply's commit: the reply, and the commit when it changes something. A
/// commit without changes drops the drafts, as the panel does.
pub fn apply<C: Collation>(
    panel: &mut PanelModel,
    collation: &mut C,
) -> Result<(String, Option<Commit>), Refusal<C::Error>> {
    match panel.prepare(collation) {
        Ok(commit) if commit.changes.is_empty() => {
            panel.discard();
            Ok((outcome("unchanged", None), None))
        }
        Ok(commit) => Ok((
            canonical(&object([
                ("changes", Some(Value::Number(commit.changes.len() as f64))),
                ("outcome", Some(string("committed"))),
            ])),
            Some(commit),
        )),
        Err(PanelError::Editor(EditorError::Collation(e))) => Err(Refusal::Host(e)),
        Err(PanelError::Editor(e @ EditorError::Invalid(_))) => {
            Ok((outcome("invalid", Some(e.message())), None))
        }
        Err(other) => Ok((outcome("failed", Some(other.message())), None)),
    }
}

/// The scoped panel's words for one target: its picker text, its summary
/// and its heading.
pub fn target_text_json(request: &str) -> Result<String, &'static str> {
    const INVALID: &str = "invalid_request";
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err("input_limit");
    }
    let mut fields =
        read::<()>(request, &["label", "overrideCount", "path", "scope"]).map_err(|_| INVALID)?;
    let label = text::<()>(&mut fields, "label").map_err(|_| INVALID)?;
    let path = text::<()>(&mut fields, "path").map_err(|_| INVALID)?;
    let scope = text::<()>(&mut fields, "scope").map_err(|_| INVALID)?;
    let scope = SettingScope::from_utf16(&scope).ok_or(INVALID)?;
    let count = match fields.remove(&units("overrideCount")) {
        Some(Value::Number(n)) if n >= 0.0 && n.fract() == 0.0 && n <= 9_007_199_254_740_991.0 => {
            n as u64
        }
        _ => return Err(INVALID),
    };
    Ok(canonical(&object([
        ("heading", Some(Value::String(heading(scope, &label)))),
        ("summary", Some(string(&summary(scope)))),
        (
            "text",
            Some(Value::String(option_text(scope, &path, count))),
        ),
    ])))
}
