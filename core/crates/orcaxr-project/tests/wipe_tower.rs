//! Wipe-tower auto-placement against the browser: the browser-authored
//! scene opens as a native session, and every placement request answers the
//! browser's pick and tower or refusal, and every plate's ghost the box the
//! browser's workspace draws, byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/wipe-tower-vectors.json"
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
fn wipe_tower_placements_match_the_browser() {
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
        let request = wire::decode_wipe_tower_request(case["request"].as_str().unwrap()).unwrap();
        let reply = session.plan_wipe_tower(&request).unwrap();
        match reply {
            wire::WipeTowerReply::Plan(_) => plans += 1,
            wire::WipeTowerReply::Refused(_) => refusals += 1,
        }
        assert_eq!(
            wire::encode_wipe_tower_reply(&reply).unwrap(),
            case["reply"].as_str().unwrap(),
            "{name}"
        );
    }
    assert_eq!((plans, refusals), (24, 3));
    let (mut ghosts, mut none, mut refused) = (0, 0, 0);
    for case in f["ghosts"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let request =
            wire::decode_wipe_tower_ghost_request(case["request"].as_str().unwrap()).unwrap();
        let reply = session.wipe_tower_ghost(&request).unwrap();
        match reply {
            wire::WipeTowerGhostReply::Ghost(_) => ghosts += 1,
            wire::WipeTowerGhostReply::None(_) => none += 1,
            wire::WipeTowerGhostReply::Refused(_) => refused += 1,
        }
        assert_eq!(
            wire::encode_wipe_tower_ghost_reply(&reply).unwrap(),
            case["reply"].as_str().unwrap(),
            "{name}"
        );
    }
    assert_eq!((ghosts, none, refused), (5, 5, 3));
    let ghost =
        wire::decode_wipe_tower_ghost_request(f["ghosts"][0]["request"].as_str().unwrap()).unwrap();
    let request =
        wire::decode_wipe_tower_request(f["cases"][0]["request"].as_str().unwrap()).unwrap();
    session.dispose();
    assert_eq!(
        session.plan_wipe_tower(&request).map(|_| ()),
        Err(wire::SessionError::Disposed)
    );
    assert_eq!(
        session.wipe_tower_ghost(&ghost).map(|_| ()),
        Err(wire::SessionError::Disposed)
    );
}
