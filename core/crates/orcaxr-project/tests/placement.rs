//! Placement against the browser: the browser-authored scene opens as a
//! native session, and every request — mirror, resets, centring, scale-to-fit,
//! lay-flat by normal and by facet, drop to bed, and each refusal — plans the
//! browser's transforms and drops, or its code and message, byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/placement-vectors.json"
    ))
    .unwrap()
}
fn utc() -> impl TimestampPolicy<Error = ()> {
    V8Timestamps::new(
        timestamp::V8IntegerMode::Smi32,
        |local: timestamp::LocalDateTime| Ok::<_, ()>(local.civil_milliseconds()),
    )
}

#[test]
fn placements_match_the_browser() {
    let f = fixture();
    let state = ProjectState::from_value(parse(f["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project = ValidatedProject::new(ProjectData::new(state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    for asset in f["assets"].as_array().unwrap() {
        let bytes: Vec<u8> = asset["bytes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|b| b.as_u64().unwrap() as u8)
            .collect();
        assets
            .put(
                &parse(asset["descriptorJson"].as_str().unwrap()).unwrap(),
                &bytes,
            )
            .unwrap();
    }
    let mut session = ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions::default(),
        [1, 2, 3, 4],
    )
    .unwrap();
    let (mut plans, mut refusals) = (0, 0);
    for case in f["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let request = wire::decode_placement_request(case["request"].as_str().unwrap()).unwrap();
        let reply = session.plan_placement(&request).unwrap();
        match reply {
            wire::PlacementReply::Plan(_) => plans += 1,
            wire::PlacementReply::Refused(_) => refusals += 1,
        }
        assert_eq!(
            wire::encode_placement_reply(&reply).unwrap(),
            case["reply"].as_str().unwrap(),
            "{name}"
        );
    }
    assert_eq!((plans, refusals), (70, 20));
    let request =
        wire::decode_placement_request(f["cases"][0]["request"].as_str().unwrap()).unwrap();
    session.dispose();
    assert_eq!(
        session.plan_placement(&request).map(|_| ()),
        Err(wire::SessionError::Disposed)
    );
}
