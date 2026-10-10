//! Catalog profile selection and slicing configuration against the browser
//! (`slicing-configuration-vectors.json`): every exchange reply byte for
//! byte, each configuration and next state fed forward as a host feeds it,
//! and the live choice committed on a real session.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::{
    assets::AssetRepository,
    history::HistoryOptions,
    model::{Decode, ProjectData, ProjectState},
    selection::SelectionStore,
    session::{ProjectSession, StagingLimits, Submission},
    settings::{catalog::ProfileCatalog, presets::AsciiRootCollation},
    slicing::configuration_exchange as exchange,
    validation::*,
};
use serde_json::{Value as Json, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn corpus() -> Json {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/slicing-configuration-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn catalogs(f: &Json) -> BTreeMap<&'static str, ProfileCatalog> {
    let bundled = parse(include_str!("../../../../web/public/profiles/catalog.json")).unwrap();
    let synthetic = parse(f["syntheticCatalogJson"].as_str().unwrap()).unwrap();
    BTreeMap::from([
        (
            "bundled",
            ProfileCatalog::build(&bundled, &mut AsciiRootCollation).unwrap(),
        ),
        (
            "synthetic",
            ProfileCatalog::build(&synthetic, &mut AsciiRootCollation).unwrap(),
        ),
    ])
}
fn words(case: &Json) -> Vec<f64> {
    case["words"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_f64().unwrap())
        .collect()
}
/// A reply the corpus pins by text, or by the SHA-256 and length of its text.
fn pinned(reply: &str, case: &Json, label: &str) {
    match case.get("replyJson") {
        Some(expected) => assert_eq!(reply, expected.as_str().unwrap(), "{label}"),
        None => {
            assert_eq!(
                reply.encode_utf16().count() as u64,
                case["replyLength"].as_u64().unwrap(),
                "{label} length"
            );
            let digest: String = Sha256::digest(reply.as_bytes())
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect();
            assert_eq!(digest, case["replySha256"].as_str().unwrap(), "{label}");
        }
    }
}
const NONCE: [u32; 4] = [1, 2, 3, 4];
fn run<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    sequence: &mut u64,
    operation: Json,
) -> Json {
    *sequence += 1;
    let request =
        json!({"protocolVersion":1,"generation":NONCE,"requestId":*sequence,"operation":operation});
    let response = match session.submit(&request.to_string()) {
        Submission::Ready(response) => response,
        Submission::Queued { .. } => session.run_next().unwrap(),
    };
    serde_json::from_str::<Json>(response.wire()).unwrap()["result"].clone()
}
fn reply_field(reply: &str, name: &str) -> Option<String> {
    let value: Json = serde_json::from_str(reply).unwrap();
    value.get(name).and_then(|v| v.as_str()).map(str::to_owned)
}

#[test]
fn choices_matches_and_selections_answer_as_the_browser_does() {
    let f = corpus();
    let catalogs = catalogs(&f);
    let catalog = |case: &Json| Some(&catalogs[case["catalog"].as_str().unwrap()]);
    for (i, case) in f["choices"].as_array().unwrap().iter().enumerate() {
        let reply =
            exchange::choices_json(catalog(case), case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "choices {i}");
    }
    for (i, case) in f["matches"].as_array().unwrap().iter().enumerate() {
        let reply = exchange::match_json(case["requestJson"].as_str().unwrap()).unwrap();
        assert_eq!(reply, case["replyJson"].as_str().unwrap(), "match {i}");
    }
    let mut kinds = BTreeMap::new();
    for (i, case) in f["selections"].as_array().unwrap().iter().enumerate() {
        let request = case["requestJson"].as_str().unwrap();
        let kind = case["kind"].as_str().unwrap();
        let reply = match kind {
            "ids" => exchange::select_json(catalog(case), request),
            "names" => exchange::select_by_names_json(catalog(case), request),
            _ => exchange::default_selection_json(catalog(case), request),
        }
        .unwrap();
        assert_eq!(
            reply,
            case["replyJson"].as_str().unwrap(),
            "selection {i} ({kind})"
        );
        *kinds.entry(kind.to_owned()).or_insert(0) += 1;
    }
    assert_eq!(
        (
            f["choices"].as_array().unwrap().len(),
            f["matches"].as_array().unwrap().len(),
            kinds.values().sum::<usize>()
        ),
        (80, 46, 46)
    );
    // A catalog that did not load offers nothing and resolves nothing.
    assert_eq!(
        exchange::choices_json(None, "{}").unwrap(),
        r#"{"extruders":1,"filaments":[],"machines":[],"processes":[]}"#
    );
    let empty = r##"{"live":{"heads":[],"nozzles":[],"palette":[{"color":"#000000","type":"PLA"}],"profile":null},"request":{"machinePresetId":"preset:x:machine:y"}}"##;
    assert_eq!(
        exchange::select_json(None, empty).unwrap(),
        r#"{"feedback":{"applied":false,"messages":["The profile catalog has not loaded or failed validation."],"severity":"error"}}"#
    );
    assert_eq!(
        exchange::default_selection_json(
            None,
            r#"{"live":{"heads":[],"nozzles":[],"palette":[],"profile":null}}"#
        )
        .unwrap(),
        "{}"
    );
}

