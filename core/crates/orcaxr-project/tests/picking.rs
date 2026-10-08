//! Ray picking against the browser: the browser-authored picking scene opens
//! as a native session, and every ray of the corpus picks the browser's facet,
//! points and distance, byte for byte, in scenes of every volume and of model
//! volumes only; an unknown plate refuses.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/pick-vectors.json"
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
fn picks_match_the_browser() {
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
    let (mut hits, mut misses) = (0, 0);
    for scene in f["scenes"].as_array().unwrap() {
        let request = wire::decode_pick_scene_request(scene["request"].as_str().unwrap()).unwrap();
        let picks = session.pick_scene(&request).unwrap();
        for (i, pick) in scene["picks"].as_array().unwrap().iter().enumerate() {
            let ray = wire::decode_pick_ray(pick["ray"].as_str().unwrap()).unwrap();
            let reply = picks.pick(&ray);
            match reply {
                wire::PickReply::Hit(_) => hits += 1,
                wire::PickReply::Miss(_) => misses += 1,
            }
            assert_eq!(
                wire::encode_pick_reply(&reply).unwrap(),
                pick["reply"].as_str().unwrap(),
                "ray {i}"
            );
        }
    }
    assert_eq!((hits, misses), (291, 195));
    for refusal in f["refusals"].as_array().unwrap() {
        let request =
            wire::decode_pick_scene_request(refusal["request"].as_str().unwrap()).unwrap();
        assert_eq!(
            session
                .pick_scene(&request)
                .map(|_| ())
                .map_err(|r| r.code()),
            Err(refusal["refusal"].as_str().unwrap())
        );
    }
    let request =
        wire::decode_pick_scene_request(f["scenes"][0]["request"].as_str().unwrap()).unwrap();
    session.dispose();
    assert_eq!(
        session
            .pick_scene(&request)
            .map(|_| ())
            .map_err(|r| r.code()),
        Err("disposed")
    );
}
