//! The volume-role editor (`objects/volumeRoleEditor.ts`): one part's role
//! with every role it could become in upstream Orca's order — the current one
//! marked, each other offered only when the conversion command would accept
//! it, a blocked one explained in the command's words — the conversion
//! command's decision for any role text, and what a conversion says while it
//! runs and once it is done: canonical JSON requests and replies, in the
//! browser's words (`volumeRoleEditorExchange.ts`).
//!
//! - `decision_json` `{"role","volumeId"}` → `{"allowed":true,"noop"}` or
//!   `{"allowed":false,"code","reason"}`;
//! - `projection_json` `{"volumeId"}` → `{"projection"}`: null for a volume
//!   the project lacks, else `{"choices","objectId","objectName","role",
//!   "summary","volumeId","volumeName"}`, each choice `{"blockedReason"?,
//!   "current","decision","label","role"}`;
//! - `messages_json` `{"role","volumeName"}` → `{"pending","success"}`.
use crate::{
    commands::{
        VOLUME_ROLE_ORDER, VolumeRoleDecision, decide_volume_role, inspect_volume_role_conversion,
    },
    model::{ProjectState, VolumeRole},
};
use orcaxr_contracts::canonical::{Value, parse};
use std::collections::BTreeMap;

pub use crate::placement::bed::{INPUT_LIMIT, INVALID_REQUEST};

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
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
/// The request's members, exactly [keys], each a string.
fn texts<const N: usize>(request: &str, keys: [&str; N]) -> Result<[Vec<u16>; N], &'static str> {
    if request.len() > orcaxr_contracts::generated::MAX_INPUT_BYTES {
        return Err(INPUT_LIMIT);
    }
    let Ok(Value::Object(mut fields)) = parse(request) else {
        return Err(INVALID_REQUEST);
    };
    if fields.len() != N {
        return Err(INVALID_REQUEST);
    }
    let mut out: [Vec<u16>; N] = std::array::from_fn(|_| Vec::new());
    for (slot, key) in out.iter_mut().zip(keys) {
        match fields.remove(&units(key)) {
            Some(Value::String(text)) => *slot = text,
            _ => return Err(INVALID_REQUEST),
        }
    }
    Ok(out)
}
fn with(text: &[u16], parts: &[&str]) -> Vec<u16> {
    let mut out = units(parts[0]);
    out.extend_from_slice(text);
    out.extend(parts[1].encode_utf16());
    out
}

/// `volumeRoleLabel`.
pub fn label(role: VolumeRole) -> &'static str {
    match role {
        VolumeRole::Model => "Part",
        VolumeRole::NegativeVolume => "Negative volume",
        VolumeRole::ParameterModifier => "Parameter modifier",
        VolumeRole::SupportBlocker => "Support blocker",
        VolumeRole::SupportEnforcer => "Support enforcer",
    }
}

/// `volumeRoleBlockReason` for a choice with one decision: the current role
/// (or a conversion that changes nothing), or the command's refusal.
pub fn block_reason(decision: &VolumeRoleDecision, current: bool) -> Option<Vec<u16>> {
    match decision {
        _ if current => Some(units("This is the current role; no conversion is needed.")),
        VolumeRoleDecision::Allowed { noop: true } => {
            Some(units("This is the current role; no conversion is needed."))
        }
        VolumeRoleDecision::Allowed { noop: false } => None,
        VolumeRoleDecision::Blocked { reason, .. } => Some(reason.units().to_vec()),
    }
}

fn decision_value(decision: &VolumeRoleDecision) -> Value {
    match decision {
        VolumeRoleDecision::Allowed { noop } => object([
            ("allowed", Some(Value::Bool(true))),
            ("noop", Some(Value::Bool(*noop))),
        ]),
        VolumeRoleDecision::Blocked { code, reason } => object([
            ("allowed", Some(Value::Bool(false))),
            ("code", Some(string(code.code()))),
            ("reason", Some(Value::String(reason.units().to_vec()))),
        ]),
    }
}

/// `inspectVolumeRoleConversion` as a reply.
pub fn decision_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    let [role, volume] = texts(request, ["role", "volumeId"])?;
    Ok(canonical(&decision_value(&inspect_volume_role_conversion(
        state, &volume, &role,
    ))))
}

/// `volumeRoleEditorProjection` as a reply.
pub fn projection_json(state: &ProjectState, request: &str) -> Result<String, &'static str> {
    let [volume_id] = texts(request, ["volumeId"])?;
    let Some((object_record, volume)) = state
        .plates
        .iter()
        .flat_map(|plate| plate.objects.iter())
        .find_map(|o| {
            o.volumes
                .iter()
                .find(|v| v.id.as_utf16() == volume_id.as_slice())
                .map(|v| (o, v))
        })
    else {
        return Ok(canonical(&object([("projection", Some(Value::Null))])));
    };
    let name = volume.name.units();
    let choices = VOLUME_ROLE_ORDER
        .iter()
        .map(|role| {
            let decision = decide_volume_role(state, &volume_id, *role);
            let current = volume.role == *role;
            object([
                (
                    "blockedReason",
                    block_reason(&decision, current).map(Value::String),
                ),
                ("current", Some(Value::Bool(current))),
                ("decision", Some(decision_value(&decision))),
                ("label", Some(string(label(*role)))),
                ("role", Some(string(role.as_str()))),
            ])
        })
        .collect();
    Ok(canonical(&object([(
        "projection",
        Some(object([
            ("choices", Some(Value::Array(choices))),
            (
                "objectId",
                Some(Value::String(object_record.id.as_utf16().to_vec())),
            ),
            (
                "objectName",
                Some(Value::String(object_record.name.units().to_vec())),
            ),
            ("role", Some(string(volume.role.as_str()))),
            (
                "summary",
                Some(Value::String(with(
                    name,
                    &["", &format!(" \u{2014} {}", label(volume.role))],
                ))),
            ),
            ("volumeId", Some(Value::String(volume_id.clone()))),
            ("volumeName", Some(Value::String(name.to_vec()))),
        ])),
    )])))
}

/// `volumeRoleOperationMessages` as a reply; the role must be one Orca has.
pub fn messages_json(request: &str) -> Result<String, &'static str> {
    let [role, name] = texts(request, ["role", "volumeName"])?;
    let role = VOLUME_ROLE_ORDER
        .iter()
        .find(|r| r.as_str().encode_utf16().eq(role.iter().copied()))
        .ok_or(INVALID_REQUEST)?;
    let label = label(*role);
    let mut fields = BTreeMap::new();
    fields.insert(
        units("pending"),
        Value::String(with(
            &name,
            &["Converting ", &format!(" to {label}\u{2026}")],
        )),
    );
    fields.insert(
        units("success"),
        Value::String(with(&name, &["Converted ", &format!(" to {label}.")])),
    );
    Ok(canonical(&Value::Object(fields)))
}
