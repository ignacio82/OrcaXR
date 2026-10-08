//! Surface measurement over a live session against the browser: volumes
//! captured from the browser-authored project, every pick (in every frame,
//! with its refusals) and every measured pair answer byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*,
    history::*,
    measure::{self, MeasureVolume},
    model::*,
    selection::*,
    session::*,
    validation::*,
};
use serde_json::{Value, json};
use std::collections::BTreeMap;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/measure-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
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

#[test]
fn measurement_matches_the_browser_over_a_live_session() {
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
    let mut volumes: BTreeMap<String, MeasureVolume> = BTreeMap::new();
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let expected = step["reply"].as_str().unwrap();
        let refused = expected.starts_with("{\"refused\"");
        let kind = if let Some(request) = step["capture"].as_str() {
            let volume = session
                .measure_volume(&wire::decode_measure_volume_request(request).unwrap())
                .unwrap();
            assert_eq!(
                wire::encode_measure_volume_reply(&volume.reply()).unwrap(),
                expected,
                "step {i}"
            );
            volumes.insert(step["volume"].as_str().unwrap().to_owned(), volume);
            "capture"
        } else if let Some(request) = step["feature"].as_str() {
            let volume = &volumes[step["volume"].as_str().unwrap()];
            let reply = volume.feature(&wire::decode_measure_feature_request(request).unwrap());
            assert_eq!(
                wire::encode_measure_feature_reply(&reply).unwrap(),
                expected,
                "step {i}: {request}"
            );
            "feature"
        } else {
            let request = step["measure"].as_str().unwrap();
            let reply = measure::measure_wire(&wire::decode_measure_request(request).unwrap());
            assert_eq!(
                wire::encode_measure_reply(&reply).unwrap(),
                expected,
                "step {i}: {request}"
            );
            "measure"
        };
        *counts
            .entry(format!("{kind}{}", if refused { " refused" } else { "" }))
            .or_default() += 1;
    }
    assert_eq!(
        counts,
        BTreeMap::from(
            [
                ("capture", 6),
                ("capture refused", 1),
                ("feature", 1260),
                ("feature refused", 10),
                ("measure", 679),
                ("measure refused", 1),
            ]
            .map(|(k, v)| (k.to_owned(), v))
        )
    );
}
