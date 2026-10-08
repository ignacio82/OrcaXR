//! Mesh simplification over a live session against the browser: the
//! browser-authored project opens as a native session, and the host's script
//! — count and error runs over every mesh with their refusals, each result's
//! mesh bytes, stages under its own asset IDs, undo and redo — answers byte
//! for byte, leaving the browser's revision, hash and undo label after every
//! step.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, history::*, model::*, selection::*, session::*, simplify::VolumeSimplify,
    validation::*,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/simplify-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}
fn units(v: &Value) -> Vec<u16> {
    v.as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect()
}
fn run<P: TimestampPolicy>(
    session: &mut ProjectSession<P>,
    sequence: &mut u64,
    operation: Value,
) -> Value {
    *sequence += 1;
    let request =
        json!({"protocolVersion":1,"generation":NONCE,"requestId":*sequence,"operation":operation});
    let response = match session.submit(&request.to_string()) {
        Submission::Ready(response) => response,
        Submission::Queued { .. } => session.run_next().unwrap(),
    };
    serde_json::from_str::<Value>(response.wire()).unwrap()["result"].clone()
}

fn bytes(asset: &Value) -> Vec<u8> {
    asset["bytes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|b| b.as_u64().unwrap() as u8)
        .collect()
}

fn sha256(bytes: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[test]
fn simplification_matches_the_browser_over_a_live_session() {
    let f = fixture();
    let state = ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in f["assets"].as_array().unwrap() {
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes(asset),
            )
            .unwrap();
    }
    let mut session = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: 100,
            max_estimated_bytes: 32 * 1024 * 1024,
        },
        NONCE,
    )
    .unwrap();
    session
        .configure_staging(StagingLimits {
            max_resources: 4,
            max_commands: 16,
            max_units: 64_000_000,
            max_asset_bytes: 16_000_000,
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

    let mut runs: BTreeMap<String, VolumeSimplify> = BTreeMap::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let name = step["simplify"].as_str().unwrap_or_default().to_owned();
        let kind = if let Some(request) = step["prepare"].as_str() {
            let guard = session.capture_guard().unwrap();
            let simplify = session
                .volume_simplify(
                    &guard,
                    &wire::decode_volume_simplify_request(request).unwrap(),
                )
                .unwrap();
            let reply = wire::encode_volume_simplify_reply(&simplify.reply()).unwrap();
            assert_eq!(reply, step["reply"].as_str().unwrap(), "step {i}");
            let kind = match simplify.reply() {
                wire::VolumeSimplifyReply::Prepared(preview) => {
                    let mesh = simplify.mesh(0, preview.byte_length).unwrap();
                    assert_eq!(sha256(mesh), step["mesh"].as_str().unwrap(), "step {i}");
                    assert_eq!(
                        step.get("window")
                            .map(|_| sha256(simplify.mesh(16, 64).unwrap())),
                        step.get("window").map(|w| w.as_str().unwrap().to_owned()),
                        "step {i}"
                    );
                    assert_eq!(preview.byte_length >= 80, step.get("window").is_some());
                    assert!(simplify.mesh(preview.byte_length, 1).is_err());
                    "prepared"
                }
                wire::VolumeSimplifyReply::Unchanged(_) => "unchanged",
                wire::VolumeSimplifyReply::Refused(_) => "refused",
            };
            if kind != "prepared" {
                assert!(simplify.mesh(0, 0).is_err(), "step {i}");
            }
            runs.insert(name, simplify);
            kind.to_owned()
        } else {
            let kind = if let Some(request) = step["stage"].as_str() {
                let request = wire::decode_volume_simplify_stage(request).unwrap();
                let outcome = match session.stage_volume_simplify(&runs[&name], &request) {
                    Ok(id) => {
                        let result = run(
                            &mut session,
                            &mut sequence,
                            json!({"executeStaged":{"stagedId":id}}),
                        );
                        match (
                            result["acknowledged"]["changed"].as_bool(),
                            result["error"].as_str(),
                        ) {
                            (Some(true), _) => "applied",
                            (Some(false), _) => "unchanged",
                            (None, Some(error)) => error,
                            _ => panic!("step {i}: {result}"),
                        }
                        .to_owned()
                    }
                    Err(wire::SessionError::Stale) => "stale".to_owned(),
                    Err(wire::SessionError::InvalidRequest) => "invalidRequest".to_owned(),
                    Err(wire::SessionError::ResourceLimit) => "resourceLimit".to_owned(),
                    Err(error) => panic!("step {i}: {error:?}"),
                };
                assert_eq!(outcome, step["outcome"].as_str().unwrap(), "step {i}");
                outcome
            } else {
                let direction = step["history"].as_str().unwrap();
                let guard =
                    run(&mut session, &mut sequence, json!({"query":{}}))["acknowledged"]["guard"]
                        .clone();
                let result = run(&mut session, &mut sequence, json!({ direction: guard }));
                assert!(result.get("acknowledged").is_some(), "step {i}: {result}");
                direction.to_owned()
            };
            let snapshot = session.snapshot();
            assert_eq!(
                snapshot.revision(),
                step["revision"].as_u64().unwrap(),
                "step {i}"
            );
            assert_eq!(snapshot.hash(), step["hash"].as_str().unwrap(), "step {i}");
            assert_eq!(
                session
                    .history()
                    .undo_label
                    .map(|label| label.units().to_vec()),
                step["undoLabel"]
                    .as_array()
                    .map(|_| units(&step["undoLabel"])),
                "step {i}"
            );
            kind
        };
        *counts.entry(kind).or_default() += 1;
    }
    assert_eq!(
        counts,
        BTreeMap::from(
            [
                ("prepared", 34),
                ("unchanged", 12),
                ("refused", 8),
                ("invalidRequest", 3),
                ("commandFailed", 1),
                ("applied", 3),
                ("stale", 2),
                ("undo", 2),
                ("redo", 1),
            ]
            .map(|(k, v)| (k.to_owned(), v))
        )
    );
}
