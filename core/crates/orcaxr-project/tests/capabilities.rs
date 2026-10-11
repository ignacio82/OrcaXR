//! The capability exchange against the browser: each distinct session trace
//! state opens as a native session, takes the browser's selection and
//! acknowledged edit, and answers every capability page byte for byte.
use orcaxr_contracts::{canonical::parse, project_intent_types as wire};
use orcaxr_project::{
    assets::*, capabilities, history::*, ids::*, model::*, selection::*, session::*, validation::*,
};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../../testdata/cross-platform/capability-exchange-vectors.json"
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
fn reference(v: &Value) -> SelectionRef {
    let id = || units(&v["id"]);
    match v["kind"].as_str().unwrap() {
        "project" => SelectionRef::Project,
        "plate" => SelectionRef::Plate(PlateId::try_from_utf16(id()).unwrap()),
        "object" => SelectionRef::Object(ObjectId::try_from_utf16(id()).unwrap()),
        "volume" => SelectionRef::Volume(VolumeId::try_from_utf16(id()).unwrap()),
        "instance" => SelectionRef::Instance(InstanceId::try_from_utf16(id()).unwrap()),
        kind => panic!("unexpected selection kind {kind}"),
    }
}
fn session(
    state: &Value,
    generation: [u32; 4],
) -> ProjectSession<impl TimestampPolicy<Error = ()>> {
    let project_state =
        ProjectState::from_value(parse(state["stateJson"].as_str().unwrap()).unwrap()).unwrap();
    let project =
        ValidatedProject::new(ProjectData::new(project_state).unwrap(), &mut utc()).unwrap();
    let mut assets = AssetRepository::new();
    assets
        .put(
            &parse(state["asset"]["descriptorJson"].as_str().unwrap()).unwrap(),
            &state["asset"]["bytes"]
                .as_array()
                .unwrap()
                .iter()
                .map(|b| b.as_u64().unwrap() as u8)
                .collect::<Vec<_>>(),
        )
        .unwrap();
    ProjectSession::new(
        project,
        SelectionStore::default(),
        assets,
        utc(),
        HistoryOptions {
            max_entries: state["options"]["maxEntries"].as_u64().unwrap_or(100) as usize,
            max_estimated_bytes: state["options"]["maxEstimatedBytes"]
                .as_u64()
                .unwrap_or(32 * 1024 * 1024),
        },
        generation,
    )
    .unwrap()
}

#[test]
fn capability_pages_match_the_browser_over_live_sessions() {
    let f = fixture();
    let generation: Vec<u32> = f["generation"]
        .as_array()
        .unwrap()
        .iter()
        .map(|g| g.as_u64().unwrap() as u32)
        .collect();
    let generation: [u32; 4] = generation.try_into().unwrap();
    let (mut pages, mut edits) = (0, 0);
    for state in f["states"].as_array().unwrap() {
        let mut session = session(state, generation);
        for phase in state["phases"].as_array().unwrap() {
            let label = format!("{} {}", state["name"], phase["name"]);
            if let Some(selection) = phase.get("selection") {
                let refs: Vec<SelectionRef> = selection["refs"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(reference)
                    .collect();
                let primary = refs[selection["primary"].as_u64().unwrap() as usize].clone();
                let guard = session.capture_guard().unwrap();
                let _ = session.select(&guard, &refs, Some(primary)).unwrap();
            }
            if let Some(requests) = phase.get("requests") {
                for (i, request) in requests.as_array().unwrap().iter().enumerate() {
                    let wire_reply = match session.submit(request.as_str().unwrap()) {
                        Submission::Ready(response) => response.into_parts().0,
                        Submission::Queued { .. } => session.run_next().unwrap().into_parts().0,
                    };
                    let actual: Value = serde_json::from_str(&wire_reply).unwrap();
                    let expected: Value =
                        serde_json::from_str(phase["replies"][i].as_str().unwrap()).unwrap();
                    assert_eq!(actual, expected, "{label} reply {i}");
                }
                edits += 1;
            }
            for query in phase["queries"].as_array().unwrap() {
                let request =
                    wire::decode_capability_request(query["requestJson"].as_str().unwrap())
                        .unwrap();
                let page = capabilities::session_page(&session, &request).unwrap();
                assert_eq!(
                    wire::encode_capability_page(&page).unwrap(),
                    query["replyJson"].as_str().unwrap(),
                    "{label}"
                );
                pages += 1;
            }
            // A page larger than the bound refuses rather than truncating.
            let mut request = wire::decode_capability_request(
                phase["queries"][0]["requestJson"].as_str().unwrap(),
            )
            .unwrap();
            request.query = wire::CapabilityQuery::Page(wire::SettingsTargetPageRequest {
                start: 0,
                count: capabilities::MAX_PAGE as u64 + 1,
            });
            assert_eq!(
                capabilities::session_page(&session, &request),
                Err(capabilities::Refusal::InvalidRequest)
            );
        }
    }
    assert_eq!((pages, edits), (384, 20));
}
