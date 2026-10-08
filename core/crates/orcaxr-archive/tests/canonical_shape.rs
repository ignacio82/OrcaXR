//! Canonical state shapes, field by field, against the browser: every schema
//! position of the `project-model-vectors` states deleted, nulled or replaced
//! by each other JSON type (`canonical-shape-vectors.mjs`) is admitted by
//! `canonical::admit_state` exactly when the browser's `admitCanonicalState`
//! admits it, to the same state and warnings.
use orcaxr_archive::{
    canonical::{ImportWarning, MigrationCounts, admit_state},
    text::import_warnings,
};
use orcaxr_contracts::canonical::{Value, parse};
use orcaxr_project::{
    model::Encode,
    validation::{TimestampPolicy, V8Timestamps, timestamp},
};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn key(text: &str) -> Vec<u16> {
    text.encode_utf16().collect()
}
/// Text as the generator writes it: a string, or UTF-16 units when it holds a
/// lone surrogate.
fn units(value: &serde_json::Value) -> Vec<u16> {
    match value {
        serde_json::Value::String(text) => key(text),
        serde_json::Value::Array(units) => {
            units.iter().map(|u| u.as_u64().unwrap() as u16).collect()
        }
        _ => panic!("not text"),
    }
}

/// The warnings an Open reports for these migrations.
fn migration_warnings(
    state: &orcaxr_project::model::ProjectState,
    counts: &MigrationCounts,
) -> Vec<Vec<u16>> {
    let mut warnings = Vec::new();
    if counts.dense_channels > 0 {
        warnings.push(ImportWarning::DenseChannels(counts.dense_channels));
    }
    if counts.false_fuzzy_assignments > 0 {
        warnings.push(ImportWarning::FalseFuzzyAssignments(
            counts.false_fuzzy_assignments,
        ));
    }
    import_warnings(state, &warnings)
}

/// The generator's mutation at a path; deletion only of object members.
fn mutate(state: &mut Value, path: &[serde_json::Value], kind: &str) {
    let mut parent = state;
    for step in &path[..path.len() - 1] {
        parent = match (parent, step) {
            (Value::Object(fields), name) => fields.get_mut(&units(name)).unwrap(),
            (Value::Array(items), serde_json::Value::Number(index)) => {
                &mut items[index.as_u64().unwrap() as usize]
            }
            _ => panic!("path does not resolve"),
        };
    }
    let replacement = match kind {
        "delete" => None,
        "null" => Some(Value::Null),
        "string" => Some(Value::String(key("x"))),
        "number" => Some(Value::Number(7.0)),
        "boolean" => Some(Value::Bool(true)),
        "array" => Some(Value::Array(Vec::new())),
        "object" => Some(Value::Object(BTreeMap::new())),
        _ => panic!("unknown mutation {kind}"),
    };
    match (parent, &path[path.len() - 1], replacement) {
        (Value::Object(fields), name, None) => {
            fields.remove(&units(name));
        }
        (Value::Object(fields), name, Some(value)) => {
            fields.insert(units(name), value);
        }
        (Value::Array(items), serde_json::Value::Number(index), Some(value)) => {
            items[index.as_u64().unwrap() as usize] = value;
        }
        _ => panic!("mutation does not apply"),
    }
}

#[test]
fn canonical_state_shapes_admit_as_the_browser_admits_them() {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/canonical-shape-vectors.json"
    ))
    .unwrap();
    let models: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/project-model-vectors.json"
    ))
    .unwrap();
    // A model's state by name, or a derived state in full.
    let names: Vec<&str> = corpus["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|base| base["model"].as_str().unwrap())
        .collect();
    let bases: Vec<Value> = corpus["bases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|base| {
            let text = match base.get("stateJson") {
                Some(text) => text,
                None => &models["cases"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|model| model["name"] == base["model"])
                    .unwrap()["stateJson"],
            };
            parse(text.as_str().unwrap()).unwrap()
        })
        .collect();
    let mut failures = Vec::new();
    let (mut accepted, mut refused) = (0, 0);
    for case in corpus["cases"].as_array().unwrap() {
        let base = case["base"].as_u64().unwrap() as usize;
        let path = case["path"].as_array().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let mut state = bases[base].clone();
        mutate(&mut state, path, kind);
        let label = format!(
            "{} {} {kind}",
            names[base],
            serde_json::to_string(path).unwrap()
        );
        let expected = &case["expected"];
        match (
            admit_state(state, &mut utc(), || false),
            expected["accepted"].as_bool().unwrap(),
        ) {
            (Ok((project, counts)), true) => {
                let mut json = Vec::new();
                project.state().write_json(&mut json).unwrap();
                if sha256(&json) != expected["stateSha256"].as_str().unwrap() {
                    failures.push(format!("{label}: admitted state differs"));
                }
                let warnings: Vec<Vec<u16>> = expected["warnings"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(units)
                    .collect();
                if migration_warnings(project.state(), &counts) != warnings {
                    failures.push(format!("{label}: warnings differ"));
                }
                accepted += 1;
            }
            (Err(_), false) => refused += 1,
            (Ok(_), false) => failures.push(format!("{label}: native admitted a browser refusal")),
            (Err(e), true) => failures.push(format!("{label}: native refused: {e:?}")),
        }
    }
    let shown: Vec<_> = failures.iter().take(40).collect();
    assert!(
        failures.is_empty(),
        "{} failures:\n{shown:#?}",
        failures.len()
    );
    assert_eq!((accepted, refused), (4623, 2238));
}
