//! Where the transform gizmo stands against the browser
//! (`transform-proxy-vectors.json`): the browser-authored scene, on two
//! plates, opens as a native session, and every selection places the proxy
//! and captures the drag's origins as `OrcaWorkspace.syncTransformProxy` and
//! `captureSelectedInstanceOrigins` do, byte for byte; malformed requests are
//! refused and a disposed session answers nothing.
use orcaxr_contracts::canonical::parse;
use orcaxr_project::{assets::*, history::*, model::*, selection::*, session::*, validation::*};
use serde_json::Value;
use sha2::{Digest, Sha256};

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/transform-proxy-vectors.json"
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
fn reference_sources_are_current() {
    for source in fixture()["sources"].as_array().unwrap() {
        let path = format!("../../../{}", source["path"].as_str().unwrap());
        let bytes =
            std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(path)).unwrap();
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            source["sha256"].as_str().unwrap(),
            "{}",
            source["path"]
        );
    }
}

#[test]
fn proxies_stand_where_the_browser_stands_them() {
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
    let cases = f["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 19);
    for case in cases {
        let reply = session
            .plan_transform_proxy(case["request"].as_str().unwrap())
            .unwrap();
        assert_eq!(reply, case["reply"].as_str().unwrap(), "{}", case["name"]);
    }
    let refusals = f["refusals"].as_array().unwrap();
    assert_eq!(refusals.len(), 8);
    for request in refusals {
        let request = request.as_str().unwrap();
        assert_eq!(
            session.plan_transform_proxy(request),
            Err("invalid_request"),
            "{request}"
        );
    }
    session.dispose();
    assert_eq!(
        session.plan_transform_proxy(cases[0]["request"].as_str().unwrap()),
        Err("disposed")
    );
}
