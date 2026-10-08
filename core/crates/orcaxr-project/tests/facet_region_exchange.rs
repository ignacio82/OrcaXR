//! Facet region selection over a live session against the browser: the
//! browser-authored project with two mesh volumes opens as a native session
//! and answers every region request of the host's script — pages, the
//! selector's issues and refusals — byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, facets::region_exchange, history::*, model::*, selection::*, session::*,
    validation::*,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/facet-region-exchange-vectors.json"
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
fn region_replies_match_the_browser_over_a_live_session() {
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
        HistoryOptions {
            max_entries: 100,
            max_estimated_bytes: 32 * 1024 * 1024,
        },
        [1, 2, 3, 4],
    )
    .unwrap();
    let (mut pages, mut invalid, mut refusals) = (0, 0, 0);
    for (i, entry) in f["script"].as_array().unwrap().iter().enumerate() {
        let request =
            wire::decode_facet_region_request(entry["request"].as_str().unwrap()).unwrap();
        let answer = region_exchange::session_reply(&session, &request);
        if let Some(code) = entry.get("refusal") {
            assert_eq!(
                answer.map(|_| ()).map_err(|r| r.code()),
                Err(code.as_str().unwrap()),
                "request {i}"
            );
            refusals += 1;
            continue;
        }
        let reply = answer.unwrap();
        match &reply {
            wire::FacetRegionReply::Page(_) => pages += 1,
            _ => invalid += 1,
        }
        assert_eq!(
            wire::encode_facet_region_reply(&reply).unwrap(),
            entry["reply"].as_str().unwrap(),
            "request {i}"
        );
    }
    assert_eq!((pages, invalid, refusals), (134, 2, 2));

    // A disposed session answers nothing.
    let request =
        wire::decode_facet_region_request(f["script"][0]["request"].as_str().unwrap()).unwrap();
    session.dispose();
    assert_eq!(
        region_exchange::session_reply(&session, &request).map(|_| ()),
        Err(region_exchange::Refusal::Disposed)
    );
}
