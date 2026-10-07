//! The native model import transaction against the production browser's
//! `ProjectImportCoordinator` + `ModelImportParser` over a real `CommandBus`
//! (`tools/cross-platform/model-transaction-vectors.mjs`): identical previews
//! and staged bundles, confirmation refusals (missing acknowledgements, blocked,
//! stale), one undoable `Import <filename>` entry, and undo/redo through the
//! real session wire protocol restoring the exact base and committed states.
#[allow(dead_code)]
#[path = "support/canonical_complete.rs"]
mod complete;
use orcaxr_archive::models::{
    self, Limits,
    stage::{IdKind, Placement, stage},
};
use orcaxr_contracts::canonical::{self, Value};
use orcaxr_project::{
    assets::{AssetPayload, AssetRepository},
    history::HistorySnapshot,
    import::{self, ConfirmError, Parsed, Source},
    model::{Decode, Encode, ProjectData, ProjectState},
    selection::SelectionStore,
    session::{ImportCommitError, ProjectSession, Submission},
    validation::{TimestampPolicy, ValidatedProject},
};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::HashMap;

fn read(name: &str) -> Json {
    let path = root().join("testdata/cross-platform").join(name);
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}
fn root() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..")
}
fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn canonical_json(value: &Value) -> String {
    let mut out = Vec::new();
    value.write_canonical(&mut out).unwrap();
    String::from_utf8(out).unwrap()
}
fn units(value: &Json) -> Vec<u16> {
    match value {
        Json::String(s) => s.encode_utf16().collect(),
        Json::Array(u) => u.iter().map(|v| v.as_u64().unwrap() as u16).collect(),
        other => panic!("{other}"),
    }
}
fn text(units: &[u16]) -> String {
    String::from_utf16(units).unwrap()
}
fn state_record(state: &Value) -> Json {
    let json = canonical_json(state);
    // The browser measures UTF-16 length.
    if json.encode_utf16().count() <= 64 * 1024 {
        json!({ "stateJson": json })
    } else {
        json!({ "stateSha256": sha(json.as_bytes()) })
    }
}
fn assets_record(list: &[AssetPayload]) -> Json {
    json!(list.iter().map(|a| json!({ "descriptorJson": canonical_json(&a.descriptor), "bytesSha256": sha(&a.bytes) })).collect::<Vec<_>>())
}
fn history_record(h: &HistorySnapshot) -> String {
    let mut fields = serde_json::Map::new();
    fields.insert(
        "dirtyCategories".into(),
        json!(
            h.dirty_categories
                .iter()
                .map(|c| match c {
                    orcaxr_contracts::project_intent_types::DirtyCategory::ProjectData =>
                        "projectData",
                    orcaxr_contracts::project_intent_types::DirtyCategory::Presets => "presets",
                    orcaxr_contracts::project_intent_types::DirtyCategory::PrinterDevice =>
                        "printerDevice",
                })
                .collect::<Vec<_>>()
        ),
    );
    fields.insert("redoCount".into(), json!(h.redo_count));
    if let Some(label) = &h.redo_label {
        fields.insert("redoLabel".into(), json!(text(label.units())));
    }
    fields.insert("undoCount".into(), json!(h.undo_count));
    if let Some(label) = &h.undo_label {
        fields.insert("undoLabel".into(), json!(text(label.units())));
    }
    // serde_json maps keep insertion order here; keys were inserted sorted.
    serde_json::to_string(&Json::Object(fields)).unwrap()
}
fn limits(value: Option<&Json>) -> Limits {
    let mut limits = Limits::default();
    if let Some(Json::Object(fields)) = value {
        for (key, value) in fields {
            let n = value.as_u64().unwrap() as usize;
            match key.as_str() {
                "maxTriangles" => limits.max_triangles = n,
                "maxVertices" => limits.max_vertices = n,
                "maxBytes" => limits.max_bytes = n,
                "maxObjects" => limits.max_objects = n,
                "maxNameLength" => limits.max_name_length = n,
                other => panic!("{other}"),
            }
        }
    }
    limits
}
fn placement(value: &Json) -> Placement {
    Placement {
        bed_size_mm: value["bedSizeMm"]
            .as_array()
            .map(|v| [v[0].as_f64().unwrap(), v[1].as_f64().unwrap()]),
        drop_to_bed: value["dropToBed"].as_bool().unwrap_or(false),
    }
}
fn bytes_of(row: &Json) -> Vec<u8> {
    match &row["bytesBase64"] {
        Json::String(b64) => base64(b64),
        _ => std::fs::read(root().join(row["path"].as_str().unwrap())).unwrap(),
    }
}

