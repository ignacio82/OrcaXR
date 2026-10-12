//! Brim-ear detection over a live session against the browser: corners of
//! each object's model parts in object space, under every option, the
//! stranded placed ears and each object's view answer byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;
use std::collections::BTreeMap;

const NONCE: [u32; 4] = [1, 2, 3, 4];
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/brim-ear-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
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
fn brim_ears_match_the_browser_over_a_live_session() {
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
    let session = ProjectSession::new(
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
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, step) in f["steps"].as_array().unwrap().iter().enumerate() {
        let expected = step["reply"].as_str().unwrap();
        let (kind, reply) = if let Some(request) = step["detect"].as_str() {
            let reply = session
                .detect_brim_ears(&wire::decode_brim_ear_detect_request(request).unwrap())
                .unwrap();
            (
                "detect",
                wire::encode_brim_ear_detect_reply(&reply).unwrap(),
            )
        } else if let Some(request) = step["view"].as_str() {
            let reply = session
                .brim_ear_view(&wire::decode_brim_ear_view_request(request).unwrap())
                .unwrap();
            ("view", wire::encode_brim_ear_view_reply(&reply).unwrap())
        } else {
            let request = step["stranded"].as_str().unwrap();
            let reply = session
                .stranded_brim_ears(&wire::decode_brim_ear_stranded_request(request).unwrap())
                .unwrap();
            (
                "stranded",
                wire::encode_brim_ear_stranded_reply(&reply).unwrap(),
            )
        };
        assert_eq!(reply, expected, "step {i}");
        *counts.entry(kind).or_default() += 1;
    }
    assert_eq!(
        counts,
        BTreeMap::from([("detect", 41), ("stranded", 10), ("view", 10)])
    );
}
