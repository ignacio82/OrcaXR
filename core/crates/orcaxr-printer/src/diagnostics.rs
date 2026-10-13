//! File → Export Diagnostics… (`DiagnosticsBundle.ts` through
//! `diagnosticsExchange.ts`): the bundle a support request carries, its
//! privacy preview and its recorded events, byte for byte the browser's.
//!
//! The host supplies the facts (`DiagnosticsInput`, its objects read in the
//! interface's order); the bundle is assembled as `buildDiagnosticsBundle`
//! does — the last 200 log entries, object names only when asked for (the
//! first 64, each redacted and at most 120 units), what was left out — then
//! passed once more through `redactMoonrakerDiagnostic` (every string
//! redacted, every array cut to its first 32 items), written as
//! `JSON.stringify(bundle, null, 2)` and a line break, and described in the
//! preview's words (`describeDiagnosticsBundle`). A recorded event
//! (`diagnosticEntry`) keeps 64 units of its scope and its message struck of
//! the session's secrets (those of at least 8 units) and the pattern rules.
use crate::moonraker::redact_text;
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_contracts::capabilities::{ACTIONS, Status};
use orcaxr_project::js_math::convert::{json_stringify, number_to_string};
use std::collections::BTreeMap;

pub const INVALID_REQUEST: &str = "invalid_request";
/// `MAX_LOG_ENTRIES`: the entries a bundle keeps, the newest.
pub const MAX_LOG_ENTRIES: usize = 200;
/// `redactValue`'s cut of every array.
const MAX_ARRAY_ITEMS: usize = 32;
const MAX_SCOPE_UNITS: usize = 64;
const MAX_NAME_UNITS: usize = 120;
const MAX_NAMES: usize = 64;
const MIN_SECRET_UNITS: usize = 8;

type Fields = BTreeMap<Vec<u16>, Value>;

/// A JSON value in the order JavaScript enumerates the browser's objects.
enum Json {
    Bool(bool),
    Number(f64),
    String(Vec<u16>),
    Array(Vec<Json>),
    Object(Vec<(&'static str, Json)>),
}

fn units(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}

fn canonical(members: impl IntoIterator<Item = (&'static str, Value)>) -> String {
    let value = Value::Object(members.into_iter().map(|(k, v)| (units(k), v)).collect());
    let mut bytes = Vec::new();
    value
        .write_canonical(&mut bytes)
        .expect("writing to memory cannot fail");
    String::from_utf8(bytes).expect("canonical JSON is UTF-8")
}

/// The object [value] with every key of [required] and none outside [optional].
fn object<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a Fields, &'static str> {
    let Value::Object(fields) = value else {
        return Err(INVALID_REQUEST);
    };
    let known = |key: &Vec<u16>| required.iter().chain(optional).any(|k| units(k) == *key);
    if fields.keys().any(|key| !known(key))
        || required.iter().any(|k| !fields.contains_key(&units(k)))
    {
        return Err(INVALID_REQUEST);
    }
    Ok(fields)
}

fn get<'a>(fields: &'a Fields, key: &str) -> Option<&'a Value> {
    fields.get(&units(key))
}
fn text(value: Option<&Value>) -> Result<Vec<u16>, &'static str> {
    match value {
        Some(Value::String(s)) => Ok(s.clone()),
        _ => Err(INVALID_REQUEST),
    }
}
fn number(value: Option<&Value>) -> Result<f64, &'static str> {
    match value {
        Some(Value::Number(n)) if n.is_finite() => Ok(*n),
        _ => Err(INVALID_REQUEST),
    }
}
fn flag(value: Option<&Value>) -> Result<bool, &'static str> {
    match value {
        Some(Value::Bool(b)) => Ok(*b),
        _ => Err(INVALID_REQUEST),
    }
}
fn texts(value: Option<&Value>) -> Result<Vec<Vec<u16>>, &'static str> {
    match value {
        Some(Value::Array(items)) => items.iter().map(|item| text(Some(item))).collect(),
        _ => Err(INVALID_REQUEST),
    }
}