#[test]
fn configurations_and_next_states_feed_forward_as_the_browser_does() {
    let f = corpus();
    let catalogs = catalogs(&f);
    let states = f["states"].as_object().unwrap();
    let mut configurations = Vec::new();
    for (i, case) in f["configurations"].as_array().unwrap().iter().enumerate() {
        let request = json!({
            "live": case["live"],
            "stateJson": states[case["state"].as_str().unwrap()],
        })
        .to_string();
        let catalog = Some(&catalogs[case["catalog"].as_str().unwrap()]);
        let reply = exchange::configuration_json(catalog, &request, &mut utc()).unwrap();
        pinned(&reply, case, &format!("configuration {i}"));
        configurations.push(reply);
    }
    let mut next_states: Vec<String> = Vec::new();
    let mut outcomes = BTreeMap::new();
    for (i, case) in f["nextStates"].as_array().unwrap().iter().enumerate() {
        let state = match case.get("state") {
            Some(name) => states[name.as_str().unwrap()].as_str().unwrap().to_owned(),
            None => reply_field(
                &next_states[case["after"].as_u64().unwrap() as usize],
                "stateJson",
            )
            .unwrap(),
        };
        let configuration = match case.get("configuration") {
            Some(index) => reply_field(
                &configurations[index.as_u64().unwrap() as usize],
                "configurationJson",
            )
            .unwrap(),
            None => case["configurationJson"].as_str().unwrap().to_owned(),
        };
        let request = json!({
            "autoPairs": case["autoPairs"],
            "configurationJson": configuration,
            "stateJson": state,
        })
        .to_string();
        let reply = exchange::next_state_json(&request, &words(case), &mut utc()).unwrap();
        pinned(&reply, case, &format!("next state {i}"));
        let key = reply_field(&reply, "error").unwrap_or_else(|| {
            if reply.contains("\"unchanged\"") {
                "unchanged".into()
            } else {
                "ok".into()
            }
        });
        *outcomes.entry(key).or_insert(0) += 1;
        next_states.push(reply);
    }
    assert_eq!(
        outcomes,
        BTreeMap::from([
            ("auto-pairs".to_owned(), 3),
            ("ids-exhausted".to_owned(), 3),
            ("invalid".to_owned(), 2),
            ("ok".to_owned(), 101),
            ("unchanged".to_owned(), 10),
        ])
    );
}

