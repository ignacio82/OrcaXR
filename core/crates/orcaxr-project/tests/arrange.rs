//! Plate arrangement and bed fill against the browser: the browser-authored
//! two-plate scene opens as a native session, and every arrangement and fill
//! request answers the browser's layout or refusal, byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/arrange-vectors.json"
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
fn arrangements_and_fills_match_the_browser() {
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
    let (mut arranged, mut filled) = (0, 0);
    for case in f["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let actual = if let Some(request) = case.get("arrange") {
            arranged += 1;
            let request = wire::decode_arrange_request(request.as_str().unwrap()).unwrap();
            wire::encode_arrange_reply(&session.plan_arrangement(&request).unwrap()).unwrap()
        } else {
            filled += 1;
            let request = wire::decode_bed_fill_request(case["fill"].as_str().unwrap()).unwrap();
            wire::encode_bed_fill_reply(&session.plan_bed_fill(&request).unwrap()).unwrap()
        };
        assert_eq!(actual, case["reply"].as_str().unwrap(), "{name}");
    }
    assert_eq!((arranged, filled), (18, 17));
    let request = wire::decode_arrange_request(f["cases"][0]["arrange"].as_str().unwrap()).unwrap();
    session.dispose();
    assert_eq!(
        session.plan_arrangement(&request).map(|_| ()),
        Err(wire::SessionError::Disposed)
    );
}