fn session(
    state: &ProjectState,
    assets: &[AssetPayload],
) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let mut timestamps = complete::utc();
    let project =
        ValidatedProject::new(ProjectData::new(state.clone()).unwrap(), &mut timestamps).unwrap();
    let mut repository = AssetRepository::new();
    repository.restore(assets).unwrap();
    ProjectSession::new(
        project,
        SelectionStore::default(),
        repository,
        timestamps,
        Default::default(),
        [0, 1, 2, 3],
    )
    .unwrap()
}

enum Prepared {
    Error(&'static str),
    Ready(Box<import::Prepared>, Vec<&'static str>),
}
fn prepare<P: TimestampPolicy>(
    owner: &ProjectSession<P>,
    row: &Json,
    place: Placement,
    namespace: &str,
    imported_at: &[u16],
) -> Prepared {
    let filename = units(&row["filename"]);
    let decoded = match models::decode(
        &bytes_of(row),
        &filename,
        &limits(row.get("limits")),
        || false,
    ) {
        Ok(decoded) => decoded,
        Err(_) => return Prepared::Error("ImportPreparationError"),
    };
    let base_assets: Vec<AssetPayload> = owner.assets().list();
    let descriptors: Vec<Value> = base_assets.iter().map(|a| a.descriptor.clone()).collect();
    let mut requests = Vec::new();
    let mut next = |kind: IdKind| {
        requests.push(kind.code());
        format!("import:{namespace}:{}-{}", kind.code(), requests.len())
            .encode_utf16()
            .collect()
    };
    let snapshot = owner.snapshot();
    let staged = match stage(
        &decoded,
        snapshot.state(),
        &descriptors,
        imported_at,
        place,
        &mut next,
        || false,
    ) {
        Ok(staged) => staged,
        Err(_) => return Prepared::Error("ImportPreparationError"),
    };
    let base_content: HashMap<Vec<u16>, String> = owner
        .assets()
        .list()
        .iter()
        .map(|a| {
            (
                match &a.descriptor {
                    Value::Object(f) => match f.get(&"id".encode_utf16().collect::<Vec<_>>()) {
                        Some(Value::String(id)) => id.clone(),
                        _ => vec![],
                    },
                    _ => vec![],
                },
                orcaxr_project::assets::content_digest(&a.bytes),
            )
        })
        .collect();
    let parsed = Parsed {
        state: staged.state,
        assets: base_assets.into_iter().chain(staged.new_assets).collect(),
        imported_asset_ids: staged.imported_asset_ids,
        repairs: staged.repairs,
        conflicts: vec![],
        dropped_fields: staged.dropped_fields,
        diagnostics: staged.diagnostics,
    };
    let source = Source {
        filename,
        media_type: None,
        uri: None,
        imported_at: imported_at.to_vec(),
    };
    let mut timestamps = complete::utc();
    let prepared = import::prepare(
        parsed,
        &source,
        &base_content,
        snapshot.revision(),
        snapshot.hash(),
        false,
        &mut timestamps,
    )
    .unwrap();
    Prepared::Ready(Box::new(prepared), requests)
}
fn commit_error(error: ImportCommitError) -> Json {
    match error {
        ImportCommitError::Confirmation(ConfirmError::Missing(ids)) => {
            json!([
                "ImportConfirmationError",
                ids.iter().map(|id| text(id)).collect::<Vec<_>>()
            ])
        }
        ImportCommitError::Confirmation(ConfirmError::Blocked) => {
            json!(["ImportConfirmationError", []])
        }
        ImportCommitError::Confirmation(ConfirmError::Stale) => json!(["StaleImportPreviewError"]),
        ImportCommitError::Disposed => json!(["Disposed"]),
    }
}

/// Minimal wire client for undo/redo/rename through the real session queue.
struct Wire {
    id: u64,
}
impl Wire {
    fn new<P: TimestampPolicy>(owner: &mut ProjectSession<P>) -> Self {
        let hello = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":1,"operation":{"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}}});
        assert!(matches!(
            owner.submit(&hello.to_string()),
            Submission::Ready(_)
        ));
        Self { id: 1 }
    }
    fn call<P: TimestampPolicy>(&mut self, owner: &mut ProjectSession<P>, operation: Json) -> Json {
        self.id += 1;
        let request = json!({"protocolVersion":1,"generation":[0,1,2,3],"requestId":self.id,"operation":operation});
        let wire = match owner.submit(&request.to_string()) {
            Submission::Ready(reply) => reply.wire().to_owned(),
            Submission::Queued { .. } => owner.run_next().unwrap().wire().to_owned(),
        };
        serde_json::from_str(&wire).unwrap()
    }
    fn guard<P: TimestampPolicy>(&mut self, owner: &mut ProjectSession<P>) -> Json {
        self.call(owner, json!({"query":{}}))["result"]["acknowledged"]["guard"].clone()
    }
    fn history<P: TimestampPolicy>(&mut self, owner: &mut ProjectSession<P>, operation: &str) {
        let guard = self.guard(owner);
        let reply = self.call(owner, json!({ operation: guard }));
        assert!(reply["result"].get("acknowledged").is_some(), "{reply}");
    }
}