/// The object of [fields]'s [keys] in that order, each read by its kind; an absent optional key is left out.
fn members(fields: &Fields, keys: &[(&'static str, Kind)]) -> Result<Json, &'static str> {
    let mut out = Vec::new();
    for &(key, kind) in keys {
        let Some(value) = get(fields, key) else {
            continue;
        };
        let value = Some(value);
        out.push((
            key,
            match kind {
                Kind::Text => Json::String(text(value)?),
                Kind::Number => Json::Number(number(value)?),
                Kind::Flag => Json::Bool(flag(value)?),
                Kind::Texts => Json::Array(texts(value)?.into_iter().map(Json::String).collect()),
            },
        ));
    }
    Ok(Json::Object(out))
}

#[derive(Clone, Copy)]
enum Kind {
    Text,
    Number,
    Flag,
    Texts,
}

/// A section of the input: its keys in the interface's order, the required ones first named.
fn section(value: &Value, keys: &[(&'static str, Kind, bool)]) -> Result<Json, &'static str> {
    let required: Vec<&str> = keys.iter().filter(|k| k.2).map(|k| k.0).collect();
    let optional: Vec<&str> = keys.iter().filter(|k| !k.2).map(|k| k.0).collect();
    let fields = object(value, &required, &optional)?;
    members(fields, &keys.iter().map(|k| (k.0, k.1)).collect::<Vec<_>>())
}

const LEVELS: [&str; 3] = ["info", "warning", "error"];

/// One `DiagnosticEntry` of a request, its keys in the entry's order.
fn entry(value: &Value) -> Result<Json, &'static str> {
    let fields = object(value, &["atMs", "level", "scope", "message"], &[])?;
    let level = text(get(fields, "level"))?;
    if !LEVELS.iter().any(|l| units(l) == level) {
        return Err(INVALID_REQUEST);
    }
    members(
        fields,
        &[
            ("atMs", Kind::Number),
            ("level", Kind::Text),
            ("scope", Kind::Text),
            ("message", Kind::Text),
        ],
    )
}

/// `redactMoonrakerDiagnostic` over the assembled bundle: no secrets, every
/// string redacted, every array its first 32 items. No key of a bundle is
/// one `SENSITIVE_KEY` names, and none nests deeper than its limit.
fn redacted(value: Json) -> Json {
    match value {
        Json::String(s) => Json::String(redact_text(&s, &[])),
        Json::Array(items) => Json::Array(
            items
                .into_iter()
                .take(MAX_ARRAY_ITEMS)
                .map(redacted)
                .collect(),
        ),
        Json::Object(members) => {
            Json::Object(members.into_iter().map(|(k, v)| (k, redacted(v))).collect())
        }
        other => other,
    }
}

/// `JSON.stringify(value, null, 2)`.
fn pretty(value: &Json, depth: usize, out: &mut Vec<u16>) {
    let indent = |out: &mut Vec<u16>, depth: usize| {
        out.extend(std::iter::repeat_n(u16::from(b' '), 2 * depth))
    };
    match value {
        Json::Bool(b) => out.extend(units(if *b { "true" } else { "false" })),
        Json::Number(n) => out.extend(js_number(*n)),
        Json::String(s) => out.extend(json_stringify(&Value::String(s.clone()))),
        Json::Array(items) if items.is_empty() => out.extend(units("[]")),
        Json::Object(members) if members.is_empty() => out.extend(units("{}")),
        Json::Array(items) => {
            out.push(u16::from(b'['));
            for (i, item) in items.iter().enumerate() {
                out.extend(units(if i == 0 { "\n" } else { ",\n" }));
                indent(out, depth + 1);
                pretty(item, depth + 1, out);
            }
            out.push(u16::from(b'\n'));
            indent(out, depth);
            out.push(u16::from(b']'));
        }
        Json::Object(members) => {
            out.push(u16::from(b'{'));
            for (i, (key, item)) in members.iter().enumerate() {
                out.extend(units(if i == 0 { "\n" } else { ",\n" }));
                indent(out, depth + 1);
                out.extend(json_stringify(&Value::String(units(key))));
                out.extend(units(": "));
                pretty(item, depth + 1, out);
            }
            out.push(u16::from(b'\n'));
            indent(out, depth);
            out.push(u16::from(b'}'));
        }
    }
}

/// `String(n)` of a finite number: -0 is `0`.
fn js_number(n: f64) -> Vec<u16> {
    units(&number_to_string(if n == 0.0 { 0.0 } else { n }))
}

fn field<'a>(value: &'a Json, key: &str) -> Option<&'a Json> {
    match value {
        Json::Object(members) => members.iter().find(|(k, _)| *k == key).map(|(_, v)| v),
        _ => None,
    }
}
fn shown(value: Option<&Json>) -> Vec<u16> {
    match value {
        Some(Json::Number(n)) => js_number(*n),
        Some(Json::String(s)) => s.clone(),
        Some(Json::Bool(b)) => units(if *b { "true" } else { "false" }),
        _ => units("undefined"),
    }
}

/// `describeDiagnosticsBundle`: the privacy preview's account of [bundle].
fn describe(bundle: &Json) -> Vec<u16> {
    let engine = field(bundle, "engine");
    let commit = shown(engine.and_then(|e| field(e, "commit")));
    let mut lines: Vec<Vec<u16>> = Vec::new();
    let mut line = units("OrcaXR ");
    line.extend(shown(field(bundle, "appVersion")));
    line.extend(units(" · engine "));
    line.extend(&commit[..commit.len().min(7)]);
    line.extend(units(" · "));
    line.extend(shown(engine.and_then(|e| field(e, "route"))));
    lines.push(line);
    let entries = match field(bundle, "log") {
        Some(Json::Array(items)) => items.len(),
        _ => 0,
    };
    let mut line = units(&format!("{entries} log entries, "));
    line.extend(shown(
        field(bundle, "capabilities").and_then(|c| field(c, "actionCount")),
    ));
    line.extend(units(" actions"));
    lines.push(line);
    if let Some(project) = field(bundle, "project") {
        let count = |key| shown(field(project, key));
        let mut line = units("Project shape only: ");
        line.extend(count("plateCount"));
        line.extend(units(" plate(s), "));
        line.extend(count("objectCount"));
        line.extend(units(" object(s), "));
        line.extend(count("triangleCount"));
        line.extend(units(" triangles"));
        if let Some(Json::Array(names)) = field(project, "objectNames") {
            line.extend(units(&format!(", including {} name(s)", names.len())));
        }
        lines.push(line);
    }
    if let Some(printer) = field(bundle, "printer") {
        let on = |key, yes, no| {
            if matches!(field(printer, key), Some(Json::Bool(true))) {
                yes
            } else {
                no
            }
        };
        lines.push(units(&format!(
            "Printer: {}, {}",
            on("configured", "configured", "not configured"),
            on("connected", "connected", "offline")
        )));
    }
    let mut line = units("Left out: ");
    if let Some(Json::Array(omitted)) = field(bundle, "omitted") {
        for (i, item) in omitted.iter().enumerate() {
            if i > 0 {
                line.extend(units("; "));
            }
            line.extend(shown(Some(item)));
        }
    }
    line.push(u16::from(b'.'));
    lines.push(line);
    lines.join(&u16::from(b'\n'))
}

/// `diagnosticsBundleExchange`: `{"input": DiagnosticsInput, "includeModelNames"}`
/// → `{"description","file","logEntries"}`, the bundle written and described
/// as the browser writes and describes it.
pub fn bundle_json(request: &str) -> Result<String, &'static str> {
    let request = parse(request).map_err(|_| INVALID_REQUEST)?;
    let request = object(&request, &["includeModelNames", "input"], &[])?;
    let include_names = flag(get(request, "includeModelNames"))?;
    let input = object(
        get(request, "input").ok_or(INVALID_REQUEST)?,
        &["appVersion", "engine", "browser", "capabilities", "log"],
        &["xr", "printer", "performance", "project"],
    )?;
    use Kind::*;
    let mut bundle = vec![
        ("format", Json::String(units("orcaxr.diagnostics"))),
        ("schemaVersion", Json::Number(1.0)),
        ("appVersion", Json::String(text(get(input, "appVersion"))?)),
        (
            "engine",
            section(
                get(input, "engine").ok_or(INVALID_REQUEST)?,
                &[
                    ("commit", Text, true),
                    ("route", Text, true),
                    ("externalAttested", Flag, false),
                ],
            )?,
        ),
        (
            "browser",
            section(
                get(input, "browser").ok_or(INVALID_REQUEST)?,
                &[
                    ("userAgent", Text, true),
                    ("language", Text, true),
                    ("hardwareConcurrency", Number, false),
                    ("deviceMemoryGb", Number, false),
                    ("crossOriginIsolated", Flag, false),
                ],
            )?,
        ),
    ];
    if let Some(xr) = get(input, "xr") {
        bundle.push((
            "xr",
            section(
                xr,
                &[("supported", Flag, true), ("sessionActive", Flag, true)],
            )?,
        ));
    }
    if let Some(printer) = get(input, "printer") {
        bundle.push((
            "printer",
            section(
                printer,
                &[
                    ("configured", Flag, true),
                    ("connected", Flag, true),
                    ("capabilities", Texts, false),
                    ("jobState", Text, false),
                ],
            )?,
        ));
    }
    bundle.push((
        "capabilities",
        section(
            get(input, "capabilities").ok_or(INVALID_REQUEST)?,
            &[
                ("actionCount", Number, true),
                ("unavailableCount", Number, true),
            ],
        )?,
    ));
    if let Some(performance) = get(input, "performance") {
        bundle.push((
            "performance",
            section(
                performance,
                &[
                    ("usedHeapMb", Number, false),
                    ("totalHeapMb", Number, false),
                    ("uptimeSeconds", Number, false),
                ],
            )?,
        ));
    }
    let counts = [
        "plateCount",
        "objectCount",
        "volumeCount",
        "triangleCount",
        "physicalFilamentCount",
        "mixedFilamentCount",
        "paintedVolumeCount",
    ];
    if let Some(project) = get(input, "project") {
        let mut required = counts.to_vec();
        required.push("objectNames");
        let fields = object(project, &required, &[])?;
        let mut members = Vec::new();
        for key in counts {
            members.push((key, Json::Number(number(get(fields, key))?)));
        }
        let names = texts(get(fields, "objectNames"))?;
        if include_names {
            let safe = |name: &Vec<u16>| {
                let mut name = redact_text(name, &[]);
                name.truncate(MAX_NAME_UNITS);
                Json::String(name)
            };
            members.push((
                "objectNames",
                Json::Array(names.iter().take(MAX_NAMES).map(safe).collect()),
            ));
        }
        bundle.push(("project", Json::Object(members)));
    }
    let Some(Value::Array(log)) = get(input, "log") else {
        return Err(INVALID_REQUEST);
    };
    let log = log.iter().map(entry).collect::<Result<Vec<_>, _>>()?;
    let newest = log.len().saturating_sub(MAX_LOG_ENTRIES);
    bundle.push(("log", Json::Array(log.into_iter().skip(newest).collect())));
    let mut omitted = vec![
        "G-code and project geometry",
        "printer and slicer addresses",
        "API keys and tokens",
    ];
    if !include_names {
        omitted.push("model and object names");
    }
    bundle.push((
        "omitted",
        Json::Array(
            omitted
                .into_iter()
                .map(|o| Json::String(units(o)))
                .collect(),
        ),
    ));
    let bundle = redacted(Json::Object(bundle));
    let mut file = Vec::new();
    pretty(&bundle, 0, &mut file);
    file.push(u16::from(b'\n'));
    let entries = match field(&bundle, "log") {
        Some(Json::Array(items)) => items.len(),
        _ => 0,
    };
    Ok(canonical([
        ("description", Value::String(describe(&bundle))),
        ("file", Value::String(file)),
        ("logEntries", Value::Number(entries as f64)),
    ]))
}

/// `diagnosticEntryExchange`: `{"atMs","level","message","scope","secrets"}`
/// → the entry the recorder keeps, `{"atMs","level","message","scope"}`.
pub fn entry_json(request: &str) -> Result<String, &'static str> {
    let request = parse(request).map_err(|_| INVALID_REQUEST)?;
    let fields = object(
        &request,
        &["atMs", "level", "message", "scope", "secrets"],
        &[],
    )?;
    let at = number(get(fields, "atMs"))?;
    let level = text(get(fields, "level"))?;
    if !LEVELS.iter().any(|l| units(l) == level) {
        return Err(INVALID_REQUEST);
    }
    let secrets = texts(get(fields, "secrets"))?;
    let secrets: Vec<&[u16]> = secrets
        .iter()
        .filter(|s| s.len() >= MIN_SECRET_UNITS)
        .map(Vec::as_slice)
        .collect();
    let mut scope = text(get(fields, "scope"))?;
    scope.truncate(MAX_SCOPE_UNITS);
    let message = redact_text(&text(get(fields, "message"))?, &secrets);
    Ok(canonical([
        ("atMs", Value::Number(at)),
        ("level", Value::String(level)),
        ("message", Value::String(message)),
        ("scope", Value::String(scope)),
    ]))
}

/// `diagnosticsFactsExchange`: what the core knows that a bundle states —
/// the catalogue's actions and the unavailable ones (`diagnosticsCapabilities`
/// over the registry) and the engine build the client accepts.
pub fn facts_json() -> String {
    canonical([
        ("actionCount", Value::Number(ACTIONS.len() as f64)),
        (
            "engineCommit",
            Value::String(units(orcaxr_project::settings::library::ENGINE_COMMIT)),
        ),
        (
            "unavailableCount",
            Value::Number(
                ACTIONS
                    .iter()
                    .filter(|a| a.status == Status::Unavailable)
                    .count() as f64,
            ),
        ),
    ])
}