#[test]
fn a_session_commits_the_live_choice_as_one_undoable_replacement() {
    let f = corpus();
    let catalogs = catalogs(&f);
    let states = f["states"].as_object().unwrap();
    let mut outcomes = BTreeMap::new();
    for (i, case) in f["commits"].as_array().unwrap().iter().enumerate() {
        let state_text = states[case["state"].as_str().unwrap()].as_str().unwrap();
        let state = ProjectState::from_value(parse(state_text).unwrap()).unwrap();
        let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
        let before = project.fingerprint().to_owned();
        let mut session = ProjectSession::new(
            project,
            SelectionStore::default(),
            AssetRepository::new(),
            utc(),
            HistoryOptions {
                max_entries: 16,
                max_estimated_bytes: 64 << 20,
            },
            NONCE,
        )
        .unwrap();
        session
            .configure_staging(StagingLimits {
                max_resources: 4,
                max_commands: 4,
                max_units: 64_000_000,
                max_asset_bytes: 0,
            })
            .unwrap();
        let mut sequence = 0;
        assert!(
            run(
                &mut session,
                &mut sequence,
                json!({"hello":{"minProtocolVersion":1,"maxProtocolVersion":1,"projectSchemaVersion":1,"intentVersion":1}})
            )
            .get("welcome")
            .is_some()
        );
        let catalog = Some(&catalogs[case["catalog"].as_str().unwrap()]);
        let request = json!({ "autoPairs": case["autoPairs"], "live": case["live"] }).to_string();
        let reply = exchange::stage_json(&mut session, catalog, &request, &words(case)).unwrap();
        let expected: Json = serde_json::from_str(case["expectedJson"].as_str().unwrap()).unwrap();
        let staged: Json = serde_json::from_str(&reply).unwrap();
        let outcome = if let Some(hash) = expected.get("stateHash") {
            let id = staged["staged"]
                .as_u64()
                .unwrap_or_else(|| panic!("commit {i}: {reply}"));
            let result = run(
                &mut session,
                &mut sequence,
                json!({"executeStaged":{"stagedId":id}}),
            );
            assert_eq!(
                result["acknowledged"]["changed"],
                json!(true),
                "commit {i}: {result}"
            );
            assert_eq!(
                session.snapshot().hash(),
                hash.as_str().unwrap(),
                "commit {i} state"
            );
            assert_eq!(
                session
                    .history()
                    .undo_label
                    .map(|label| String::from_utf16(label.units()).unwrap()),
                Some("Update slicing configuration".to_owned()),
                "commit {i} label"
            );
            // Undo restores the project it replaced.
            let guard =
                run(&mut session, &mut sequence, json!({"query":{}}))["acknowledged"]["guard"]
                    .clone();
            let undone = run(&mut session, &mut sequence, json!({ "undo": guard }));
            assert!(
                undone.get("acknowledged").is_some(),
                "commit {i} undo: {undone}"
            );
            assert_eq!(session.snapshot().hash(), before, "commit {i} undo state");
            "committed"
        } else {
            assert_eq!(reply, case["expectedJson"].as_str().unwrap(), "commit {i}");
            if staged.get("unchanged").is_some() {
                "unchanged"
            } else {
                "refused"
            }
        };
        *outcomes.entry(outcome).or_insert(0) += 1;
    }
    assert_eq!(
        outcomes,
        BTreeMap::from([("committed", 29), ("refused", 2), ("unchanged", 1)])
    );
}

#[test]
fn malformed_requests_are_refused() {
    let f = corpus();
    let catalogs = catalogs(&f);
    let bundled = Some(&catalogs["bundled"]);
    for case in f["refusals"].as_array().unwrap() {
        let request = case["requestJson"].as_str().unwrap();
        let result = match case["exchange"].as_str().unwrap() {
            "choices" => exchange::choices_json(bundled, request),
            "match" => exchange::match_json(request),
            "select" => exchange::select_json(bundled, request),
            "names" => exchange::select_by_names_json(bundled, request),
            "default" => exchange::default_selection_json(bundled, request),
            "configuration" => exchange::configuration_json(bundled, request, &mut utc()),
            _ => exchange::next_state_json(request, &[], &mut utc()),
        };
        assert_eq!(result, Err(exchange::INVALID_REQUEST), "{request}");
    }
    assert_eq!(
        exchange::match_json(&"x".repeat(exchange::MAX_EXCHANGE_BYTES + 1)),
        Err(exchange::INPUT_LIMIT)
    );
}