fn transaction(
    base: &(ProjectState, Vec<AssetPayload>),
    row: &Json,
    place: Placement,
    namespace: &str,
    imported_at: &[u16],
) -> Json {
    let mut owner = session(&base.0, &base.1);
    let guard = owner.capture_guard().unwrap();
    let (prepared, requests) = match prepare(&owner, row, place, namespace, imported_at) {
        Prepared::Error(name) => return json!({ "prepareError": name }),
        Prepared::Ready(prepared, requests) => (*prepared, requests),
    };
    let mut record = serde_json::Map::new();
    record.insert("idRequests".into(), json!(requests));
    record.insert("preview".into(), json!(canonical_json(&prepared.preview)));
    let mut staged = state_record(&prepared.state).as_object().unwrap().clone();
    staged.insert("assets".into(), assets_record(&prepared.assets));
    record.insert("staged".into(), Json::Object(staged));
    let before = canonical_json(&owner.snapshot().state().to_value().unwrap());
    if !prepared.required_acknowledgements().is_empty() {
        let refused = owner
            .commit_import(&guard, prepared.clone(), &[])
            .map(|_| ())
            .unwrap_err();
        record.insert("unacknowledged".into(), commit_error(refused));
    }
    let required = prepared.required_acknowledgements().to_vec();
    match owner.commit_import(&guard, prepared, &required) {
        Err(error) => {
            record.insert("commitError".into(), commit_error(error));
            return Json::Object(record);
        }
        Ok(outcome) => assert!(outcome.result.is_ok()),
    }
    let committed = owner.snapshot().state().to_value().unwrap();
    let mut done = state_record(&committed).as_object().unwrap().clone();
    done.insert("assets".into(), assets_record(&owner.assets().list()));
    done.insert("history".into(), json!(history_record(&owner.history())));
    record.insert("committed".into(), Json::Object(done));
    let mut wire = Wire::new(&mut owner);
    wire.history(&mut owner, "undo");
    record.insert(
        "undone".into(),
        json!({
            "restoresBase": canonical_json(&owner.snapshot().state().to_value().unwrap()) == before,
            "assets": assets_record(&owner.assets().list()),
            "history": history_record(&owner.history()),
        }),
    );
    wire.history(&mut owner, "redo");
    record.insert(
        "redone".into(),
        json!({
            "restoresCommitted": owner.snapshot().state().to_value().unwrap() == committed,
            "history": history_record(&owner.history()),
        }),
    );
    Json::Object(record)
}

