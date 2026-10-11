//! Volume splits over a live session against the browser: the browser-authored
//! project opens as a native session, and the host's script — preparations
//! and their refusals, stages under its own IDs as parts or objects (with
//! every naming refusal and a stale stage), the edits between them, undo and
//! redo — answers byte for byte, leaving the browser's revision, hash and
//! undo label after every step.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*,
    history::*,
    model::*,
    selection::*,
    session::*,
    split::{self, VolumeSplit},
    validation::*,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/volume-split-vectors.json"
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

/// Sources no valid session holds — a missing or redescribed payload, a
/// doubled declaration, zero scales and rotations, an empty mesh and a
/// malformed layout — prepared straight from a state and its assets.
#[test]
fn direct_preparations_refuse_as_the_browser_does() {
    let f = fixture();
    let base = f["assets"].as_array().unwrap();
    for case in f["direct"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let state = ProjectState::from_value(
            parse(
                case["stateJson"]
                    .as_str()
                    .unwrap_or_else(|| f["stateJson"].as_str().unwrap()),
            )
            .unwrap(),
        )
        .unwrap();
        let mut assets = AssetRepository::new();
        for asset in case["assets"].as_array().unwrap() {
            let asset = match asset.as_u64() {
                Some(index) => &base[index as usize],
                None => asset,
            };
            assets
                .put(
                    &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                    &bytes(asset),
                )
                .unwrap();
        }
        let request = wire::decode_volume_split_request(case["request"].as_str().unwrap()).unwrap();
        assert_eq!(
            wire::encode_volume_split_reply(&split::prepare(&state, &assets, &request).reply())
                .unwrap(),
            case["reply"].as_str().unwrap(),
            "{name}"
        );
    }
    assert_eq!(f["direct"].as_array().unwrap().len(), 9);
}

#[test]
fn volume_splits_match_the_browser_over_a_live_session() {
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

    let mut splits: BTreeMap<String, VolumeSplit> = BTreeMap::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let name = step["split"].as_str().unwrap_or_default().to_owned();
        let kind = if let Some(request) = step["prepare"].as_str() {
            let guard = session.capture_guard().unwrap();
            let split = session
                .volume_split(&guard, &wire::decode_volume_split_request(request).unwrap())
                .unwrap();
            let reply = wire::encode_volume_split_reply(&split.reply()).unwrap();
            assert_eq!(reply, step["reply"].as_str().unwrap(), "step {i}");
            let refused = reply.starts_with("{\"refused\"");
            // A refused preparation leaves the host's earlier split in place.
            if !refused {
                splits.insert(name, split);
            }
            if refused { "refused" } else { "prepared" }.to_owned()
        } else {
            let kind = if let Some(request) = step["stage"].as_str() {
                let request = wire::decode_volume_split_stage(request).unwrap();
                let outcome = match session.stage_volume_split(&splits[&name], &request) {
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
            } else if let Some(intent) = step["edit"].as_str() {
                let guard =
                    run(&mut session, &mut sequence, json!({"query":{}}))["acknowledged"]["guard"]
                        .clone();
                let intent: Value = serde_json::from_str(intent).unwrap();
                let result = run(
                    &mut session,
                    &mut sequence,
                    json!({"execute":{"guard":guard,"intent":intent}}),
                );
                assert!(result.get("acknowledged").is_some(), "step {i}: {result}");
                "edit".to_owned()
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
                ("prepared", 13),
                ("refused", 6),
                ("invalidRequest", 7),
                ("commandFailed", 6),
                ("applied", 7),
                ("stale", 2),
                ("edit", 1),
                ("undo", 4),
                ("redo", 2),
            ]
            .map(|(k, v)| (k.to_owned(), v))
        )
    );
}