#[test]
fn native_transactions_match_every_browser_case() {
    let corpus = read("model-transaction-vectors.json");
    let staging = read("model-stage-vectors.json");
    let decoding = read("model-import-vectors.json");
    let rows: HashMap<String, Json> = decoding["cases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| (c["name"].as_str().unwrap().to_owned(), c.clone()))
        .collect();
    let imported_at: Vec<u16> = corpus["importedAt"]
        .as_str()
        .unwrap()
        .encode_utf16()
        .collect();
    let place = |name: &Json| placement(&staging["placements"][name.as_str().unwrap()]);
    let base = |name: &str| {
        (
            ProjectState::from_value(
                canonical::parse(staging["bases"][name].as_str().unwrap()).unwrap(),
            )
            .unwrap(),
            Vec::new(),
        )
    };
    let empty = base("empty");
    // The holding base is the committed cube import, as the browser builds it.
    let holding = {
        let mut owner = session(&empty.0, &empty.1);
        let guard = owner.capture_guard().unwrap();
        let Prepared::Ready(prepared, _) = prepare(
            &owner,
            &rows["stl-binary/cube"],
            place(&json!("bed")),
            "base",
            &imported_at,
        ) else {
            panic!()
        };
        let required = prepared.required_acknowledgements().to_vec();
        assert!(
            owner
                .commit_import(&guard, *prepared, &required)
                .unwrap()
                .result
                .is_ok()
        );
        (owner.snapshot().state().clone(), owner.assets().list())
    };
    let bases: HashMap<&str, &(ProjectState, Vec<AssetPayload>)> =
        [("empty", &empty), ("holding", &holding)].into();
    let second = base("second-active");
    let mut failures = Vec::new();
    let mut committed = 0;
    for case in corpus["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let row = &rows[case["decode"].as_str().unwrap()];
        let base_name = case["base"].as_str().unwrap();
        let base = if base_name == "second-active" {
            &second
        } else {
            bases[base_name]
        };
        let namespace = case["namespace"].as_str().unwrap();
        let actual = if case.get("stale").is_some() {
            let mut owner = session(&base.0, &base.1);
            let guard = owner.capture_guard().unwrap();
            let Prepared::Ready(prepared, _) = prepare(
                &owner,
                row,
                place(&case["placement"]),
                namespace,
                &imported_at,
            ) else {
                panic!()
            };
            let mut wire = Wire::new(&mut owner);
            let guard_json = wire.guard(&mut owner);
            let plate = owner.snapshot().state().plates[0].id.as_utf16().to_vec();
            let reply = wire.call(&mut owner, json!({"execute":{"guard":guard_json,"intent":{"version":1,"command":{"renamePlate":{"plateId":plate,"name":"Edited meanwhile".encode_utf16().collect::<Vec<_>>()}}}}}));
            assert!(reply["result"].get("acknowledged").is_some(), "{reply}");
            let required = prepared.required_acknowledgements().to_vec();
            let error = owner
                .commit_import(&guard, *prepared, &required)
                .map(|_| ())
                .unwrap_err();
            json!({
                "commitError": commit_error(error),
                "history": history_record(&owner.history()),
                "state": state_record(&owner.snapshot().state().to_value().unwrap()),
            })
        } else if case.get("cancelled").is_some() {
            // Cancellation is the host dropping the prepared candidate: nothing
            // remains to confirm, so a later confirmation is refused.
            json!({ "commitError": ["ImportCancelledError"] })
        } else {
            let actual = transaction(
                base,
                row,
                place(&case["placement"]),
                namespace,
                &imported_at,
            );
            if actual.get("committed").is_some() {
                committed += 1;
            }
            actual
        };
        if actual != case["expected"] {
            failures.push(format!(
                "{name}\n  expected {}\n  actual   {}",
                case["expected"], actual
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} mismatches:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert!(committed >= 14, "{committed}");
}

#[test]
fn reference_sources_match_current_production_coordinator() {
    for row in read("model-transaction-vectors.json")["sources"]
        .as_array()
        .unwrap()
    {
        let bytes = std::fs::read(root().join(row["path"].as_str().unwrap())).unwrap();
        assert_eq!(
            sha(&bytes),
            row["sha256"].as_str().unwrap(),
            "{}",
            row["path"]
        );
    }
}

fn base64(text: &str) -> Vec<u8> {
    let value = |c: u8| match c {
        b'A'..=b'Z' => c - b'A',
        b'a'..=b'z' => c - b'a' + 26,
        b'0'..=b'9' => c - b'0' + 52,
        b'+' => 62,
        _ => 63,
    };
    let bytes: Vec<u8> = text.bytes().filter(|c| *c != b'=').collect();
    let mut out = Vec::new();
    for chunk in bytes.chunks(4) {
        let n = chunk
            .iter()
            .enumerate()
            .fold(0u32, |n, (i, c)| n | u32::from(value(*c)) << (18 - 6 * i));
        out.extend_from_slice(&n.to_be_bytes()[1..chunk.len()]);
    }
    out
}
